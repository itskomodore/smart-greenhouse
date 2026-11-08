import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { createLogger, type Logger } from '../log.js';
import {
  SETTINGS_DEFAULTS,
  type Alarm,
  type BusEvents,
  type Command,
  type PumpState,
  type Reading,
  type Settings,
  type SseEvent,
} from '../types.js';
import { requireBearer } from './auth.js';
import { awaitCommandFinal, isTerminal } from './await-command.js';
import { LruMap, TokenBucket } from './rate-limit.js';
import { downsample } from './downsample.js';
import { errorBody } from './errors.js';
import { errorMessage, isDeadlineError, tryWithin } from './deadline.js';
import type { ApiBus, ApiController, ApiRepo, ManualRequest } from './deps.js';
import { createSseHub, type SseHub } from './sse.js';
import {
  CALIBRATION_MAX_AGE_MS,
  CalibrateParamSchema,
  EVENTS_DEFAULT_LIMIT,
  EventsQuerySchema,
  MAX_TRACKED_NODES,
  PumpBodySchema,
  PumpQuerySchema,
  READINGS_DEFAULT_LIMIT,
  READINGS_DEFAULT_WINDOW_MS,
  READINGS_MAX_LIMIT,
  ReadingsQuerySchema,
  SettingsPatchSchema,
  clampDurationS,
  settingsInvariantIssues,
  zodIssues,
  type Issue,
} from './validation.js';

export interface ApiOptions {
  repo: ApiRepo;
  controller: ApiController;
  bus: ApiBus;
  /** API_TOKEN. Empty string disables write endpoints (503). */
  apiToken: string;
  /** Dashboard build directory (DASHBOARD_DIR). A missing directory is allowed. */
  dashboardDir: string;
  log?: Logger;
  /** Epoch-ms clock; injectable for tests. */
  now?: () => number;
  /** Epoch ms of process start (uptime_s). Defaults to construction time. */
  startedAt?: number;
  /** SSE heartbeat period. Default 15 s. */
  heartbeatMs?: number;
  /** Max concurrent SSE clients. Default 20. */
  maxStreamClients?: number;
  /** Bound on the controller call inside POST /api/pump. Default 1200 ms (settings read adds <= 300 ms; contract: 2 s). */
  pumpDeadlineMs?: number;
  /** Bound on the settings read inside POST /api/pump. Default 300 ms. */
  pumpSettingsMs?: number;
  /** Bound on other DB reads on the HTTP path. Default 1500 ms. */
  dbReadMs?: number;
}

export interface Api {
  readonly app: FastifyInstance;
  streamClients(): number;
  /** Stops accepting HTTP, ends SSE streams, releases bus subscriptions. Idempotent. */
  close(): Promise<void>;
}

/** Last-known values answered when a DB read is slow or fails. */
interface Tracker {
  pumpState: PumpState;
  pumpSince: string | null;
  lastCommand: Command | null;
  lastReading: Reading | null;
  nodeSeen: LruMap<string>;
  alarms: Alarm[];
  settings: Settings | null;
}

const SSE_HEARTBEAT_MS = 15_000;
const SSE_MAX_CLIENTS = 20;

export async function createApi(opts: ApiOptions): Promise<Api> {
  const log = opts.log ?? createLogger('api');
  const now = opts.now ?? Date.now;
  const startedAt = opts.startedAt ?? now();
  const repo = opts.repo;
  const controller = opts.controller;
  const bus = opts.bus;
  const pumpDeadlineMs = opts.pumpDeadlineMs ?? 1200;
  const pumpSettingsMs = opts.pumpSettingsMs ?? 300;
  const dbReadMs = opts.dbReadMs ?? 1500;
  const maxStreamClients = opts.maxStreamClients ?? SSE_MAX_CLIENTS;
  const requireAuth = requireBearer(opts.apiToken);
  /** Start requests: 5 burst, one token back every 2 s (5 per 10 s). `off` is never limited. */
  const startLimiter = new TokenBucket(5, 2000, now);
  if (opts.apiToken.length === 0) {
    log.warn('API_TOKEN is empty; write endpoints will answer 503');
  }

  const tracker: Tracker = {
    pumpState: 'unknown',
    pumpSince: null,
    lastCommand: null,
    lastReading: null,
    nodeSeen: new LruMap<string>(MAX_TRACKED_NODES),
    alarms: [],
    settings: null,
  };

  // ───── bus-fed state ─────

  const onReading = (r: BusEvents['reading']): void => {
    if (tracker.lastReading === null || Date.parse(r.ts) >= Date.parse(tracker.lastReading.ts)) {
      tracker.lastReading = r;
    }
    const prev = tracker.nodeSeen.get(r.node_id);
    if (prev === undefined || Date.parse(r.ts) > Date.parse(prev)) tracker.nodeSeen.set(r.node_id, r.ts);
  };
  const onPump = (p: BusEvents['pump']): void => {
    observePump(p.state);
    if (p.command) tracker.lastCommand = { ...p.command };
  };
  const onSettings = (s: BusEvents['settings']): void => {
    tracker.settings = s;
  };
  const onAlarms = (a: BusEvents['alarms']): void => {
    tracker.alarms = a;
  };
  bus.on('reading', onReading);
  bus.on('pump', onPump);
  bus.on('settings', onSettings);
  bus.on('alarms', onAlarms);
  let unsubscribed = false;

  function observePump(state: PumpState): void {
    if (state !== tracker.pumpState) {
      tracker.pumpState = state;
      tracker.pumpSince = new Date(now()).toISOString();
    }
  }

  function pumpPayload(): { state: PumpState; command?: Command } {
    observePump(controller.pumpState);
    const command = controller.pendingManual ?? tracker.lastCommand;
    return command ? { state: tracker.pumpState, command } : { state: tracker.pumpState };
  }

  async function currentAlarms(): Promise<Alarm[]> {
    const r = await tryWithin(repo.activeAlarms(), dbReadMs);
    if (r.ok) {
      tracker.alarms = r.value;
      return r.value;
    }
    log.warn({ err: errorMessage(r.error) }, 'alarm read failed; serving last known set');
    return tracker.alarms;
  }

  /** Settings for read paths: DB value when fast enough, otherwise the last known value. */
  async function settingsOrLastKnown(timeoutMs: number): Promise<Settings> {
    const r = await tryWithin(repo.getSettings(), timeoutMs);
    if (r.ok) {
      tracker.settings = r.value;
      return r.value;
    }
    return tracker.settings ?? SETTINGS_DEFAULTS;
  }

  function ageSeconds(ts: string): number {
    return Math.max(0, Math.floor((now() - Date.parse(ts)) / 1000));
  }

  function dailyRuntimeSeconds(): number {
    const run = controller.activeRun;
    const running =
      controller.pumpState === 'on' && run && run.ackedAt !== null
        ? Math.max(0, Math.floor((now() - run.ackedAt) / 1000))
        : 0;
    return controller.dailyRuntimeSeconds + running;
  }

  // ───── SSE ─────

  const sse: SseHub = createSseHub({
    bus,
    snapshot: async (): Promise<SseEvent[]> => {
      const alarms = await currentAlarms();
      return [
        { type: 'pump', data: pumpPayload() },
        { type: 'alarms', data: alarms },
      ];
    },
    maxClients: maxStreamClients,
    heartbeatMs: opts.heartbeatMs ?? SSE_HEARTBEAT_MS,
    log: log.child({ part: 'stream' }),
  });

  // ───── app ─────

  const app: FastifyInstance = Fastify({
    loggerInstance: log as FastifyBaseLogger,
    bodyLimit: 4096,
  });

  app.setErrorHandler((err, req, reply) => {
    const e = err as { statusCode?: number; message?: string };
    const status = typeof e.statusCode === 'number' && e.statusCode >= 400 ? e.statusCode : 500;
    if (status >= 500) {
      log.error({ err: errorMessage(err), url: req.url }, 'request failed');
      return reply.code(500).send(errorBody('internal_error', 'internal error'));
    }
    const code =
      status === 413
        ? 'payload_too_large'
        : status === 415
          ? 'unsupported_media_type'
          : status === 404
            ? 'not_found'
            : 'bad_request';
    return reply.code(status).send(errorBody(code, e.message ?? 'bad request'));
  });

  // Dashboard: static assets, then SPA fallback to index.html for client-side routes.
  const dashboardDir = resolve(opts.dashboardDir);
  const indexPath = join(dashboardDir, 'index.html');
  if (existsSync(dashboardDir)) {
    await app.register(fastifyStatic, {
      root: dashboardDir,
      prefix: '/',
      index: ['index.html'],
      cacheControl: false, // Cache-Control is set per file below
      setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', cacheControlFor(filePath));
      },
    });
  } else {
    log.warn({ dashboardDir }, 'dashboard directory missing; serving API only');
  }

  app.setNotFoundHandler(async (req, reply) => {
    const path = req.url.split('?')[0] ?? '/';
    const isClientRoute = req.method === 'GET' && !path.startsWith('/api/') && extname(path) === '';
    if (isClientRoute && existsSync(indexPath)) {
      const html = await readFile(indexPath);
      return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(html);
    }
    return reply.code(404).send(errorBody('not_found', 'no such route'));
  });

  // ───── health (no auth) ─────

  app.get('/healthz', async () => ({ ok: true }));

  // ───── read endpoints ─────

  app.get('/api/latest', async () => {
    const [db, dbNodes] = await Promise.all([
      tryWithin(repo.latestReading(), dbReadMs),
      tryWithin(repo.nodeLastSeen(), dbReadMs),
    ]);
    const reading = newestReading(db.ok ? db.value : null, tracker.lastReading);
    const nodes = mergeLastSeen(dbNodes.ok ? dbNodes.value : {}, tracker.nodeSeen.entries());
    return { reading, age_s: reading ? ageSeconds(reading.ts) : null, nodes };
  });

  app.get('/api/readings', async (req, reply) => {
    const q = ReadingsQuerySchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send(validationError(zodIssues(q.error)));
    const limit = q.data.limit ?? READINGS_DEFAULT_LIMIT;
    const toMs = q.data.to !== undefined ? Date.parse(q.data.to) : now();
    const fromMs = q.data.from !== undefined ? Date.parse(q.data.from) : toMs - READINGS_DEFAULT_WINDOW_MS;
    if (fromMs > toMs) {
      return reply.code(400).send(validationError([{ path: 'from', message: 'from must be <= to' }]));
    }
    try {
      const rows = await repo.readings({
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
        limit: READINGS_MAX_LIMIT,
        ...(q.data.node_id !== undefined ? { node_id: q.data.node_id } : {}),
      });
      return { readings: downsample(rows, limit) };
    } catch (err) {
      log.error({ err: errorMessage(err) }, 'readings query failed');
      return reply.code(503).send(dbUnavailable('readings'));
    }
  });

  app.get('/api/events', async (req, reply) => {
    const q = EventsQuerySchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send(validationError(zodIssues(q.error)));
    try {
      const events = await repo.recentEvents(q.data.limit ?? EVENTS_DEFAULT_LIMIT);
      return { events };
    } catch (err) {
      log.error({ err: errorMessage(err) }, 'events query failed');
      return reply.code(503).send(dbUnavailable('events'));
    }
  });

  app.get('/api/status', async () => {
    const [settings, alarms, dbNodes] = await Promise.all([
      settingsOrLastKnown(dbReadMs),
      currentAlarms(),
      tryWithin(repo.nodeLastSeen(), dbReadMs),
    ]);
    const seen = mergeLastSeen(dbNodes.ok ? dbNodes.value : {}, tracker.nodeSeen.entries());
    const nodes: Record<string, { last_seen: string; age_s: number; stale: boolean }> = {};
    for (const [id, ts] of Object.entries(seen)) {
      const age_s = ageSeconds(ts);
      nodes[id] = { last_seen: ts, age_s, stale: age_s > settings.stale_timeout_s };
    }
    const pump = pumpPayload();
    return {
      now: new Date(now()).toISOString(),
      uptime_s: Math.floor((now() - startedAt) / 1000),
      pump: {
        state: pump.state,
        since: tracker.pumpSince,
        command: pump.command ?? null,
      },
      nodes,
      alarms,
      db: repo.dbUp(),
      auto_enabled: settings.auto_enabled,
      daily_runtime_s: dailyRuntimeSeconds(),
    };
  });

  app.get('/api/settings', async (_req, reply) => {
    const r = await tryWithin(repo.getSettings(), dbReadMs);
    if (!r.ok) {
      log.error({ err: errorMessage(r.error) }, 'settings read failed');
      return reply.code(503).send(dbUnavailable('settings'));
    }
    tracker.settings = r.value;
    return r.value;
  });

  // ───── SSE ─────

  app.get('/api/stream', async (_req, reply) => {
    if (!sse.hasCapacity()) {
      return reply
        .code(503)
        .send(errorBody('too_many_clients', `at most ${maxStreamClients} stream clients`));
    }
    reply.hijack();
    sse.attach(reply.raw);
    return undefined;
  });

  // ───── write endpoints (bearer token) ─────

  app.post('/api/pump', { onRequest: [requireAuth] }, async (req, reply) => {
    const parsed = PumpBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(validationError(zodIssues(parsed.error)));
    const body = parsed.data;
    const query = PumpQuerySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send(validationError(zodIssues(query.error)));
    const waitMs = query.data.wait_ms === undefined ? 0 : Number(query.data.wait_ms);

    if (body.cmd === 'on') {
      // Refuse new starts up front while the DB is down (off stays allowed, never limited).
      if (!repo.dbUp()) {
        return reply
          .code(503)
          .send(errorBody('db_unavailable', 'database unavailable; new starts are refused'));
      }
      const token = startLimiter.take();
      if (!token.ok) {
        return reply
          .code(429)
          .header('Retry-After', String(token.retryAfterS))
          .send(errorBody('rate_limited', 'too many start requests; retry later'));
      }
    }

    let request: ManualRequest;
    if (body.cmd === 'off') {
      request = body.id === undefined ? { cmd: 'off' } : { cmd: 'off', id: body.id };
    } else {
      const s = await settingsOrLastKnown(pumpSettingsMs);
      const duration_s = clampDurationS(body.duration_s, s.max_run_s);
      request = body.id === undefined ? { cmd: 'on', duration_s } : { cmd: 'on', duration_s, id: body.id };
    }

    const attempt = await tryWithin(controller.requestManual(request), pumpDeadlineMs);
    if (!attempt.ok) {
      if (isDeadlineError(attempt.error)) {
        log.warn({ cmd: request.cmd }, 'pump request exceeded its deadline');
        return reply
          .code(503)
          .send(errorBody('controller_busy', 'pump request is still being processed; retry with the same id'));
      }
      log.error({ err: errorMessage(attempt.error) }, 'pump request failed in controller');
      return reply.code(503).send(errorBody('controller_unavailable', 'controller is not accepting pump requests'));
    }

    const res = attempt.value;
    if (!res.ok) {
      const status = res.code === 'invalid_duration' ? 400 : 409;
      return reply.code(status).send(errorBody(res.code, res.message));
    }
    log.info({ cmd: request.cmd, command_id: res.command.id, duplicate: res.duplicate }, 'pump command accepted');

    // Optional wait: observe only. The controller, retries and safety limits are not affected, and a
    // client disconnect (reply.raw close) just ends this observation.
    let command = res.command;
    if (waitMs > 0 && !isTerminal(command)) {
      const ac = new AbortController();
      const onClose = (): void => ac.abort();
      reply.raw.once('close', onClose);
      try {
        command = await awaitCommandFinal({ bus, repo }, command, waitMs, ac.signal);
      } finally {
        reply.raw.off('close', onClose);
      }
    }
    if (waitMs > 0 && isTerminal(command)) {
      return reply.code(200).send({ command, duplicate: res.duplicate, pump: controller.pumpState });
    }
    return reply.code(202).send({ command, duplicate: res.duplicate });
  });

  app.put('/api/settings', { onRequest: [requireAuth] }, async (req, reply) => {
    const parsed = SettingsPatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send(validationError(zodIssues(parsed.error)));
    const patch = parsed.data;

    const current = await tryWithin(repo.getSettings(), dbReadMs);
    if (!current.ok) return reply.code(503).send(dbUnavailable('settings'));
    const issues = settingsInvariantIssues({ ...current.value, ...patch });
    if (issues.length > 0) return reply.code(400).send(validationError(issues));

    try {
      const saved = await repo.putSettings(patch);
      tracker.settings = saved;
      bus.emit('settings', saved);
      log.info({ keys: Object.keys(patch) }, 'settings updated');
      return reply.code(200).send(saved);
    } catch (err) {
      log.error({ err: errorMessage(err) }, 'settings write failed');
      return reply.code(503).send(dbUnavailable('settings'));
    }
  });

  app.post<{ Params: { which: string } }>(
    '/api/calibrate/:which',
    { onRequest: [requireAuth] },
    async (req, reply) => {
      const which = CalibrateParamSchema.safeParse(req.params.which);
      if (!which.success) {
        return reply.code(400).send(validationError([{ path: 'which', message: 'must be "dry" or "wet"' }]));
      }

      const dbLatest = await tryWithin(repo.latestReading(), dbReadMs);
      const latest = newestReading(dbLatest.ok ? dbLatest.value : null, tracker.lastReading);
      if (latest === null) {
        return reply.code(409).send(errorBody('no_recent_reading', 'no sensor reading available to calibrate from'));
      }
      const ageMs = now() - Date.parse(latest.ts);
      if (ageMs < 0 || ageMs >= CALIBRATION_MAX_AGE_MS) {
        return reply
          .code(409)
          .send(errorBody('no_recent_reading', `latest reading is ${Math.round(ageMs / 1000)} s old; calibration needs < 60 s`));
      }

      const current = await tryWithin(repo.getSettings(), dbReadMs);
      if (!current.ok) return reply.code(503).send(dbUnavailable('settings'));
      const patch: Partial<Settings> =
        which.data === 'dry' ? { soil_dry_raw: latest.soil_raw } : { soil_wet_raw: latest.soil_raw };
      const merged = { ...current.value, ...patch };
      if (merged.soil_dry_raw === merged.soil_wet_raw) {
        return reply
          .code(409)
          .send(errorBody('dry_equals_wet', 'captured value would make soil_dry_raw equal soil_wet_raw'));
      }

      try {
        const saved = await repo.putSettings(patch);
        tracker.settings = saved;
        bus.emit('settings', saved);
        log.info({ which: which.data, captured_raw: latest.soil_raw }, 'soil calibration captured');
        return reply.code(200).send({
          soil_dry_raw: saved.soil_dry_raw,
          soil_wet_raw: saved.soil_wet_raw,
          captured_raw: latest.soil_raw,
        });
      } catch (err) {
        log.error({ err: errorMessage(err) }, 'calibration write failed');
        return reply.code(503).send(dbUnavailable('settings'));
      }
    },
  );

  let closed = false;
  return {
    app,
    streamClients: () => sse.size(),
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      sse.close();
      if (!unsubscribed) {
        unsubscribed = true;
        bus.off('reading', onReading);
        bus.off('pump', onPump);
        bus.off('settings', onSettings);
        bus.off('alarms', onAlarms);
      }
      await app.close();
    },
  };
}

// ───── helpers ─────

/** Validation 400 body per docs/API.md: `fields` maps each offending setting/param to its message. */
function validationError(issues: Issue[]) {
  const fields: Record<string, string> = {};
  for (const i of issues) {
    if (!(i.path in fields)) fields[i.path] = i.message;
  }
  const message = issues.map((i) => (i.path === '(root)' ? i.message : `${i.path}: ${i.message}`)).join('; ');
  return errorBody('validation_error', message || 'invalid request', { fields });
}

function dbUnavailable(what: string) {
  return errorBody('db_unavailable', `${what} unavailable: database not reachable`);
}

function newestReading(a: Reading | null, b: Reading | null): Reading | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(b.ts) > Date.parse(a.ts) ? b : a;
}

function mergeLastSeen(db: Record<string, string>, mem: Iterable<[string, string]>): Record<string, string> {
  const out: Record<string, string> = { ...db };
  for (const [id, ts] of mem) {
    const prev = out[id];
    if (prev === undefined || Date.parse(ts) > Date.parse(prev)) out[id] = ts;
  }
  return out;
}

/** Hashed assets are immutable; index.html and everything else revalidates. */
export function cacheControlFor(filePath: string): string {
  const p = filePath.replace(/\\/g, '/');
  if (p.endsWith('.html')) return 'no-cache';
  if (p.includes('/assets/')) return 'public, max-age=31536000, immutable';
  return 'no-cache';
}

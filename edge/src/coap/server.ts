import { createServer } from 'coap';
import type { IncomingMessage, OutgoingMessage, Server } from 'coap';
import type { Logger } from 'pino';
import type { BusEvents, Reading, Repo, Settings } from '../types.js';
import { normalize, CalibrationError } from './normalize.js';
import { validatePayload } from './validate.js';
import { closeCoap, listenCoap, normalizeSourceAddress, udpTypeFor } from './transport.js';

/** Minimal bus surface: any object with a typed `emit` (src/bus.ts satisfies this). */
export interface BusPort {
  emit<K extends keyof BusEvents>(topic: K, data: BusEvents[K]): unknown;
}

export interface CoapIngestDeps {
  repo: Pick<Repo, 'insertReading' | 'ping'>;
  getSettings: () => Promise<Settings>;
  bus: BusPort;
  log: Logger;
  /** Injectable clock for tests. Defaults to `new Date()`. */
  now?: () => Date;
}

export interface CoapIngestServer {
  /** Bind UDP `host:port` (IPv6 literal → udp6). Rejects if the bind fails. */
  listen(port: number, host: string): Promise<void>;
  /** Stop listening. Safe to call when not listening. */
  close(): Promise<void>;
}

const HEALTH_DB_TIMEOUT_MS = 1000;
const CONTENT_JSON = 'application/json';
const CONTENT_TEXT = 'text/plain';

/**
 * CoAP sensor ingest (docs/API.md "CoAP (sensor ingest)").
 *   POST|PUT /sensor  → 2.01 Created / 2.04 Changed, or 4.00 on invalid payload
 *   GET /health       → 2.05 {"ok":true,"db":bool,"uptime_s":n}
 * Handlers never throw: every path ends in a reply, errors are logged.
 */
export function createCoapIngestServer(deps: CoapIngestDeps): CoapIngestServer {
  const { repo, getSettings, bus, log } = deps;
  const now = deps.now ?? (() => new Date());
  const startedAt = Date.now();
  let server: Server | null = null;

  async function handleSensor(req: IncomingMessage, res: OutgoingMessage): Promise<void> {
    const method = String(req.method);
    if (method !== 'POST' && method !== 'PUT') {
      return reply(res, '4.05', CONTENT_TEXT, 'method not allowed');
    }

    const cf = req.headers['Content-Format'];
    if (cf !== undefined && cf !== null && !isJsonFormat(cf)) {
      return reply(res, '4.15', CONTENT_TEXT, 'unsupported content format');
    }

    const source = normalizeSourceAddress(req.rsinfo.address);
    const v = validatePayload(req.payload);
    if (!v.ok) {
      log.warn({ source, reason: v.error }, 'coap: rejected sensor payload');
      return reply(res, '4.00', CONTENT_TEXT, v.error);
    }

    let reading: Omit<Reading, 'id'>;
    try {
      reading = normalize(v.value, await getSettings(), { source, now: now() });
    } catch (err) {
      if (err instanceof CalibrationError) {
        log.error({ err: err.message }, 'coap: calibration invalid, reading dropped');
        return reply(res, '5.00', CONTENT_TEXT, 'calibration invalid');
      }
      throw err;
    }

    try {
      await repo.insertReading(reading);
    } catch (err) {
      log.error({ err: errMessage(err), node_id: reading.node_id }, 'coap: store failed');
      return reply(res, '5.00', CONTENT_TEXT, 'storage unavailable');
    }

    try {
      bus.emit('reading', reading);
    } catch (err) {
      // A faulty subscriber must not turn a stored reading into an error reply.
      log.error({ err: errMessage(err) }, 'coap: bus listener threw');
    }

    log.debug({ node_id: reading.node_id, method }, 'coap: reading stored');
    return reply(res, method === 'PUT' ? '2.04' : '2.01', null, null);
  }

  async function handleHealth(req: IncomingMessage, res: OutgoingMessage): Promise<void> {
    if (String(req.method) !== 'GET') {
      return reply(res, '4.05', CONTENT_TEXT, 'method not allowed');
    }
    const db = await pingWithTimeout(repo, HEALTH_DB_TIMEOUT_MS);
    const body = JSON.stringify({
      ok: true,
      db,
      uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    });
    return reply(res, '2.05', CONTENT_JSON, body);
  }

  async function dispatch(req: IncomingMessage, res: OutgoingMessage): Promise<void> {
    if (req.url === '/sensor') return handleSensor(req, res);
    if (req.url === '/health') return handleHealth(req, res);
    return reply(res, '4.04', CONTENT_TEXT, 'not found');
  }

  function onRequest(req: IncomingMessage, res: OutgoingMessage): void {
    // Without this listener an error emitted by the response stream would crash the process.
    res.on('error', (err: Error) => {
      log.warn({ err: err.message }, 'coap: response stream error');
    });
    dispatch(req, res).catch((err: unknown) => {
      log.error({ err: errMessage(err) }, 'coap: handler failed');
      reply(res, '5.00', CONTENT_TEXT, 'internal error');
    });
  }

  return {
    async listen(port, host) {
      if (server) throw new Error('coap ingest server already listening');
      // reuseAddr: false so a second instance fails to bind instead of silently sharing the port.
      const s = createServer({ type: udpTypeFor(host), reuseAddr: false });
      s.on('request', (req: IncomingMessage, res: OutgoingMessage) => {
        try {
          onRequest(req, res);
        } catch (err) {
          log.error({ err: errMessage(err) }, 'coap: request dispatch failed');
        }
      });
      s.on('error', (err: Error) => {
        log.error({ err: err.message }, 'coap: socket error');
      });
      await listenCoap(s, port, host);
      server = s;
      log.info({ host, port }, 'coap ingest listening');
    },

    async close() {
      if (!server) return;
      const s = server;
      server = null;
      await closeCoap(s);
      log.info('coap ingest stopped');
    },
  };
}

/** Write a reply. Never throws (the response may already be closed). */
function reply(res: OutgoingMessage, code: string, contentFormat: string | null, body: string | null): void {
  try {
    res.code = code;
    if (contentFormat) res.setOption('Content-Format', contentFormat);
    res.end(body ?? undefined);
  } catch {
    // Response already finished or torn down; nothing else can be sent.
  }
}

function isJsonFormat(cf: unknown): boolean {
  if (typeof cf === 'string') return cf.split(';')[0]?.trim().toLowerCase() === CONTENT_JSON;
  if (typeof cf === 'number') return cf === 50;
  return false;
}

async function pingWithTimeout(repo: Pick<Repo, 'ping'>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([repo.ping().catch(() => false), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Mock pump actuator speaking the assumed CoAP API in docs/API.md:
 *   PUT /pump {"cmd":"on","max_s":n,"id":"<uuid>","exp":"<ISO>"} → 2.04 {"id","pump":"on","remaining_s"}
 *   PUT /pump {"cmd":"off","id":"<uuid>","exp":"<ISO>"}          → 2.04 {"id","pump":"off"}
 *   GET /pump                                                   → 2.05 {"id","pump","remaining_s"}
 * Rules: same id → previous result, no re-run; exp in the past → 4.08, no action;
 * max_s is a hard local timer; state at boot is off.
 *
 * Adverse-testing env knobs (standalone run only):
 *   MOCK_COAP_HOST   bind host           (default 127.0.0.1)
 *   MOCK_COAP_PORT   bind port           (default ACTUATOR_PORT or 5684)
 *   MOCK_DROP_RATE   0..1, request silently dropped before processing (default 0)
 *   MOCK_NEVER_ACK   1/true: PUT is applied but never answered (tests retry + idempotency)
 *   MOCK_DELAY_MS    delay before every reply (default 0)
 *   LOG_LEVEL        pino level (default info)
 *
 * Run: `pnpm mock-actuator`
 */
import { createServer } from 'coap';
import type { IncomingMessage, OutgoingMessage, Server } from 'coap';
import pino from 'pino';
import type { Logger } from 'pino';
import { closeCoap, isEntryPoint, listenCoap, udpTypeFor } from './transport.js';

export interface MockActuatorOptions {
  host?: string;
  port?: number;
  dropRate?: number;
  neverAck?: boolean;
  delayMs?: number;
  log?: Logger;
  /** Injectable random source (0..1) for drop decisions. */
  random?: () => number;
  /** Injectable clock (epoch ms) for tests. */
  now?: () => number;
}

export interface MockPumpState {
  pump: 'on' | 'off';
  id: string | null;
  remaining_s: number;
}

interface CachedReply {
  code: string;
  body: string;
}

const CACHE_LIMIT = 1000;
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export interface MockActuator {
  listen(): Promise<void>;
  close(): Promise<void>;
  state(): MockPumpState;
}

export function createMockActuator(opts: MockActuatorOptions = {}): MockActuator {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 5684;
  const dropRate = clampRate(opts.dropRate ?? 0);
  const neverAck = opts.neverAck ?? false;
  const delayMs = Math.max(0, opts.delayMs ?? 0);
  const log = opts.log ?? pino({ level: 'silent' });
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;

  let pump: 'on' | 'off' = 'off'; // unknown state at boot = off
  let lastId: string | null = null;
  let deadline: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  let server: Server | null = null;

  /** Idempotency cache: id → the reply produced the first time it was seen. */
  const applied = new Map<string, CachedReply>();

  function remainingS(): number {
    if (pump === 'off' || deadline === null) return 0;
    return Math.max(0, Math.ceil((deadline - now()) / 1000));
  }

  function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function autoOff(): void {
    timer = null;
    deadline = null;
    pump = 'off';
    log.info({ id: lastId }, 'mock actuator: max_s timer elapsed, pump off');
  }

  function remember(id: string, r: CachedReply): void {
    applied.set(id, r);
    if (applied.size > CACHE_LIMIT) {
      const oldest = applied.keys().next().value;
      if (oldest !== undefined) applied.delete(oldest);
    }
  }

  function json(obj: unknown): string {
    return JSON.stringify(obj);
  }

  /** Apply a PUT /pump command. Returns the reply to send. */
  function handlePut(payload: Buffer): CachedReply {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString('utf8'));
    } catch {
      return { code: '4.00', body: 'malformed JSON' };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { code: '4.00', body: 'payload must be a JSON object' };
    }
    const o = parsed as Record<string, unknown>;
    const id = o['id'];
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      return { code: '4.00', body: 'id required' };
    }

    // Idempotency: same id seen before → previous result, no re-run.
    const prev = applied.get(id);
    if (prev) {
      log.info({ id }, 'mock actuator: duplicate id, replaying previous result');
      return prev;
    }

    const exp = o['exp'];
    if (exp !== undefined) {
      const expMs = typeof exp === 'string' ? Date.parse(exp) : NaN;
      if (Number.isNaN(expMs)) return { code: '4.00', body: 'exp must be ISO-8601' };
      if (expMs < now()) {
        log.warn({ id, exp }, 'mock actuator: command expired, rejected');
        return { code: '4.08', body: 'command expired' };
      }
    }

    if (o['cmd'] === 'on') {
      const maxS = o['max_s'];
      if (typeof maxS !== 'number' || !Number.isInteger(maxS) || maxS < 1 || maxS > 600) {
        return { code: '4.00', body: 'max_s must be an integer 1..600' };
      }
      clearTimer();
      pump = 'on';
      lastId = id;
      deadline = now() + maxS * 1000;
      timer = setTimeout(autoOff, maxS * 1000);
      log.info({ id, max_s: maxS }, 'mock actuator: pump on');
      const reply = { code: '2.04', body: json({ id, pump: 'on', remaining_s: remainingS() }) };
      remember(id, reply);
      return reply;
    }

    if (o['cmd'] === 'off') {
      clearTimer();
      pump = 'off';
      deadline = null;
      lastId = id;
      log.info({ id }, 'mock actuator: pump off');
      const reply = { code: '2.04', body: json({ id, pump: 'off' }) };
      remember(id, reply);
      return reply;
    }

    return { code: '4.00', body: 'cmd must be on|off' };
  }

  function stateReply(): CachedReply {
    return {
      code: '2.05',
      body: json({ id: lastId, pump, remaining_s: remainingS() }),
    };
  }

  /** Send a reply, honouring the delay knob. */
  function send(res: OutgoingMessage, r: CachedReply): void {
    const go = (): void => {
      try {
        res.code = r.code;
        res.setOption('Content-Format', 'application/json');
        res.end(r.body);
      } catch (err) {
        log.warn({ err: errMessage(err) }, 'mock actuator: reply failed');
      }
    };
    if (delayMs > 0) setTimeout(go, delayMs);
    else go();
  }

  function onRequest(req: IncomingMessage, res: OutgoingMessage): void {
    res.on('error', (err: Error) => log.warn({ err: err.message }, 'mock actuator: response error'));

    if (dropRate > 0 && random() < dropRate) {
      log.info({ method: String(req.method), url: req.url }, 'mock actuator: dropped request (MOCK_DROP_RATE)');
      return;
    }
    if (req.url !== '/pump') {
      send(res, { code: '4.04', body: 'not found' });
      return;
    }

    const method = String(req.method);
    if (method === 'GET') {
      send(res, stateReply());
      return;
    }
    if (method === 'PUT') {
      const r = handlePut(req.payload);
      if (neverAck) {
        log.info('mock actuator: MOCK_NEVER_ACK set, reply withheld');
        return;
      }
      send(res, r);
      return;
    }
    send(res, { code: '4.05', body: 'method not allowed' });
  }

  return {
    async listen() {
      if (server) throw new Error('mock actuator already listening');
      const s = createServer({ type: udpTypeFor(host), reuseAddr: false });
      s.on('request', (req: IncomingMessage, res: OutgoingMessage) => {
        try {
          onRequest(req, res);
        } catch (err) {
          log.error({ err: errMessage(err) }, 'mock actuator: handler failed');
        }
      });
      s.on('error', (err: Error) => log.error({ err: err.message }, 'mock actuator: socket error'));
      await listenCoap(s, port, host);
      server = s;
      log.info({ host, port, dropRate, neverAck, delayMs }, 'mock actuator listening');
    },

    async close() {
      clearTimer();
      if (!server) return;
      const s = server;
      server = null;
      await closeCoap(s);
    },

    state() {
      return { pump, id: lastId, remaining_s: remainingS() };
    },
  };
}

function clampRate(r: number): number {
  if (!Number.isFinite(r)) return 0;
  return Math.min(1, Math.max(0, r));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Parse env knobs. Invalid values throw so the operator sees them immediately. */
export function optionsFromEnv(env: NodeJS.ProcessEnv, log: Logger): Required<Pick<MockActuatorOptions, 'host' | 'port' | 'dropRate' | 'neverAck' | 'delayMs'>> & { log: Logger } {
  const port = Number(env['MOCK_COAP_PORT'] ?? env['ACTUATOR_PORT'] ?? 5684);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MOCK_COAP_PORT must be 1..65535');

  const dropRate = Number(env['MOCK_DROP_RATE'] ?? 0);
  if (!Number.isFinite(dropRate) || dropRate < 0 || dropRate > 1) throw new Error('MOCK_DROP_RATE must be 0..1');

  const delayMs = Number(env['MOCK_DELAY_MS'] ?? 0);
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('MOCK_DELAY_MS must be >= 0');

  const neverRaw = (env['MOCK_NEVER_ACK'] ?? '').toLowerCase();
  const neverAck = neverRaw === '1' || neverRaw === 'true';

  return {
    host: env['MOCK_COAP_HOST'] ?? '127.0.0.1',
    port,
    dropRate,
    neverAck,
    delayMs,
    log,
  };
}

async function main(): Promise<void> {
  const log = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });
  let opts: ReturnType<typeof optionsFromEnv>;
  try {
    opts = optionsFromEnv(process.env, log);
  } catch (err) {
    log.error({ err: errMessage(err) }, 'mock actuator: bad configuration');
    process.exitCode = 1;
    return;
  }
  const actuator = createMockActuator(opts);
  await actuator.listen();

  const shutdown = (signal: string): void => {
    log.info({ signal }, 'mock actuator: shutting down');
    actuator.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err: unknown) => {
    // Last-resort guard: report and exit non-zero rather than crash with a stack dump.
    process.stderr.write(`${JSON.stringify({ level: 'fatal', msg: 'mock actuator failed', err: errMessage(err) })}\n`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env tsx
/**
 * Greenhouse sensor simulator. Sends CoAP POST /sensor messages to the edge.
 * Run: pnpm -C sim sim -- --help   (or: npx tsx sim/sensor-sim.ts --help)
 */
import { Agent, request as coapRequest } from 'coap';
import pino from 'pino';
import { pathToFileURL } from 'node:url';
import { SIM_MODES, mulberry32, createState, nextOutgoing, type Outgoing, type SimMode } from './payloads.js';

export interface SimConfig {
  host: string;
  port: number;
  intervalS: number;
  id: string | undefined;
  mode: SimMode;
  /** 0 = run until interrupted. */
  count: number;
  /** Messages per second burst. When set, --interval is ignored. */
  rate: number | undefined;
  seed: number;
}

const FLAGS = ['host', 'port', 'interval', 'id', 'mode', 'count', 'rate', 'seed'] as const;
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SEND_TIMEOUT_MS = 3000;

export class UsageError extends Error {}

export const USAGE = `Usage: tsx sensor-sim.ts [options]

  --host <host>        edge host (default 127.0.0.1)
  --port <port>        edge CoAP UDP port (default 5683)
  --interval <sec>     seconds between messages (default 5, > 0)
  --id <id>            optional node id, ^[A-Za-z0-9_.:-]{1,64}$ (default: none, edge uses source address)
  --mode <mode>        normal | drying | stuck | garbage (default normal)
  --count <n>          messages to send, 0 = forever (default 0)
  --rate <n>           load burst: n messages per second, ignores --interval (1..1000)
  --seed <n>           PRNG seed for reproducible runs (default 1)
  --help               show this help
`;

function parseNumber(key: string, raw: string, opts: { int: boolean; min: number; max: number }): number {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n)) throw new UsageError(`--${key} must be a number, got "${raw}"`);
  if (opts.int && !Number.isInteger(n)) throw new UsageError(`--${key} must be an integer, got "${raw}"`);
  if (n < opts.min || n > opts.max) {
    throw new UsageError(`--${key} must be between ${opts.min} and ${opts.max}, got ${raw}`);
  }
  return n;
}

/** Parses argv. Returns 'help' when --help is given. Throws UsageError on bad input. */
export function parseArgs(argv: readonly string[]): SimConfig | 'help' {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--help' || arg === '-h') return 'help';
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument "${arg}"`);
    const eq = arg.indexOf('=');
    let key: string;
    let value: string;
    if (eq >= 0) {
      key = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else {
      key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`--${key} needs a value`);
      value = next;
      i++;
    }
    if (!(FLAGS as readonly string[]).includes(key)) throw new UsageError(`unknown flag --${key}`);
    values.set(key, value);
  }

  const mode = values.get('mode') ?? 'normal';
  if (!(SIM_MODES as readonly string[]).includes(mode)) {
    throw new UsageError(`--mode must be one of ${SIM_MODES.join('|')}, got "${mode}"`);
  }
  const id = values.get('id');
  if (id !== undefined && !ID_RE.test(id)) throw new UsageError(`--id does not match ${ID_RE.source}`);
  const host = values.get('host') ?? '127.0.0.1';
  if (host.trim() === '') throw new UsageError('--host must not be empty');

  const rawRate = values.get('rate');
  return {
    host,
    port: parseNumber('port', values.get('port') ?? '5683', { int: true, min: 1, max: 65535 }),
    intervalS: parseNumber('interval', values.get('interval') ?? '5', { int: false, min: 0.05, max: 3600 }),
    id,
    mode: mode as SimMode,
    count: parseNumber('count', values.get('count') ?? '0', { int: true, min: 0, max: Number.MAX_SAFE_INTEGER }),
    rate: rawRate === undefined ? undefined : parseNumber('rate', rawRate, { int: true, min: 1, max: 1000 }),
    seed: parseNumber('seed', values.get('seed') ?? '1', { int: true, min: 0, max: 0xffffffff }),
  };
}

interface SendResult {
  code: string | null;
  payload: string;
  error?: string;
  latencyMs: number;
}

/** Sends one CoAP POST /sensor and resolves with the response code or an error. */
function sendOne(agent: Agent, cfg: SimConfig, out: Outgoing): Promise<SendResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: Omit<SendResult, 'latencyMs'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, latencyMs: Date.now() - started });
    };
    const timer = setTimeout(() => finish({ code: null, payload: '', error: 'timeout' }), SEND_TIMEOUT_MS);
    const req = coapRequest({
      agent,
      host: cfg.host,
      port: cfg.port,
      pathname: '/sensor',
      method: 'POST',
      options: { 'Content-Format': out.contentFormat },
    });
    req.on('error', (err: Error) => finish({ code: null, payload: '', error: err.message }));
    req.on('response', (res) => {
      finish({ code: String(res.code), payload: res.payload.toString('utf8') });
    });
    req.end(Buffer.from(out.body, 'utf8'));
  });
}

function expectationMet(expect: Outgoing['expect'], code: string | null): boolean {
  if (code === null) return false;
  if (expect === 'accept') return code.startsWith('2.');
  return code === expect;
}

async function main(): Promise<number> {
  let parsed: SimConfig | 'help';
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`error: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    throw err;
  }
  if (parsed === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  const cfg = parsed;

  const log = pino({
    level: process.env['LOG_LEVEL'] ?? 'info',
    base: { component: 'sensor-sim', mode: cfg.mode, node: cfg.id ?? null },
  });

  const agent = new Agent({ type: 'udp4' });
  const state = createState();
  const rng = mulberry32(cfg.seed);
  const perTick = cfg.rate ?? 1;
  const tickMs = cfg.rate === undefined ? cfg.intervalS * 1000 : 1000;
  const stats = { sent: 0, accepted: 0, rejected: 0, timeouts: 0, unexpected: 0 };
  let stopping = false;

  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info({ event: 'stop', signal, ...stats }, 'simulator stopped');
    agent.close(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  log.info(
    {
      event: 'start',
      host: cfg.host,
      port: cfg.port,
      interval_s: cfg.rate === undefined ? cfg.intervalS : null,
      rate: cfg.rate ?? null,
      count: cfg.count,
      seed: cfg.seed,
    },
    'simulator started',
  );

  while (!stopping && (cfg.count === 0 || stats.sent < cfg.count)) {
    const n = cfg.count === 0 ? perTick : Math.min(perTick, cfg.count - stats.sent);
    const outs = Array.from({ length: n }, () => nextOutgoing(cfg.mode, state, rng, cfg.id));
    const results = await Promise.all(outs.map((out) => sendOne(agent, cfg, out)));

    outs.forEach((out, i) => {
      const res = results[i];
      if (res === undefined) return;
      stats.sent += 1;
      if (res.error !== undefined) stats.timeouts += res.error === 'timeout' ? 1 : 0;
      if (res.code !== null && res.code.startsWith('2.')) stats.accepted += 1;
      if (res.code !== null && res.code.startsWith('4.')) stats.rejected += 1;
      const ok = expectationMet(out.expect, res.code);
      if (!ok) stats.unexpected += 1;
      log[ok ? 'info' : 'warn'](
        {
          event: ok ? 'sent' : 'unexpected_response',
          seq: stats.sent,
          kind: out.kind,
          expect: out.expect,
          code: res.code,
          response: res.payload || undefined,
          error: res.error,
          latency_ms: res.latencyMs,
          body: out.body.length > 200 ? `${out.body.slice(0, 200)}...` : out.body,
        },
        ok ? 'message delivered' : 'response did not match expectation',
      );
    });

    if (cfg.count !== 0 && stats.sent >= cfg.count) break;
    await new Promise((resolve) => setTimeout(resolve, tickMs));
  }

  log.info({ event: 'done', ...stats }, 'simulator finished');
  await new Promise<void>((resolve) => agent.close(() => resolve()));
  return 0;
}

// Only auto-run when executed as the entry script, not when imported.
const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}

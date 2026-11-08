/**
 * End-to-end test rig for the adverse scenarios.
 *
 * REAL: CoAP ingest server (UDP on 127.0.0.1, ephemeral port), validate + normalize, rules engine
 * (decide / assessReading), Controller (+ CommandManager, AlarmBoard), BufferedRepo (optional), bus.
 * FAKE: time (FakeClock, injected into every component), actuator (FakeActuator, scripted replies),
 * database (MemRepo with throw/hang fault modes).
 *
 * Time only moves through Rig.step / Rig.runFor. Real sleeps are never used (UDP round trips aside).
 */
import dgram from 'node:dgram';
import { request } from 'coap';
import pino from 'pino';
import { createBus, type TypedBus } from '../../src/bus.js';
import { createCoapIngestServer, type CoapIngestServer } from '../../src/coap/server.js';
import { Controller, type ControllerDeps } from '../../src/controller/loop.js';
import { BufferedRepo } from '../../src/db/buffered-repo.js';
import { decide as realDecide } from '../../src/rules/index.js';
import { FakeActuator, FakeClock, MemRepo, settle, T0 } from '../../src/actuator/test-support.js';
import type {
  Alarm,
  Command,
  Decision,
  IrrigationEvent,
  PumpState,
  Reading,
  Repo,
  RulesState,
  Settings,
} from '../../src/types.js';

// Local-day arithmetic (daily budget window) depends on the process time zone.
process.env.TZ = 'UTC';

export const silent = pino({ level: 'silent' });
export const HOST = '127.0.0.1';
export const STEP_MS = 1000;

/** Default calibration (SETTINGS_DEFAULTS): dry 3000, wet 1200. */
const DRY = 3000;
const WET = 1200;

/** Raw ADC value that normalizes to `pct` soil moisture with the default calibration. */
export function soilRawFor(pct: number): number {
  return Math.round(DRY - (pct / 100) * (DRY - WET));
}

/** A valid sensor JSON body with soil at `pct`. Extra keys are merged in (e.g. overrides for negative tests). */
export function sensorBody(pct: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ t: 22.5, rh: 55.2, light: 812, soil: soilRawFor(pct), ...extra });
}

export interface Reply {
  code: string;
  payload: string;
}

/** One CoAP request over real UDP to 127.0.0.1:port. Rejects on timeout. */
export function coapRequest(
  port: number,
  method: 'GET' | 'POST' | 'PUT',
  pathname: string,
  body?: string,
  contentFormat?: string,
  timeoutMs = 3000,
): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply to ${method} ${pathname}`)), timeoutMs);
    const req = request({
      host: HOST,
      port,
      pathname,
      method,
      agent: false,
      options: contentFormat !== undefined ? { 'Content-Format': contentFormat } : undefined,
    });
    req.on('response', (res) => {
      clearTimeout(timer);
      resolve({ code: String(res.code), payload: res.payload.toString('utf8') });
    });
    req.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

/** Ask the OS for a free UDP port (tiny race window; acceptable for tests). */
export function freeUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', reject);
    sock.bind(0, HOST, () => {
      const { port } = sock.address();
      sock.close(() => resolve(port));
    });
  });
}

export interface DecisionRecord {
  at: number;
  decision: Decision;
  state: RulesState;
}

export interface AlarmSnapshot {
  at: number;
  codes: string[];
  alarms: Alarm[];
}

export interface RigOptions {
  settings?: Partial<Settings>;
  clock?: FakeClock;
  /** Reuse an existing store (restart scenarios). */
  mem?: MemRepo;
  /** Reuse an existing actuator (the physical pump outlives the controller process). */
  actuator?: FakeActuator;
  /** Wrap the store in a BufferedRepo (DB-outage tolerant), as production does. */
  buffered?: { maxBuffer: number; probeBackoffMs?: number };
  /** Closed irrigation events that exist before the rig starts. */
  seedEvents?: IrrigationEvent[];
  /** Per-call DB bound for the controller (real ms). Keep small: hangs are simulated with real timers. */
  dbTimeoutMs?: number;
  /** Start the controller and the CoAP listener. Default true. */
  start?: boolean;
  /** Replace the jump filter (controls only; scenarios use the real assessReading). */
  assessReading?: NonNullable<ControllerDeps['assessReading']>;
}

export class Rig {
  readonly pumpHistory: PumpState[] = [];
  readonly pumpSamples: PumpState[] = [];
  readonly alarmHistory: AlarmSnapshot[] = [];
  readonly dbHistory: boolean[] = [];
  readonly readingsSeen: Reading[] = [];
  private stopped = false;

  private constructor(
    readonly clock: FakeClock,
    readonly mem: MemRepo,
    readonly repo: Repo,
    readonly buffered: BufferedRepo | null,
    readonly actuator: FakeActuator,
    readonly bus: TypedBus,
    readonly ctl: Controller,
    readonly coap: CoapIngestServer,
    readonly port: number,
    readonly decisions: DecisionRecord[],
  ) {
    bus.on('pump', (p) => this.pumpHistory.push(p.state));
    bus.on('alarms', (a) => this.alarmHistory.push({ at: clock.now(), codes: a.map((x) => x.code), alarms: a }));
    bus.on('reading', (r) => this.readingsSeen.push(r));
    bus.on('db', (h) => this.dbHistory.push(h.up));
  }

  static async start(opts: RigOptions = {}): Promise<Rig> {
    const clock = opts.clock ?? new FakeClock(T0);
    const mem = opts.mem ?? new MemRepo(opts.settings ?? {});
    for (const e of opts.seedEvents ?? []) mem.events.push({ ...e });
    const actuator = opts.actuator ?? new FakeActuator(clock);
    const bus = createBus();
    const repo: Repo =
      opts.buffered !== undefined
        ? new BufferedRepo(mem, {
            maxBuffer: opts.buffered.maxBuffer,
            probeBackoffMs: opts.buffered.probeBackoffMs,
            bus,
            log: silent,
            now: () => clock.now(),
          })
        : mem;
    const buffered = repo instanceof BufferedRepo ? repo : null;

    // Record each decision made by the REAL engine (the wrapper only observes).
    const decisions: DecisionRecord[] = [];
    const ctl = new Controller({
      repo,
      adapter: actuator,
      bus,
      clock,
      log: silent,
      decide: (s) => {
        const decision = realDecide(s);
        decisions.push({ at: s.now, decision, state: s });
        return decision;
      },
      ...(opts.assessReading !== undefined ? { assessReading: opts.assessReading } : {}),
      tickMs: STEP_MS,
      dbTimeoutMs: opts.dbTimeoutMs ?? 20,
      tickTimeoutMs: 2000,
    });
    const port = await freeUdpPort();
    const coap = createCoapIngestServer({
      repo,
      getSettings: () => repo.getSettings(),
      bus,
      log: silent,
      now: () => new Date(clock.now()),
    });
    const rig = new Rig(clock, mem, repo, buffered, actuator, bus, ctl, coap, port, decisions);
    if (opts.start !== false) {
      await ctl.start();
      await coap.listen(port, HOST);
    }
    openRigs.add(rig);
    return rig;
  }

  /** Let every pending promise continuation run (several event-loop turns). */
  async flush(): Promise<void> {
    for (let i = 0; i < 4; i++) await settle();
  }

  /** Send one CoAP request to the ingest server and let the reading propagate. */
  async post(body: string, contentFormat?: string): Promise<Reply> {
    const r = await coapRequest(this.port, 'POST', '/sensor', body, contentFormat);
    await this.flush();
    return r;
  }

  /** Valid reading with soil at `pct` (POST, JSON content format). */
  async reading(pct: number): Promise<Reply> {
    return this.post(sensorBody(pct), 'application/json');
  }

  /** Advance fake time by `ms` (firing due actuator/backoff timers), then run one controller tick. */
  async step(ms: number = STEP_MS): Promise<void> {
    await this.clock.advance(ms);
    await this.ctl.tick();
    await this.flush();
    this.pumpSamples.push(this.ctl.pumpState);
  }

  /** Run ticks until `ms` of fake time has elapsed. */
  async runFor(ms: number, stepMs: number = STEP_MS): Promise<void> {
    for (let elapsed = 0; elapsed < ms; elapsed += stepMs) await this.step(stepMs);
  }

  /** Tick until `cond` holds or `maxMs` of fake time passes. Returns whether `cond` held. */
  async runUntil(cond: () => boolean, maxMs: number, stepMs: number = STEP_MS): Promise<boolean> {
    for (let elapsed = 0; elapsed <= maxMs; elapsed += stepMs) {
      if (cond()) return true;
      await this.step(stepMs);
    }
    return cond();
  }

  /**
   * Simulate a hard crash: the controller and the listener vanish without a clean shutdown.
   * Its clock is never advanced again, so none of its pending timers can fire.
   */
  async crash(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.ctl.stop();
    await this.coap.close();
  }

  async close(): Promise<void> {
    openRigs.delete(this);
    await this.crash();
  }

  // ───── views ─────

  get lastDecision(): DecisionRecord | undefined {
    return this.decisions[this.decisions.length - 1];
  }

  decisionsSince(t: number): DecisionRecord[] {
    return this.decisions.filter((d) => d.at >= t);
  }

  pumpOnSends(): number {
    return this.actuator.count('pump_on');
  }

  pumpOffSends(): number {
    return this.actuator.count('pump_off');
  }

  commandsOfType(type: Command['type']): Command[] {
    return [...this.mem.commands.values()].filter((c) => c.type === type);
  }

  /** Alarm codes in the most recent full-set publication on the bus. */
  activeAlarmCodes(): string[] {
    return this.alarmHistory.at(-1)?.codes ?? [];
  }

  /** Alarm codes ever seen on the bus (any publication). */
  everAlarmCodes(): Set<string> {
    return new Set(this.alarmHistory.flatMap((s) => s.codes));
  }
}

const openRigs = new Set<Rig>();

/** Close every rig still open. Call from afterEach in each scenario file. */
export async function closeAllRigs(): Promise<void> {
  for (const r of [...openRigs]) await r.close();
  openRigs.clear();
}

/** Closed event row helper for seeding the store. */
export function closedEvent(id: number, startIso: string, endIso: string, result: IrrigationEvent['result'] = 'completed'): IrrigationEvent {
  return { id, ts_start: startIso, ts_end: endIso, trigger: 'auto', reason: 'seeded', result };
}

export { T0, FakeActuator, FakeClock, MemRepo };

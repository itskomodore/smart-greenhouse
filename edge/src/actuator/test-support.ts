/**
 * Test doubles for actuator + controller tests: fake clock, scripted actuator, in-memory repo.
 * Not used by production code (excluded from the build).
 */
import type {
  ActuatorAck,
  ActuatorAdapter,
  Alarm,
  AlarmCode,
  Command,
  IrrigationEvent,
  OutboxRow,
  Reading,
  Repo,
  Settings,
} from '../types.js';
import { SETTINGS_DEFAULTS } from '../types.js';
import { ActuatorTimeoutError } from './adapter.js';
import type { Clock } from './clock.js';

export const T0 = Date.parse('2026-11-08T10:00:00.000Z');

/** Let pending promise continuations run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise<void>((r) => setImmediate(r));
}

interface Waiter {
  at: number;
  seq: number;
  resolve: () => void;
}

export class FakeClock implements Clock {
  private t: number;
  private waiters: Waiter[] = [];
  private seq = 0;

  constructor(start: number = T0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.push({ at: this.t + Math.max(0, ms), seq: this.seq++, resolve });
    });
  }

  /** Move time forward without firing sleepers (synchronous; for hooks that must not await). */
  jump(ms: number): void {
    this.t += ms;
  }

  /** Move time forward, firing sleepers in deadline order and letting async work settle between steps. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    await settle();
    for (;;) {
      const due = this.waiters
        .filter((w) => w.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.waiters = this.waiters.filter((w) => w !== due);
      this.t = due.at;
      due.resolve();
      await settle();
    }
    this.t = target;
    await settle();
  }
}

/** Advance the clock in small steps until `cond()` holds. Throws if it never does. */
export async function driveUntil(cond: () => boolean, clock: FakeClock, stepMs = 250, maxSteps = 400): Promise<void> {
  await settle();
  for (let i = 0; i < maxSteps; i++) {
    if (cond()) return;
    await clock.advance(stepMs);
  }
  if (!cond()) throw new Error('driveUntil: condition not reached');
}

/** Await a promise while the fake clock moves forward. */
export async function drive<T>(p: Promise<T>, clock: FakeClock, stepMs = 250, maxSteps = 400): Promise<T> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | null = null;
  p.then(
    (value) => {
      outcome = { ok: true, value };
    },
    (error: unknown) => {
      outcome = { ok: false, error };
    },
  );
  for (let i = 0; i < maxSteps && outcome === null; i++) await clock.advance(stepMs);
  await settle();
  const o = outcome as { ok: true; value: T } | { ok: false; error: unknown } | null;
  if (o === null) throw new Error('drive: promise did not settle');
  if (!o.ok) throw o.error;
  return o.value;
}

export interface CallRecord {
  kind: 'put' | 'query';
  type: string;
  id: string | null;
  max_s: number | null;
  at: number;
}

export type Behaviour = (call: { kind: 'put'; cmd: Command } | { kind: 'query' }) => Promise<ActuatorAck>;

/**
 * Scripted actuator. `actual` is the true pump state; `behave` decides what the controller sees.
 * Default behaviour applies the command and acknowledges it.
 */
export class FakeActuator implements ActuatorAdapter {
  actual: 'on' | 'off' = 'off';
  readonly calls: CallRecord[] = [];
  behave: Behaviour = (call) => this.applyAndAck(call);

  constructor(private readonly clock: FakeClock) {}

  count(type: string): number {
    return this.calls.filter((c) => c.type === type).length;
  }

  send(cmd: Command): Promise<ActuatorAck> {
    this.calls.push({ kind: 'put', type: cmd.type, id: cmd.id, max_s: cmd.max_s, at: this.clock.now() });
    return this.behave({ kind: 'put', cmd });
  }

  query(): Promise<ActuatorAck> {
    this.calls.push({ kind: 'query', type: 'pump_query', id: null, max_s: null, at: this.clock.now() });
    return this.behave({ kind: 'query' });
  }

  applyAndAck(call: { kind: 'put'; cmd: Command } | { kind: 'query' }): Promise<ActuatorAck> {
    if (call.kind === 'query') return Promise.resolve({ command_id: null, pump: this.actual });
    if (call.cmd.type === 'pump_on') {
      this.actual = 'on';
      return Promise.resolve({ command_id: call.cmd.id, pump: 'on', remaining_s: call.cmd.max_s ?? 0 });
    }
    this.actual = 'off';
    return Promise.resolve({ command_id: call.cmd.id, pump: 'off' });
  }
}

/** Reply never arrives. */
export function noReply(): Promise<ActuatorAck> {
  return Promise.reject(new ActuatorTimeoutError('no reply (test)'));
}

/** The actuator applies the command but the acknowledgement is lost. */
export function appliedButLost(actuator: FakeActuator, pump: 'on' | 'off'): () => Promise<ActuatorAck> {
  return () => {
    actuator.actual = pump;
    return noReply();
  };
}

export type RepoFault = 'ok' | 'throw' | 'hang';

/**
 * In-memory Repo. Stores copies (like a DB would). `faults` makes every call throw or hang,
 * to exercise the DB-independent safety path. Methods not needed by the controller throw.
 */
export class MemRepo implements Repo {
  settings: Settings;
  readonly commands = new Map<string, Command>();
  readonly events: IrrigationEvent[] = [];
  readonly alarms = new Map<AlarmCode, Alarm>();
  readonly rows: Reading[] = [];
  faults: RepoFault = 'ok';
  /** Awaited inside insertEvent before the row is stored (lets tests race an OFF against an insert). */
  onInsert: ((row: Omit<IrrigationEvent, 'id'>) => Promise<void> | void) | null = null;
  /** Awaited inside upsertCommand after the write is recorded (lets tests interleave with a send). */
  onUpsert: ((c: Command) => Promise<void> | void) | null = null;
  /** Make the next updateEvent / insertEvent reject once. */
  failNextUpdateEvent = false;
  failNextInsertEvent = false;
  private nextEventId = 1;

  constructor(settings: Partial<Settings> = {}) {
    this.settings = { ...SETTINGS_DEFAULTS, ...settings };
  }

  /** Duck-typed health flag the controller reads (like BufferedRepo). */
  isDown(): boolean {
    return this.faults !== 'ok';
  }

  private async gate(): Promise<void> {
    if (this.faults === 'throw') throw new Error('db unavailable (test)');
    if (this.faults === 'hang') await new Promise<void>(() => undefined);
  }

  async insertReading(r: Reading): Promise<void> {
    await this.gate();
    this.rows.push(r);
  }
  async latestReading(): Promise<Reading | null> {
    await this.gate();
    return this.rows.at(-1) ?? null;
  }
  async readings(): Promise<Reading[]> {
    await this.gate();
    return [...this.rows];
  }
  async nodeLastSeen(): Promise<Record<string, string>> {
    await this.gate();
    return {};
  }
  async getSettings(): Promise<Settings> {
    await this.gate();
    return { ...this.settings };
  }
  async putSettings(patch: Partial<Settings>): Promise<Settings> {
    await this.gate();
    this.settings = { ...this.settings, ...patch };
    return { ...this.settings };
  }
  async upsertCommand(c: Command): Promise<void> {
    await this.gate();
    this.commands.set(c.id, structuredClone(c));
    if (this.onUpsert) await this.onUpsert(structuredClone(c));
  }
  async getCommand(id: string): Promise<Command | null> {
    await this.gate();
    const c = this.commands.get(id);
    return c ? structuredClone(c) : null;
  }
  async openCommands(): Promise<Command[]> {
    await this.gate();
    return [...this.commands.values()]
      .filter((c) => c.state === 'pending' || c.state === 'sent')
      .map((c) => structuredClone(c));
  }
  async insertEvent(e: Omit<IrrigationEvent, 'id'>): Promise<number> {
    await this.gate();
    if (this.failNextInsertEvent) {
      this.failNextInsertEvent = false;
      throw new Error('insert failed (test)');
    }
    if (this.onInsert) await this.onInsert(e);
    const id = this.nextEventId++;
    this.events.push({ ...e, id });
    return id;
  }
  async updateEvent(id: number, patch: Partial<IrrigationEvent>): Promise<void> {
    await this.gate();
    if (this.failNextUpdateEvent) {
      this.failNextUpdateEvent = false;
      throw new Error('update failed (test)');
    }
    const ev = this.events.find((e) => e.id === id);
    if (!ev) throw new Error(`no event ${id}`);
    Object.assign(ev, patch);
  }
  async recentEvents(limit: number): Promise<IrrigationEvent[]> {
    await this.gate();
    return [...this.events].reverse().slice(0, limit).map((e) => ({ ...e }));
  }
  async openEvent(): Promise<(IrrigationEvent & { id: number }) | null> {
    await this.gate();
    const ev = this.events.find((e) => e.ts_end === null);
    return ev ? { ...ev, id: ev.id! } : null;
  }
  async runtimeSecondsSince(since: string): Promise<number> {
    await this.gate();
    return this.closedRuntimeFrom(since);
  }
  async closedRuntimeSecondsSince(since: string): Promise<number> {
    await this.gate();
    return this.closedRuntimeFrom(since);
  }
  async lastEventEnd(): Promise<string | null> {
    await this.gate();
    const ends = this.events.map((e) => e.ts_end).filter((x): x is string => x !== null);
    if (ends.length === 0) return null;
    return ends.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
  }
  /** Seconds of CLOSED events overlapping [since, now). Open events are excluded. */
  private closedRuntimeFrom(since: string): number {
    const from = Date.parse(since);
    let s = 0;
    for (const e of this.events) {
      if (e.ts_end === null) continue;
      const a = Math.max(Date.parse(e.ts_start), from);
      const b = Date.parse(e.ts_end);
      if (b > a) s += (b - a) / 1000;
    }
    return s;
  }
  async saveAlarm(a: Alarm | { code: AlarmCode; cleared: true }): Promise<void> {
    await this.gate();
    if ('cleared' in a) this.alarms.delete(a.code);
    else this.alarms.set(a.code, { ...a });
  }
  async activeAlarms(): Promise<Alarm[]> {
    await this.gate();
    return [...this.alarms.values()].map((a) => ({ ...a }));
  }
  async enqueueOutbox(): Promise<void> {}
  async pendingOutbox(): Promise<OutboxRow[]> {
    return [];
  }
  async markOutboxSent(): Promise<void> {}
  async purgeOlderThan(): Promise<{ readings: number }> {
    return { readings: 0 };
  }
  async ping(): Promise<boolean> {
    return this.faults === 'ok';
  }
}

export function makeReading(soil_pct: number, ts: number): Reading {
  return {
    node_id: 'node-a',
    ts: new Date(ts).toISOString(),
    t: 22,
    rh: 50,
    light_raw: 800,
    soil_raw: 2000,
    soil_pct,
    light_pct: 20,
  };
}

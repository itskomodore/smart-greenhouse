import { bus as defaultBus, type TypedBus } from '../bus.js';
import { createLogger, type Logger } from '../log.js';
import {
  SETTINGS_DEFAULTS,
  type Alarm,
  type AlarmCode,
  type Command,
  type IrrigationEvent,
  type OutboxRow,
  type Reading,
  type Repo,
  type Settings,
} from '../types.js';

export const DB_DOWN_CODE: AlarmCode = 'db_down';

export interface BufferedRepoOptions {
  /** Ring capacity in readings (DB_BUFFER_MAX). Overflow drops the OLDEST reading. */
  maxBuffer: number;
  /** Minimum gap between DB attempts while down (readings arriving in between are only buffered). */
  probeBackoffMs?: number;
  bus?: TypedBus;
  log?: Logger;
  /** Epoch-ms clock; injectable for tests. */
  now?: () => number;
  /** Used for getSettings() when the DB has never answered (boot defaults). Default SETTINGS_DEFAULTS. */
  settingsFallback?: Settings;
}

export interface DbStatus {
  up: boolean;
  buffered: number;
  dropped: number;
  since: string | null;
}

/**
 * Repo decorator. Readings never fail the caller because of a DB outage:
 * - DB up: write straight through (after draining anything buffered, so order is kept).
 * - DB down: append to a bounded in-memory ring; drop the oldest on overflow (warn log).
 * - Recovery: the ring is flushed FIFO before any new reading is written.
 * Raises/clears the `db_down` alarm (DB row best-effort, bus `alarms` + `db` topics always).
 * Every other Repo method passes through unchanged.
 */
export class BufferedRepo implements Repo {
  private ring: Reading[] = [];
  private up = true;
  private downSince: number | null = null;
  private nextProbeAt = 0;
  private dropped = 0;
  private lastAlarms: Alarm[] = [];
  private settingsCache: Settings | null = null;
  private readonly settingsFallback: Settings;
  private chain: Promise<unknown> = Promise.resolve();

  private readonly maxBuffer: number;
  private readonly backoffMs: number;
  private readonly bus: TypedBus;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(private readonly inner: Repo, opts: BufferedRepoOptions) {
    if (!Number.isInteger(opts.maxBuffer) || opts.maxBuffer < 1) {
      throw new RangeError(`BufferedRepo maxBuffer must be a positive integer, got ${opts.maxBuffer}`);
    }
    this.maxBuffer = opts.maxBuffer;
    this.backoffMs = opts.probeBackoffMs ?? 5000;
    this.bus = opts.bus ?? defaultBus;
    this.log = opts.log ?? createLogger('db.buffered');
    this.now = opts.now ?? Date.now;
    this.settingsFallback = opts.settingsFallback ?? SETTINGS_DEFAULTS;
  }

  status(): DbStatus {
    return {
      up: this.up,
      buffered: this.ring.length,
      dropped: this.dropped,
      since: this.downSince === null ? null : new Date(this.downSince).toISOString(),
    };
  }

  /** Force a flush attempt now (ignores probe backoff). Resolves true when DB is up afterwards. */
  recover(): Promise<boolean> {
    return this.serial(async () => {
      this.nextProbeAt = 0;
      return this.drain();
    });
  }

  /**
   * Settings never wait on a hung DB for the pump-OFF safety path: while down (within backoff) the
   * cache is returned at once; a failed read marks the DB down and also returns the cache.
   * Cache = last good read, else boot defaults.
   */
  async getSettings(): Promise<Settings> {
    const fallback = this.settingsCache ?? this.settingsFallback;
    if (!this.up && this.now() < this.nextProbeAt) return fallback;
    try {
      const s = await this.inner.getSettings();
      this.settingsCache = s;
      return s;
    } catch (err) {
      await this.markDown(err);
      return this.settingsCache ?? this.settingsFallback;
    }
  }

  /** Rejects while the DB is down: settings are never silently kept only in memory. */
  async putSettings(patch: Partial<Settings>): Promise<Settings> {
    if (!this.up) throw new Error('database unavailable: settings not saved');
    try {
      const s = await this.inner.putSettings(patch);
      this.settingsCache = s;
      return s;
    } catch (err) {
      await this.markDown(err);
      throw err;
    }
  }

  /**
   * Alarms from the DB. When the DB is down or the read fails, resolves from the last known set
   * with db_down included (never throws because of a DB outage).
   */
  async activeAlarms(): Promise<Alarm[]> {
    if (!this.up && this.now() < this.nextProbeAt) return this.alarmsWithDbDown();
    try {
      const alarms = await this.inner.activeAlarms();
      this.lastAlarms = alarms;
      return alarms;
    } catch (err) {
      await this.markDown(err);
      return this.alarmsWithDbDown();
    }
  }

  private alarmsWithDbDown(): Alarm[] {
    const rest = this.lastAlarms.filter((a) => a.code !== DB_DOWN_CODE);
    const since = this.downSince === null ? new Date(this.now()) : new Date(this.downSince);
    return [
      ...rest,
      {
        code: DB_DOWN_CODE,
        since: since.toISOString(),
        message: 'Database unreachable; readings are buffered in memory',
        severity: 'critical',
      },
    ];
  }

  // ───── readings (the buffered path) ─────

  insertReading(r: Reading): Promise<void> {
    return this.serial(async () => {
      if (!this.up || this.ring.length > 0) {
        this.push(r);
        if (this.now() >= this.nextProbeAt) await this.drain();
        return;
      }
      try {
        await this.inner.insertReading(r);
      } catch (err) {
        this.push(r);
        await this.markDown(err);
      }
    });
  }

  // ───── pass-through ─────

  latestReading(node_id?: string): Promise<Reading | null> {
    return this.inner.latestReading(node_id);
  }
  readings(q: { from?: string; to?: string; limit?: number; node_id?: string }): Promise<Reading[]> {
    return this.inner.readings(q);
  }
  nodeLastSeen(): Promise<Record<string, string>> {
    return this.inner.nodeLastSeen();
  }
  upsertCommand(c: Command): Promise<void> {
    return this.inner.upsertCommand(c);
  }
  getCommand(id: string): Promise<Command | null> {
    return this.inner.getCommand(id);
  }
  openCommands(): Promise<Command[]> {
    return this.inner.openCommands();
  }
  insertEvent(e: Omit<IrrigationEvent, 'id'>): Promise<number> {
    return this.inner.insertEvent(e);
  }
  updateEvent(id: number, patch: Partial<IrrigationEvent>): Promise<void> {
    return this.inner.updateEvent(id, patch);
  }
  recentEvents(limit: number): Promise<IrrigationEvent[]> {
    return this.inner.recentEvents(limit);
  }
  openEvent(): Promise<(IrrigationEvent & { id: number }) | null> {
    return this.inner.openEvent();
  }
  runtimeSecondsSince(iso: string): Promise<number> {
    return this.inner.runtimeSecondsSince(iso);
  }
  closedRuntimeSecondsSince(iso: string): Promise<number> {
    return this.inner.closedRuntimeSecondsSince(iso);
  }
  lastEventEnd(): Promise<string | null> {
    return this.inner.lastEventEnd();
  }
  async saveAlarm(a: Alarm | { code: AlarmCode; cleared: true }): Promise<void> {
    await this.inner.saveAlarm(a);
  }
  enqueueOutbox(kind: string, payload: unknown): Promise<void> {
    return this.inner.enqueueOutbox(kind, payload);
  }
  pendingOutbox(limit: number): Promise<OutboxRow[]> {
    return this.inner.pendingOutbox(limit);
  }
  markOutboxSent(ids: number[]): Promise<void> {
    return this.inner.markOutboxSent(ids);
  }
  purgeOlderThan(days: number): Promise<{ readings: number }> {
    return this.inner.purgeOlderThan(days);
  }
  ping(): Promise<boolean> {
    return this.inner.ping();
  }

  // ───── internals ─────

  /** Serialize buffered-path operations so ring order == DB write order. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private push(r: Reading): void {
    if (this.ring.length >= this.maxBuffer) {
      this.ring.shift();
      this.dropped++;
      this.log.warn(
        { capacity: this.maxBuffer, dropped_total: this.dropped },
        'reading buffer full; dropped oldest buffered reading',
      );
    }
    this.ring.push(r);
    if (!this.up) this.publishHealth();
  }

  /** FIFO flush. Stops at the first failure, leaving the failed reading at the head. */
  private async drain(): Promise<boolean> {
    // Invariant: !up implies ring is non-empty (markUp only runs once the ring is empty).
    if (this.ring.length === 0) return true;
    const flushed = this.ring.length;
    try {
      while (this.ring.length > 0) {
        await this.inner.insertReading(this.ring[0]!);
        this.ring.shift();
      }
    } catch (err) {
      await this.markDown(err);
      return false;
    }
    await this.markUp(flushed);
    return true;
  }

  private async markDown(err: unknown): Promise<void> {
    this.nextProbeAt = this.now() + this.backoffMs;
    if (!this.up) return; // already down; keep the original since
    this.up = false;
    this.downSince = this.now();
    this.log.error({ err, buffered: this.ring.length }, 'database unavailable; buffering readings in memory');
    const alarm: Alarm = {
      code: DB_DOWN_CODE,
      since: new Date(this.downSince).toISOString(),
      message: 'Database unreachable; readings are buffered in memory',
      severity: 'critical',
    };
    this.publishHealth();
    // Persisting the alarm is best-effort (the DB is what is down); the bus always carries it.
    await this.inner.saveAlarm(alarm).catch(() => undefined);
    this.publishAlarms([...this.lastAlarms.filter((a) => a.code !== DB_DOWN_CODE), alarm]);
  }

  private async markUp(flushed: number): Promise<void> {
    if (this.up) return;
    this.up = true;
    const downMs = this.downSince === null ? 0 : this.now() - this.downSince;
    this.downSince = null;
    this.nextProbeAt = 0;
    this.log.info({ flushed, down_ms: downMs, dropped_total: this.dropped }, 'database recovered; buffer flushed');
    this.publishHealth();
    await this.inner.saveAlarm({ code: DB_DOWN_CODE, cleared: true }).catch(() => undefined);
    try {
      this.lastAlarms = await this.inner.activeAlarms();
    } catch {
      // keep last known set
    }
    this.publishAlarms(this.lastAlarms.filter((x) => x.code !== DB_DOWN_CODE));
  }

  private publishHealth(): void {
    const s = this.status();
    this.bus.emit('db', { up: s.up, buffered: s.buffered, dropped: s.dropped, since: s.since });
  }

  private publishAlarms(alarms: Alarm[]): void {
    this.bus.emit('alarms', alarms);
  }
}

import type { TypedBus } from '../bus.js';
import { bounded } from '../actuator/bounded.js';
import type { AlarmSink } from '../actuator/commands.js';
import type { Clock } from '../actuator/clock.js';
import { iso } from '../actuator/clock.js';
import type { Logger } from '../log.js';
import type { Alarm, AlarmCode, Repo } from '../types.js';

/** Re-derived from the rules decision every tick (full-set semantics). */
const RULE_CODES: readonly AlarmCode[] = ['sensor_stale', 'actuator_state_unknown', 'daily_cap_reached'];
/** Set by the controller; cleared by specific events (command ack, accepted reading). */
const LATCHED_CODES: readonly AlarmCode[] = ['actuator_unreachable', 'pump_failed', 'soil_jump_ignored'];
/** Codes this board owns. Anything else persisted (e.g. db_down, owned by BufferedRepo) passes through. */
const MANAGED: ReadonlySet<AlarmCode> = new Set<AlarmCode>([...RULE_CODES, ...LATCHED_CODES]);

const TEXT: Record<AlarmCode, { severity: Alarm['severity']; message: string }> = {
  sensor_stale: { severity: 'warn', message: 'No sensor reading within stale timeout; automatic irrigation disabled' },
  actuator_state_unknown: { severity: 'warn', message: 'Pump state unknown; querying actuator before any start' },
  daily_cap_reached: { severity: 'warn', message: 'Daily irrigation budget used up' },
  actuator_unreachable: { severity: 'critical', message: 'Actuator did not acknowledge a command' },
  pump_failed: { severity: 'critical', message: 'Pump command failed after retries' },
  soil_jump_ignored: { severity: 'warn', message: 'Implausible soil reading jump ignored' },
  db_down: { severity: 'critical', message: 'Database unreachable' },
};

function isRuleCode(c: AlarmCode): boolean {
  return (RULE_CODES as readonly string[]).includes(c);
}

export interface AlarmBoardDeps {
  repo: Repo;
  bus: TypedBus;
  clock: Clock;
  log: Logger;
  /** Upper bound for one repo call (ms). */
  dbTimeoutMs?: number;
  /** True while the repo reports itself down; then no DB calls are attempted. */
  isDown?: () => boolean;
}

/**
 * Alarm state for the controller. Publishes the bus `alarms` topic as a FULL set:
 * the persisted active alarms (minus codes this board manages) plus this board's own set.
 * This keeps `db_down` (raised by BufferedRepo) visible.
 */
export class AlarmBoard implements AlarmSink {
  private readonly mirror = new Map<AlarmCode, Alarm>();
  /** Last persisted set that was read successfully; used when activeAlarms() fails. */
  private lastPersisted: Alarm[] = [];
  private readonly dbTimeoutMs: number;

  constructor(private readonly deps: AlarmBoardDeps) {
    this.dbTimeoutMs = deps.dbTimeoutMs ?? 2000;
  }

  /** Load managed alarms that were active before this process started. */
  async hydrate(): Promise<void> {
    try {
      const all = await bounded(this.deps.repo.activeAlarms(), this.dbTimeoutMs, 'activeAlarms');
      this.lastPersisted = all;
      for (const a of all) {
        if (MANAGED.has(a.code)) this.mirror.set(a.code, a);
      }
    } catch (err) {
      this.deps.log.warn({ err: errMessage(err) }, 'could not hydrate alarms');
    }
  }

  has(code: AlarmCode): boolean {
    return this.mirror.has(code);
  }

  async raise(code: AlarmCode, message: string, severity?: Alarm['severity']): Promise<void> {
    if (this.mirror.has(code)) return;
    const alarm = this.make(code, message, severity);
    this.mirror.set(code, alarm);
    await this.persist(alarm);
    await this.publish();
  }

  async clearIfStale(code: AlarmCode, minAgeMs: number): Promise<void> {
    const a = this.mirror.get(code);
    if (!a || this.deps.clock.now() - Date.parse(a.since) < minAgeMs) return;
    await this.clear(code);
  }

  async clear(code: AlarmCode): Promise<void> {
    if (!this.mirror.delete(code)) return;
    await this.persistClear(code);
    await this.publish();
  }

  /** Reconcile rule-derived alarms with the decision's current set. */
  async syncRules(codes: readonly AlarmCode[]): Promise<void> {
    const want = new Set(codes.filter(isRuleCode));
    let changed = false;
    for (const code of want) {
      if (this.mirror.has(code)) continue;
      const alarm = this.make(code);
      this.mirror.set(code, alarm);
      await this.persist(alarm);
      changed = true;
    }
    for (const code of RULE_CODES) {
      if (want.has(code) || !this.mirror.has(code)) continue;
      this.mirror.delete(code);
      await this.persistClear(code);
      changed = true;
    }
    if (changed) await this.publish();
  }

  private make(code: AlarmCode, message?: string, severity?: Alarm['severity']): Alarm {
    return {
      code,
      since: iso(this.deps.clock.now()),
      message: message ?? TEXT[code].message,
      severity: severity ?? TEXT[code].severity,
    };
  }

  private async publish(): Promise<void> {
    let persisted: Alarm[] = this.lastPersisted;
    try {
      if (this.deps.isDown?.()) throw new Error('repo reports down');
      persisted = await bounded(this.deps.repo.activeAlarms(), this.dbTimeoutMs, 'activeAlarms');
      this.lastPersisted = persisted;
    } catch (err) {
      this.deps.log.warn({ err: errMessage(err) }, 'activeAlarms unavailable; keeping last known persisted set');
    }
    const merged = persisted.filter((a) => !MANAGED.has(a.code));
    merged.push(...this.mirror.values());
    this.deps.bus.emit('alarms', merged);
  }

  private async persist(alarm: Alarm): Promise<void> {
    if (this.deps.isDown?.()) return;
    try {
      await bounded(this.deps.repo.saveAlarm(alarm), this.dbTimeoutMs, 'saveAlarm');
    } catch (err) {
      this.deps.log.error({ code: alarm.code, err: errMessage(err) }, 'saveAlarm failed');
    }
  }

  private async persistClear(code: AlarmCode): Promise<void> {
    if (this.deps.isDown?.()) return;
    try {
      await bounded(this.deps.repo.saveAlarm({ code, cleared: true }), this.dbTimeoutMs, 'saveAlarm');
    } catch (err) {
      this.deps.log.error({ code, err: errMessage(err) }, 'clear alarm failed');
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

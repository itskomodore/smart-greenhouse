/**
 * Controller: every RULES_TICK_MS build RulesState → decide() (src/rules) → execute.
 * Owns irrigation_events rows, daily runtime, alarms (via AlarmBoard), and the pump state.
 * Time via injected Clock; all I/O via injected ActuatorAdapter, Repo and TypedBus.
 *
 * Safety invariants:
 * - The OFF path (guard, manual off, late-ON cleanup) never waits on the DB.
 * - An OFF bumps a stop epoch synchronously; any start that started before that bump is abandoned.
 * - New starts are refused while the DB is unhealthy; OFF is always allowed.
 * - Daily budget = max(DB closed runtime, in-memory runtime of this process today).
 */
import type { TypedBus } from '../bus.js';
import { bounded } from '../actuator/bounded.js';
import { CommandManager, type Settled } from '../actuator/commands.js';
import { MAX_RUN_S } from '../actuator/adapter.js';
import { iso, systemClock, type Clock } from '../actuator/clock.js';
import { createLogger, type Logger } from '../log.js';
import { assessReading as defaultAssess, decide as defaultDecide } from '../rules/index.js';
import {
  SETTINGS_DEFAULTS,
  type ActuatorAdapter,
  type Command,
  type Decision,
  type IrrigationEvent,
  type IrrigationResult,
  type PumpState,
  type Reading,
  type ReadingAssessment,
  type Repo,
  type RulesState,
  type Settings,
  type Trigger,
} from '../types.js';
import { AlarmBoard } from './alarms.js';

/** Grace after max_s before the controller forces OFF itself (actuator's own timer should fire first). */
export const GUARD_GRACE_MS = 2_000;
/** First interval between forced OFF retries while OFF is unconfirmed (doubles, see below). */
export const GUARD_RETRY_MS = 5_000;
/** Cap for the forced-OFF retry interval: 5 s, 10 s, 20 s, ... 60 s. */
export const GUARD_BACKOFF_CAP_MS = 60_000;
/** No automatic query for this long after a failed command (avoids a query storm). */
export const QUERY_COOLDOWN_MS = 10_000;
/** Consecutive rejected readings that must agree before the jump filter re-baselines. */
export const JUMP_CONFIRM_READINGS = 3;
/** ...and the agreeing readings must span at least this long (not just a burst of packets). */
export const JUMP_MIN_SPAN_MS = 60_000;
/** Rejected-reading history kept for the latch decision. */
const JUMP_HISTORY = 50;
/** How long the re-baseline notice stays on the alarm board. */
export const REBASELINE_NOTICE_MS = 3_600_000;
/** Default bound for one repo call on the controller path. */
export const DB_TIMEOUT_MS = 2_000;
/** A tick that takes longer than this is abandoned so the next tick can run. */
export const TICK_TIMEOUT_MS = 10_000;
/** Event writes that failed and are retried on later ticks (oldest dropped beyond this). */
export const PENDING_WRITES_CAP = 20;
/** Open irrigation events aborted at boot, at most. */
export const BOOT_EVENT_LIMIT = 20;

export interface SoilPoint {
  soil_pct: number;
  ts: number;
}

export type DecideFn = (state: RulesState) => Decision;
export type AssessFn = (prev: SoilPoint | null, next: SoilPoint, settings: Settings) => ReadingAssessment;

export interface ControllerDeps {
  repo: Repo;
  adapter: ActuatorAdapter;
  bus: TypedBus;
  clock?: Clock;
  log?: Logger;
  /** Defaults to the real rules engine. */
  decide?: DecideFn;
  /** Defaults to the real rules engine. */
  assessReading?: AssessFn;
  /** RULES_TICK_MS. */
  tickMs?: number;
  dbTimeoutMs?: number;
  tickTimeoutMs?: number;
}

/** A start command sent by the controller, from send until its irrigation event is closed. */
export interface ActiveRun {
  commandId: string;
  startSentAt: number;
  max_s: number;
  trigger: 'auto' | 'manual';
  reason: string;
  eventId: number | null;
  /** Insert of the 'running' row in progress (closeRun waits for it). */
  opening: Promise<number | null> | null;
  /** Set when the start was acknowledged (pump reported on). */
  ackedAt: number | null;
  /** True once the run has been closed (written to irrigation_events, or superseded). */
  closed: boolean;
  closedAt: number | null;
  /** Epoch ms up to which this run's runtime has been charged to the daily budget (no double count). */
  chargedUntil: number | null;
  /** True once the irrigation_events row was closed (possibly at a forced stop, before OFF acked). */
  rowClosed: boolean;
}

interface ManualOn {
  command: Command;
  duration_s: number;
}

export type ManualRequest = { cmd: 'on'; duration_s: number; id?: string } | { cmd: 'off'; id?: string };

/**
 * Public refusal codes (the API surface lists exactly these). Internal reasons 'db_unavailable' and
 * 'superseded' are mapped onto them in refuse(); the message carries the precise reason.
 */
export type ManualRefusalCode = 'invalid_duration' | 'manual_pending' | 'run_active' | 'pump_on' | 'daily_cap_reached';

type InternalRefusal = ManualRefusalCode | 'db_unavailable' | 'superseded';

export type ManualResult =
  | { ok: true; command: Command; duplicate: boolean }
  | { ok: false; code: ManualRefusalCode; message: string };

type PendingWrite =
  | { kind: 'update'; id: number; patch: Partial<IrrigationEvent> }
  | { kind: 'insert'; row: Omit<IrrigationEvent, 'id'> };

/** Local midnight of `now` as ISO UTC (daily budget window). */
export function localDayStart(now: number): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function refuse(code: InternalRefusal, message: string): ManualResult {
  // Until the API surface lists them: an unverifiable budget is refused as a cap refusal, and a
  // start displaced by an OFF is refused as a pending-request conflict.
  const mapped: ManualRefusalCode =
    code === 'db_unavailable' ? 'daily_cap_reached' : code === 'superseded' ? 'manual_pending' : code;
  return { ok: false, code: mapped, message };
}

export class Controller {
  private readonly repo: Repo;
  private readonly bus: TypedBus;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly decide: DecideFn;
  private readonly assess: AssessFn;
  private readonly tickMs: number;
  private readonly dbTimeoutMs: number;
  private readonly tickTimeoutMs: number;
  private readonly alarms: AlarmBoard;
  private readonly commands: CommandManager;

  private settings: Settings | null = null;
  private pump: PumpState = 'unknown';
  private run: ActiveRun | null = null;
  private manual: ManualOn | null = null;
  private reservation: Promise<ManualResult> | null = null;
  private reservedId: string | undefined = undefined;
  private starting = false;
  private stopEpoch = 0;
  private offPending = false;
  private dbHealthy = true;
  private latest: SoilPoint | null = null;
  private rejected: SoilPoint[] = [];
  private soilNotice = false;
  private noticeUntil = 0;
  /** Closed runtime today as the DB reports it. */
  private dbDailyMs = 0;
  /** Runtime closed by this process today (covers writes the DB has not accepted yet). */
  private memDay: string | null = null;
  private memMs = 0;
  private pendingWrites: PendingWrite[] = [];
  private lastRunEndedAt: number | null = null;
  private cooldownUntil = 0;
  private guardNextAt = 0;
  private guardBackoffMs = GUARD_RETRY_MS;
  private started = false;
  private stopped = false;
  private ticking = false;
  private timer: NodeJS.Timeout | null = null;

  private readonly onBusReading = (r: Reading): void => {
    this.onReading(r).catch((err: unknown) => this.log.error({ err: errMessage(err) }, 'reading handling failed'));
  };
  private readonly onBusSettings = (s: Settings): void => {
    this.settings = s;
  };

  constructor(deps: ControllerDeps) {
    this.repo = deps.repo;
    this.bus = deps.bus;
    this.clock = deps.clock ?? systemClock;
    this.log = deps.log ?? createLogger('controller');
    this.decide = deps.decide ?? defaultDecide;
    this.assess = deps.assessReading ?? defaultAssess;
    this.tickMs = deps.tickMs ?? 1000;
    this.dbTimeoutMs = deps.dbTimeoutMs ?? DB_TIMEOUT_MS;
    this.tickTimeoutMs = deps.tickTimeoutMs ?? TICK_TIMEOUT_MS;
    this.alarms = new AlarmBoard({
      repo: deps.repo,
      bus: deps.bus,
      clock: this.clock,
      log: this.log,
      dbTimeoutMs: this.dbTimeoutMs,
      isDown: () => this.repoDown(),
    });
    this.commands = new CommandManager({
      repo: deps.repo,
      adapter: deps.adapter,
      clock: this.clock,
      alarms: this.alarms,
      log: this.log.child({ part: 'commands' }),
      getSettings: () => this.requireSettings(),
      dbTimeoutMs: this.dbTimeoutMs,
    });
  }

  // ───── read-only views (API / tests) ─────

  get pumpState(): PumpState {
    return this.pump;
  }
  get activeRun(): ActiveRun | null {
    return this.run;
  }
  get pendingManual(): Command | null {
    return this.manual?.command ?? null;
  }
  get latestAccepted(): SoilPoint | null {
    return this.latest;
  }
  get dailyRuntimeSeconds(): number {
    return Math.floor(this.effectiveDailyMs(this.clock.now()) / 1000);
  }
  get healthy(): boolean {
    return this.dbHealthy;
  }

  // ───── lifecycle ─────

  /**
   * Boot: pump UNKNOWN. Reload open commands. If an irrigation event, a pump_on, or an unknown DB
   * state was found, send a safe OFF, then mark every open event 'aborted' (bounded loop).
   * `latest` stays null until a live reading arrives.
   */
  async start(opts: { autoTick?: boolean } = {}): Promise<void> {
    if (this.started) throw new Error('controller already started');
    this.started = true;
    this.stopped = false;
    this.setPump('unknown');
    this.settings = await this.loadSettingsOrDefault();
    await this.alarms.hydrate();
    this.bus.on('reading', this.onBusReading);
    this.bus.on('settings', this.onBusSettings);

    let bootOk = this.dbHealthy;
    let interrupted: Command[] = [];
    try {
      interrupted = await this.commands.recover();
    } catch (err) {
      bootOk = false;
      this.log.error({ err: errMessage(err) }, 'could not reload open commands at boot');
    }
    let firstOpen: (IrrigationEvent & { id: number }) | null = null;
    try {
      firstOpen = await bounded(this.repo.openEvent(), this.dbTimeoutMs, 'openEvent');
    } catch (err) {
      bootOk = false;
      this.log.error({ err: errMessage(err) }, 'could not read open irrigation event at boot');
    }
    try {
      const end = await bounded(this.repo.lastEventEnd(), this.dbTimeoutMs, 'lastEventEnd');
      this.lastRunEndedAt = end ? Date.parse(end) : null;
    } catch (err) {
      // Unknown last end: be conservative and treat the boot as the last run end (min_interval holds).
      bootOk = false;
      this.lastRunEndedAt = this.clock.now();
      this.log.error({ err: errMessage(err) }, 'could not read last run end; min interval assumed from boot');
    }

    // OFF first (safety), then close the bookkeeping.
    if (firstOpen || interrupted.length > 0 || !bootOk) {
      const { done } = await this.issueOff('recovery', 'boot safe-off (interrupted start, open event, or unknown DB state)');
      this.settlePumpAfterOff(await done);
    }
    let ev = firstOpen;
    for (let i = 0; i < BOOT_EVENT_LIMIT && ev; i++) {
      if (!(await this.abortEvent(ev))) break;
      try {
        ev = await bounded(this.repo.openEvent(), this.dbTimeoutMs, 'openEvent');
      } catch {
        ev = null;
      }
    }
    this.log.info({ pump: this.pump }, 'controller started');
    if (opts.autoTick) this.timer = setInterval(() => void this.tick(), this.tickMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.bus.off('reading', this.onBusReading);
    this.bus.off('settings', this.onBusSettings);
  }

  // ───── manual requests ─────

  /**
   * Operator request. Returns quickly with the Command (or a refusal). `on` is queued while the
   * pump state is unknown and started by a later tick once decide() allows it. A duplicate `id`
   * returns the existing command (duplicate:true) and sends nothing. `off` is never refused and
   * never waits on the DB before sending.
   */
  async requestManual(req: ManualRequest): Promise<ManualResult> {
    if (!this.started) throw new Error('controller not started');
    if (req.cmd === 'off') return this.requestOff(req.id);
    if (this.reservation) {
      if (req.id !== undefined && req.id === this.reservedId) {
        const r = await this.reservation;
        return r.ok ? { ok: true, command: r.command, duplicate: true } : r;
      }
      return refuse('manual_pending', 'a manual start is already being processed');
    }
    if (this.manual) {
      if (req.id !== undefined && this.manual.command.id === req.id) {
        return { ok: true, command: this.manual.command, duplicate: true };
      }
      return refuse('manual_pending', 'a manual start is already waiting for the pump');
    }
    // Reserve synchronously before the first await so concurrent `on` requests cannot both pass.
    const p = this.requestOn(req);
    this.reservation = p;
    this.reservedId = req.id;
    try {
      return await p;
    } finally {
      this.reservation = null;
      this.reservedId = undefined;
    }
  }

  private async requestOff(id?: string): Promise<ManualResult> {
    this.stopEpoch++; // synchronous: any start still in progress is abandoned
    this.commands.cancel(['pump_on'], 'superseded by manual off');
    if (this.manual) {
      const m = this.manual;
      this.manual = null;
      const c = await this.commands.closeUnsent(m.command, 'failed', 'superseded by manual off');
      this.bus.emit('pump', { state: this.pump, command: c });
    }
    const inFlight = this.commands.inFlightOf('pump_off');
    if (inFlight) return { ok: true, command: inFlight, duplicate: true }; // coalesce
    const r = this.run;
    this.forceStop(r, this.clock.now(), 'stopped');
    const sub = await this.commands.submit({ type: 'pump_off', trigger: 'manual', reason: 'operator off', id });
    if (!sub.duplicate) {
      void sub.done.then((s) => this.onOffSettled(r, 'stopped', s)).catch(this.logCatch('manual off'));
    }
    return { ok: true, command: sub.command, duplicate: sub.duplicate };
  }

  private async requestOn(req: { cmd: 'on'; duration_s: number; id?: string }): Promise<ManualResult> {
    const epoch = this.stopEpoch;
    const s = this.requireSettings();
    if (req.id !== undefined) {
      const existing = await this.commands.get(req.id); // throws if the lookup fails
      if (existing) return { ok: true, command: existing, duplicate: true };
    }
    if (!Number.isInteger(req.duration_s) || req.duration_s < 1 || req.duration_s > s.max_run_s) {
      return refuse('invalid_duration', `duration_s must be an integer 1..${s.max_run_s}`);
    }
    if (this.manual) return refuse('manual_pending', 'a manual start is already waiting for the pump');
    if (this.run || this.starting) return refuse('run_active', 'an irrigation run is in progress');
    if (this.pump === 'on') return refuse('pump_on', 'pump is already on');
    await this.refreshFromDb(this.clock.now());
    if (!this.dbHealthy) return refuse('db_unavailable', 'database unavailable; new starts are refused');
    const max_s = this.clampMaxS(req.duration_s, s, this.clock.now());
    if (max_s < 1) return refuse('daily_cap_reached', 'daily irrigation budget used up');
    if (epoch !== this.stopEpoch) return refuse('superseded', 'an OFF arrived first');
    const { command, duplicate } = await this.commands.create({
      type: 'pump_on',
      trigger: 'manual',
      reason: 'operator request',
      max_s,
      id: req.id,
    });
    if (epoch !== this.stopEpoch) {
      await this.commands.closeUnsent(command, 'failed', 'superseded by off');
      return refuse('superseded', 'an OFF arrived while the start was being recorded');
    }
    if (!duplicate) this.manual = { command, duration_s: req.duration_s };
    return { ok: true, command, duplicate };
  }

  // ───── tick ─────

  /** One control cycle. Never overlaps with itself, never throws, and is released after a deadline. */
  async tick(): Promise<void> {
    if (!this.started || this.stopped || this.ticking) return;
    this.ticking = true;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.log.error({ timeout_ms: this.tickTimeoutMs }, 'control tick exceeded its deadline; releasing');
        resolve();
      }, this.tickTimeoutMs);
    });
    try {
      await Promise.race([this.runTick(), deadline]);
    } catch (err) {
      this.log.error({ err: errMessage(err) }, 'control tick failed');
    } finally {
      if (timer) clearTimeout(timer);
      this.ticking = false;
    }
  }

  private async runTick(): Promise<void> {
    const now = this.clock.now();
    const inFlight = this.commands.inFlightCount() > 0;
    // The OFF path runs first and does not depend on any DB read.
    try {
      if (await this.guardRun(now, inFlight)) return;
    } catch (err) {
      this.log.error({ err: errMessage(err) }, 'guard failed');
    }
    await this.refreshFromDb(now);
    await this.flushPendingWrites();
    try {
      await this.expireManualIfDue(now);
    } catch (err) {
      this.log.error({ err: errMessage(err) }, 'manual expiry check failed');
    }
    const decision = this.decide(this.buildState(now, inFlight));
    try {
      await this.execute(decision, now, inFlight);
    } catch (err) {
      this.log.error({ err: errMessage(err) }, 'executing decision failed');
    }
    try {
      await this.alarms.syncRules(decision.alarms);
    } catch (err) {
      this.log.error({ err: errMessage(err) }, 'alarm sync failed');
    }
  }

  private buildState(now: number, inFlight: boolean): RulesState {
    const state: RulesState = {
      now,
      settings: this.requireSettings(),
      latest: this.latest ? { soil_pct: this.latest.soil_pct, ts: this.latest.ts } : null,
      pump: this.pump,
      runStartedAt: this.pump === 'on' && this.run ? (this.run.ackedAt ?? this.run.startSentAt) : null,
      lastRunEndedAt: this.lastRunEndedAt,
      // Completed (closed) runtime only: decide() adds the running portion itself.
      dailyRuntimeMs: this.effectiveDailyMs(now),
      commandInFlight: inFlight,
    };
    if (this.manual) state.manual = { cmd: 'on', duration_s: this.manual.duration_s };
    return state;
  }

  private async execute(d: Decision, now: number, inFlight: boolean): Promise<void> {
    switch (d.action) {
      case 'none':
        if (this.manual && !inFlight) await this.refuseManual(d.reason);
        return;
      case 'start':
        return this.onStart(d, inFlight);
      case 'stop':
        return this.onStop(d.reason, inFlight);
      case 'query':
        return this.onQuery(d.reason, now, inFlight);
    }
  }

  private async onStart(d: Extract<Decision, { action: 'start' }>, inFlight: boolean): Promise<void> {
    // `starting` is set synchronously, before any await, so overlapping ticks cannot both start.
    if (this.starting || inFlight || this.run) return;
    if (this.pump !== 'off') {
      this.log.warn({ pump: this.pump }, 'start decided while pump is not known off; ignored');
      return;
    }
    const manual = this.manual;
    if (!this.dbHealthy) {
      if (manual) await this.refuseManual('database unavailable');
      else this.log.warn('start skipped: database unavailable');
      return;
    }
    this.starting = true;
    try {
      await this.startNow(d, manual);
    } finally {
      this.starting = false;
    }
  }

  private async startNow(d: Extract<Decision, { action: 'start' }>, manual: ManualOn | null): Promise<void> {
    const epoch = this.stopEpoch;
    const trigger: 'auto' | 'manual' = manual ? 'manual' : d.trigger;
    const reason = manual ? 'operator request' : d.reason;
    const max_s = this.clampMaxS(d.max_s, this.requireSettings(), this.clock.now());
    if (max_s < 1) {
      if (manual) await this.refuseManual('daily cap reached; no runtime allowed');
      return;
    }
    let cmd: Command;
    try {
      cmd = manual ? manual.command : (await this.commands.create({ type: 'pump_on', trigger, reason, max_s })).command;
      await this.commands.prepareSend(cmd, max_s); // persisted, expiry clamped to the run window
    } catch (err) {
      this.log.error({ err: errMessage(err) }, 'could not persist start command; not sending');
      if (manual) {
        this.manual = null;
        await this.commands.closeUnsent(manual.command, 'failed', `not persisted: ${errMessage(err)}`);
      }
      return;
    }
    if (epoch !== this.stopEpoch) {
      // An OFF arrived while this start was in progress: never send it.
      this.log.warn({ id: cmd.id }, 'start superseded by OFF; not sent');
      if (manual && this.manual === manual) this.manual = null;
      await this.commands.closeUnsent(cmd, 'failed', 'superseded by off');
      return;
    }
    if (manual) this.manual = null;
    const r: ActiveRun = {
      commandId: cmd.id,
      startSentAt: this.clock.now(),
      max_s,
      trigger,
      reason,
      eventId: null,
      opening: null,
      ackedAt: null,
      closed: false,
      closedAt: null,
      chargedUntil: null,
      rowClosed: false,
    };
    this.run = r;
    this.commands
      .dispatch(cmd)
      .then((s) => this.onStartSettled(r, s))
      .catch(this.logCatch('start'));
  }

  private async onStop(reason: string, inFlight: boolean): Promise<void> {
    if (inFlight || this.commands.inFlightOf('pump_off')) return;
    this.stopEpoch++;
    const r = this.run;
    this.forceStop(r, this.clock.now(), 'completed');
    const { done } = await this.issueOff('auto', reason);
    void done.then((s) => this.onOffSettled(r, 'completed', s)).catch(this.logCatch('stop'));
  }

  private async onQuery(reason: string, now: number, inFlight: boolean): Promise<void> {
    if (inFlight || now < this.cooldownUntil) return;
    const sub = await this.commands.submit({ type: 'pump_query', trigger: 'recovery', reason });
    void sub.done.then((s) => this.onQuerySettled(s)).catch(this.logCatch('query'));
  }

  /**
   * Forces OFF when a run is overdue (max_s + grace, even if an ON is still in flight) or while OFF
   * is unconfirmed. Never waits on the DB. Returns true when it acted this tick.
   */
  private async guardRun(now: number, inFlight: boolean): Promise<boolean> {
    const r = this.run;
    const overdue = r !== null && now >= r.startSentAt + r.max_s * 1000 + GUARD_GRACE_MS;
    if (!overdue && !this.offPending) return false;
    if (!overdue && inFlight) return false;
    if (this.commands.inFlightOf('pump_off')) return false; // an OFF is already on its way
    if (now < this.guardNextAt) return false;
    if (overdue) this.commands.cancel(['pump_on'], 'run overdue; forced off');
    // Exponential retry: 5 s, 10 s, 20 s, ... capped at 60 s. Each OFF delivery is bounded by retries.
    this.guardNextAt = now + this.guardBackoffMs;
    this.guardBackoffMs = Math.min(GUARD_BACKOFF_CAP_MS, this.guardBackoffMs * 2);
    this.offPending = false;
    this.stopEpoch++;
    this.forceStop(r, now, 'stopped');
    this.log.warn({ overdue, command: r?.commandId ?? null, next_in_ms: this.guardNextAt - now }, 'forcing pump OFF');
    const { done } = await this.issueOff('recovery', overdue ? 'max runtime guard' : 'retry unconfirmed OFF');
    // A guard-forced stop is recorded as 'stopped' (not a normal completion).
    void done.then((s) => this.onOffSettled(r, 'stopped', s)).catch(this.logCatch('guard'));
    return true;
  }

  private async expireManualIfDue(now: number): Promise<void> {
    const m = this.manual;
    if (!m || now < Date.parse(m.command.expires_at)) return;
    this.manual = null;
    const c = await this.commands.closeUnsent(m.command, 'expired', 'not started before expiry');
    this.bus.emit('pump', { state: this.pump, command: c });
    this.log.warn({ id: c.id }, 'manual request expired before the pump could be started');
  }

  private async refuseManual(reason: string): Promise<void> {
    const m = this.manual;
    if (!m) return;
    this.manual = null;
    const c = await this.commands.closeUnsent(m.command, 'failed', `refused: ${reason}`);
    this.bus.emit('pump', { state: this.pump, command: c });
    this.log.info({ id: c.id, reason }, 'manual on refused');
  }

  // ───── command settlement handlers ─────

  private async onStartSettled(r: ActiveRun, s: Settled): Promise<void> {
    const now = this.clock.now();
    const cmd = s.command;
    const closed = this.run !== r || this.commands.isCancelled(cmd.id);

    if (cmd.state === 'acked' && s.ack?.pump === 'on') {
      r.ackedAt = now;
      if (closed) {
        // Late ack: the run was already closed or superseded. Never claim 'on'; stop it again.
        await this.lateOn(r, now);
        return;
      }
      // Pump state is set before the row insert is awaited (ack and state are not delayed by the DB).
      this.setPump('on', cmd);
      r.opening = this.insertRow(
        { ts_start: iso(now), ts_end: null, trigger: r.trigger, reason: r.reason, result: 'running' },
        false, // a failed 'running' insert is not retried: closeRun writes the complete row instead
      );
      const id = await r.opening;
      r.opening = null;
      if (id !== null && r.eventId === null) r.eventId = id;
      return;
    }

    // Never sent at all: nothing can have started.
    if (cmd.attempts === 0 && (cmd.state === 'expired' || cmd.state === 'failed')) {
      if (this.run === r) this.run = null;
      this.log.warn({ id: cmd.id, state: cmd.state, reason: cmd.last_error }, 'start never sent; no run');
      return;
    }

    // Sent but not confirmed (failed, expired after attempts, or ack says not on): may be running.
    if (closed) {
      this.offPending = true; // guard re-issues OFF on the next tick
      this.log.error({ id: cmd.id }, 'unconfirmed start on a closed run; OFF will be retried');
      return;
    }
    this.setPump('unknown', cmd);
    this.cooldownUntil = now + QUERY_COOLDOWN_MS;
    this.log.error({ id: cmd.id, reason: cmd.last_error }, 'start not confirmed; attempting safe OFF');
    const { done } = await this.issueOff('recovery', 'best-effort off after unconfirmed start');
    void done.then((s2) => this.onOffSettled(r, 'failed', s2)).catch(this.logCatch('best-effort off'));
  }

  private async lateOn(r: ActiveRun, now: number): Promise<void> {
    this.log.error({ command: r.commandId }, 'start acknowledged after its run was closed or cancelled; forcing OFF');
    const wasClosed = r.closed;
    r.closed = true;
    if (r.opening) {
      const got = await r.opening;
      r.opening = null;
      if (got !== null) r.eventId = got;
    }
    const endIso = iso(now);
    // Extend the existing row to the late ack time (or write it if none exists).
    if (r.eventId !== null) {
      await this.updateRow(r.eventId, { ts_end: endIso, result: 'stopped' });
    } else {
      r.eventId = await this.insertRow({
        ts_start: iso(r.startSentAt),
        ts_end: endIso,
        trigger: r.trigger,
        reason: `${r.reason}; late start acknowledgement`,
        result: 'stopped',
      });
    }
    this.chargeRun(r, now);
    if (this.run === r) this.run = null;
    this.setPump('unknown');
    const { done } = await this.issueOff('recovery', 'late start acknowledgement; safe OFF');
    void done.then((s) => this.onOffSettled(null, 'stopped', s)).catch(this.logCatch('late on'));
  }

  private async onOffSettled(r: ActiveRun | null, result: IrrigationResult, s: Settled): Promise<void> {
    const now = this.clock.now();
    // Only an ack that explicitly reports 'off' counts as off.
    if (s.command.state === 'acked' && s.ack?.pump === 'off') {
      this.offPending = false;
      this.guardBackoffMs = GUARD_RETRY_MS;
      this.lastRunEndedAt = now;
      this.setPump('off', s.command);
      if (r && this.run === r) {
        this.run = null;
        await this.closeRun(r, result, now);
      }
      return;
    }
    this.setPump('unknown', s.command);
    this.offPending = true;
    this.cooldownUntil = now + QUERY_COOLDOWN_MS;
    this.log.error(
      { id: s.command.id, state: s.command.state, pump: s.ack?.pump ?? null, reason: s.command.last_error },
      'OFF not confirmed as off; pump state unknown, OFF will be re-sent',
    );
  }

  private async onQuerySettled(s: Settled): Promise<void> {
    if (s.command.state !== 'acked' || !s.ack) {
      this.setPump('unknown', s.command);
      this.cooldownUntil = this.clock.now() + QUERY_COOLDOWN_MS;
      return;
    }
    const r = this.run;
    if (s.ack.pump === 'off') {
      this.setPump('off');
      this.offPending = false;
      this.guardBackoffMs = GUARD_RETRY_MS;
      if (r && this.run === r) {
        this.run = null;
        this.lastRunEndedAt = this.clock.now();
        await this.closeRun(r, 'completed', this.clock.now());
      }
      return;
    }
    // Pump reports ON with no known start: never leave it running. The guard issues the OFF on its
    // backoff schedule (coalesced), instead of a new OFF per query.
    this.setPump('unknown');
    this.offPending = true;
    this.log.warn({ command_id: s.ack.command_id }, 'query reports pump on; OFF scheduled by guard');
    if (r) this.forceStop(r, this.clock.now(), 'stopped');
  }

  // ───── readings & jump filter ─────

  private async onReading(r: Reading): Promise<void> {
    const ts = Date.parse(r.ts);
    if (!Number.isFinite(ts)) {
      this.log.warn({ ts: r.ts }, 'reading with invalid timestamp ignored');
      return;
    }
    const next: SoilPoint = { soil_pct: r.soil_pct, ts };
    const settings = this.requireSettings();
    const verdict = this.assess(this.latest, next, settings);
    if (verdict.accept) {
      this.latest = next;
      this.rejected = [];
      // A fresh reading ends a stale condition now, not at the next tick.
      await this.alarms.clear('sensor_stale');
      if (!this.soilNotice || ts >= this.noticeUntil) {
        this.soilNotice = false;
        await this.alarms.clear('soil_jump_ignored');
      }
      return;
    }

    this.rejected.push(next);
    if (this.rejected.length > JUMP_HISTORY) this.rejected.shift();
    this.log.warn(
      { soil_pct: next.soil_pct, baseline: this.latest?.soil_pct ?? null, reason: verdict.reason },
      'soil reading rejected by jump filter',
    );
    await this.alarms.raise('soil_jump_ignored', `Implausible soil reading ignored: ${verdict.reason}`, 'warn');

    // Latch: a genuine step change keeps being rejected against the old baseline. Re-baseline only
    // when the rejected readings agree with each other AND span at least JUMP_MIN_SPAN_MS.
    if (this.rejected.length < JUMP_CONFIRM_READINGS) return;
    const values = this.rejected.map((p) => p.soil_pct);
    const spread = Math.max(...values) - Math.min(...values);
    const oldest = this.rejected[0]!;
    const newest = this.rejected[this.rejected.length - 1]!;
    const span = newest.ts - oldest.ts;
    if (spread > settings.max_soil_jump_pct / 4 || span < JUMP_MIN_SPAN_MS) return;

    this.latest = newest;
    this.rejected = [];
    this.log.error(
      { soil_pct: newest.soil_pct, spread, span_ms: span },
      'jump filter re-baselined on sustained step change; verify sensor and calibration',
    );
    await this.alarms.clear('soil_jump_ignored');
    await this.alarms.raise(
      'soil_jump_ignored',
      `Soil baseline re-established at ${newest.soil_pct.toFixed(1)} % after a sustained step change; verify sensor`,
      'warn',
    );
    this.soilNotice = true;
    this.noticeUntil = newest.ts + REBASELINE_NOTICE_MS;
  }

  // ───── restart ─────

  /** Aborts one open event. Returns false when the write could not be made (it is queued for retry). */
  private async abortEvent(ev: IrrigationEvent & { id: number }): Promise<boolean> {
    const patch = { ts_end: iso(this.clock.now()), result: 'aborted' as const };
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await bounded(this.repo.updateEvent(ev.id, patch), this.dbTimeoutMs, 'updateEvent');
        // The aborted run ended at the restart instant: min_interval counts from there.
        this.lastRunEndedAt = Math.max(this.lastRunEndedAt ?? 0, this.clock.now());
        this.bus.emit('event', { ...ev, ...patch });
        this.log.warn({ event_id: ev.id }, 'open irrigation event safe-closed after restart (aborted)');
        return true;
      } catch (err) {
        this.log.error({ event_id: ev.id, attempt, err: errMessage(err) }, 'could not record aborted event');
      }
    }
    this.queueWrite({ kind: 'update', id: ev.id, patch });
    return false;
  }

  private settlePumpAfterOff(s: Settled): void {
    if (s.command.state === 'acked' && s.ack?.pump === 'off') {
      this.offPending = false;
      this.guardBackoffMs = GUARD_RETRY_MS;
      this.setPump('off', s.command);
    } else {
      this.offPending = true;
      this.setPump('unknown', s.command);
    }
  }

  // ───── helpers ─────

  private setPump(state: PumpState, command?: Command): void {
    this.pump = state;
    this.bus.emit('pump', command ? { state, command } : { state });
  }

  private async issueOff(trigger: Trigger, reason: string): Promise<{ done: Promise<Settled> }> {
    const sub = await this.commands.submit({ type: 'pump_off', trigger, reason });
    return { done: sub.done };
  }

  /** Insert an irrigation event. Returns the id, or null (queued for retry when `retry` is set). */
  private async insertRow(row: Omit<IrrigationEvent, 'id'>, retry = true): Promise<number | null> {
    if (this.repoDown()) {
      if (retry) this.queueWrite({ kind: 'insert', row });
      return null;
    }
    try {
      const id = await bounded(this.repo.insertEvent(row), this.dbTimeoutMs, 'insertEvent');
      this.bus.emit('event', { ...row, id });
      return id;
    } catch (err) {
      this.log.error({ err: errMessage(err) }, 'irrigation event insert failed');
      if (retry) this.queueWrite({ kind: 'insert', row });
      return null;
    }
  }

  private async updateRow(id: number, patch: Partial<IrrigationEvent>): Promise<void> {
    if (this.repoDown()) {
      this.queueWrite({ kind: 'update', id, patch });
      return;
    }
    try {
      await bounded(this.repo.updateEvent(id, patch), this.dbTimeoutMs, 'updateEvent');
    } catch (err) {
      this.log.error({ event_id: id, err: errMessage(err) }, 'irrigation event update failed; queued for retry');
      this.queueWrite({ kind: 'update', id, patch });
    }
  }

  private queueWrite(op: PendingWrite): void {
    if (this.pendingWrites.length >= PENDING_WRITES_CAP) {
      const dropped = this.pendingWrites.shift();
      this.log.error({ dropped: dropped?.kind, cap: PENDING_WRITES_CAP }, 'pending event-write queue full; oldest dropped');
    }
    this.pendingWrites.push(op);
  }

  /** Retry queued event writes (in order); stops at the first failure. Runs only when the DB is healthy. */
  private async flushPendingWrites(): Promise<void> {
    if (!this.dbHealthy || this.pendingWrites.length === 0) return;
    const ops = this.pendingWrites.splice(0);
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!;
      try {
        if (op.kind === 'update') {
          await bounded(this.repo.updateEvent(op.id, op.patch), this.dbTimeoutMs, 'updateEvent');
        } else {
          const id = await bounded(this.repo.insertEvent(op.row), this.dbTimeoutMs, 'insertEvent');
          this.bus.emit('event', { ...op.row, id });
        }
      } catch (err) {
        this.log.warn({ err: errMessage(err) }, 'queued event write still failing; will retry');
        this.pendingWrites.unshift(...ops.slice(i));
        return;
      }
    }
  }

  /**
   * Close a run after its OFF is acknowledged. Runtime was already charged at any forced stop, so
   * chargeRun() only adds what is new (no double count). The row is written unless it was closed at
   * a forced stop.
   */
  private async closeRun(r: ActiveRun, result: IrrigationResult, endMs: number): Promise<void> {
    if (r.closed) return;
    r.closed = true;
    r.closedAt = endMs;
    if (r.opening) {
      const got = await r.opening;
      r.opening = null;
      if (got !== null) r.eventId = got;
    }
    this.chargeRun(r, endMs);
    if (!r.rowClosed) {
      r.rowClosed = true;
      await this.writeRow(r, result, endMs);
    }
  }

  /**
   * A run is force-stopped (guard, max runtime, stop decision, manual OFF): charge its runtime now,
   * and close its irrigation_events row best-effort. The pump state stays 'unknown' until OFF is acked.
   */
  private forceStop(r: ActiveRun | null, now: number, result: IrrigationResult): void {
    if (!r || r.closed) return;
    this.chargeRun(r, now);
    if (r.rowClosed || r.opening) return; // an insert in progress is completed by closeRun
    r.rowClosed = true;
    void this.writeRow(r, result, now).catch(this.logCatch('forced stop row'));
  }

  /** Write the run's row as closed. Creates it if it was never written (unacked start, or failed insert). */
  private async writeRow(r: ActiveRun, result: IrrigationResult, endMs: number): Promise<void> {
    if (r.eventId !== null) {
      await this.updateRow(r.eventId, { ts_end: iso(endMs), result });
      this.bus.emit('event', {
        id: r.eventId,
        ts_start: iso(r.ackedAt ?? r.startSentAt),
        ts_end: iso(endMs),
        trigger: r.trigger,
        reason: r.reason,
        result,
      });
    } else if (r.ackedAt !== null) {
      // Acknowledged, but the insert at ack time failed: record the real run, not an unacked start.
      r.eventId = await this.insertRow({
        ts_start: iso(r.ackedAt),
        ts_end: iso(endMs),
        trigger: r.trigger,
        reason: `${r.reason}; event recorded at close`,
        result,
      });
    } else {
      // Start never acknowledged, but the pump may have run until its own timer. Recorded as 'failed'
      // with runtime counted up to the stop, so the daily budget stays conservative.
      r.eventId = await this.insertRow({
        ts_start: iso(r.startSentAt),
        ts_end: iso(endMs),
        trigger: r.trigger,
        reason: `${r.reason}; start not acknowledged`,
        result: 'failed',
      });
    }
  }

  /** Runtime of a run is physically bounded by its own timer: never charge past start + max_s (+grace). */
  private runCapMs(r: ActiveRun): number {
    return r.startSentAt + r.max_s * 1000 + GUARD_GRACE_MS;
  }

  /** Charge the run's runtime up to `untilMs` (capped), counting only the part not yet charged. */
  private chargeRun(r: ActiveRun, untilMs: number): void {
    const to = Math.min(untilMs, this.runCapMs(r));
    const from = r.chargedUntil ?? r.ackedAt ?? r.startSentAt;
    if (to > from) {
      this.addDailyMs(from, to);
      r.chargedUntil = to;
    }
  }

  private addDailyMs(fromMs: number, toMs: number): void {
    if (toMs <= fromMs) return;
    const day = localDayStart(toMs);
    if (this.memDay !== day) {
      this.memDay = day;
      this.memMs = 0;
    }
    this.memMs += toMs - fromMs;
  }

  /** max(DB closed runtime today, runtime closed by this process today). Never a sum: no double count. */
  private effectiveDailyMs(now: number): number {
    const mem = this.memDay === localDayStart(now) ? this.memMs : 0;
    return Math.max(this.dbDailyMs, mem);
  }

  private repoDown(): boolean {
    const r = this.repo as { isDown?: () => boolean };
    return typeof r.isDown === 'function' && r.isDown();
  }

  /** Refresh cached settings and closed-runtime. Never throws. Skips DB reads while the repo is down. */
  private async refreshFromDb(now: number): Promise<void> {
    if (this.repoDown()) {
      this.dbHealthy = false;
      return;
    }
    let ok = true;
    try {
      this.settings = await bounded(this.repo.getSettings(), this.dbTimeoutMs, 'getSettings');
    } catch (err) {
      ok = false;
      this.log.warn({ err: errMessage(err) }, 'settings refresh failed; using cached settings');
    }
    try {
      const secs = await bounded(
        this.repo.closedRuntimeSecondsSince(localDayStart(now)),
        this.dbTimeoutMs,
        'closedRuntimeSecondsSince',
      );
      this.dbDailyMs = Math.max(0, secs) * 1000;
    } catch (err) {
      ok = false;
      this.log.warn({ err: errMessage(err) }, 'daily runtime read failed; using last known value');
    }
    this.dbHealthy = ok;
  }

  private async loadSettingsOrDefault(): Promise<Settings> {
    try {
      const s = await bounded(this.repo.getSettings(), this.dbTimeoutMs, 'getSettings');
      this.dbHealthy = true;
      return s;
    } catch (err) {
      this.dbHealthy = false;
      this.log.error({ err: errMessage(err) }, 'settings unavailable at boot; using defaults');
      return { ...SETTINGS_DEFAULTS };
    }
  }

  private clampMaxS(requested: number, s: Settings, now: number): number {
    const remainingS = Math.floor(Math.max(0, s.daily_max_s * 1000 - this.effectiveDailyMs(now)) / 1000);
    return Math.floor(Math.min(requested, s.max_run_s, remainingS, MAX_RUN_S));
  }

  private requireSettings(): Settings {
    if (!this.settings) throw new Error('controller settings not loaded (call start first)');
    return this.settings;
  }

  private logCatch(what: string): (err: unknown) => void {
    return (err: unknown) => this.log.error({ err: errMessage(err), what }, 'controller background task failed');
  }
}

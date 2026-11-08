import { randomUUID } from 'node:crypto';
import type { Logger } from '../log.js';
import type {
  ActuatorAck,
  ActuatorAdapter,
  Alarm,
  AlarmCode,
  Command,
  CommandState,
  CommandType,
  Repo,
  Settings,
  Trigger,
} from '../types.js';
import { bounded } from './bounded.js';
import { ActuatorExpiredError, MAX_RUN_S } from './adapter.js';
import { iso, type Clock } from './clock.js';

/** Alarm sink (implemented by controller AlarmBoard). Commands never talk to the bus directly. */
export interface AlarmSink {
  raise(code: AlarmCode, message: string, severity?: Alarm['severity']): Promise<void>;
  clear(code: AlarmCode): Promise<void>;
  /** Clear only if the alarm has been active for at least minAgeMs. */
  clearIfStale(code: AlarmCode, minAgeMs: number): Promise<void>;
}

export interface Settled {
  command: Command;
  ack: ActuatorAck | null;
}

export interface NewCommand {
  /** Idempotency key. Same id => existing command returned, nothing re-sent. */
  id?: string;
  type: CommandType;
  trigger: Trigger;
  reason: string;
  max_s?: number | null;
}

export interface Submitted {
  command: Command;
  duplicate: boolean;
  /** Resolves when the command reaches a terminal state (acked/failed/expired). */
  done: Promise<Settled>;
}

export interface CommandManagerDeps {
  repo: Repo;
  adapter: ActuatorAdapter;
  clock: Clock;
  alarms: AlarmSink;
  log: Logger;
  /** Cached, synchronous settings. Never awaits the DB (safety path must not depend on it). */
  getSettings: () => Settings;
  /** Upper bound for any single repo call (ms, real time). */
  dbTimeoutMs?: number;
}

const TERMINAL: ReadonlySet<CommandState> = new Set(['acked', 'failed', 'expired']);
const PUMP_TYPES: ReadonlySet<CommandType> = new Set(['pump_on', 'pump_off']);
/** Terminal entries kept in memory (cache/acks/cancel flags); older ones are dropped. */
export const TERMINAL_CACHE_LIMIT = 200;
/** Detached (non-blocking) persists queued at once; beyond this, OFF persistence is dropped (logged). */
export const DETACHED_PERSIST_CAP = 50;
/**
 * pump_failed latches: only a successful pump_on clears it, or an OFF/query ack once it has been
 * active at least this long.
 */
export const PUMP_FAILED_LATCH_MS = 15 * 60 * 1000;

/** Backoff before retry n+1 after n failed attempts: 500, 1000, 2000 ... capped at 4 s. */
export function backoffMs(attempts: number): number {
  return Math.min(4000, 500 * 2 ** Math.max(0, attempts - 1));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Owns command lifecycle: create (persisted) → send (retry with backoff, never after expiry)
 * → acked | failed (+alarms) | expired. Duplicate ids are idempotent.
 *
 * DB policy: pump_on persists are awaited (bounded) before sending. Safety commands
 * (pump_off, pump_query) persist fire-and-forget, so a hung DB never delays an OFF.
 */
export class CommandManager {
  private readonly cache = new Map<string, Command>();
  private readonly running = new Map<string, Promise<Settled>>();
  private readonly acks = new Map<string, ActuatorAck>();
  private readonly cancelled = new Map<string, string>();
  private readonly terminalOrder: string[] = [];
  private readonly dbTimeoutMs: number;
  private detachedQueued = 0;

  constructor(private readonly deps: CommandManagerDeps) {
    this.dbTimeoutMs = deps.dbTimeoutMs ?? 2000;
  }

  /** Number of commands currently being delivered (sent or retrying). */
  inFlightCount(): number {
    return this.running.size;
  }

  /** True when cancel() flagged this command (manual OFF superseded a start). */
  isCancelled(id: string): boolean {
    return this.cancelled.has(id);
  }

  /** Entries currently held in memory (bounded by TERMINAL_CACHE_LIMIT once terminal). */
  trackedCount(): number {
    return this.cache.size;
  }

  /** The in-flight command of this type (copy), if any. Used to coalesce repeated OFFs. */
  inFlightOf(type: CommandType): Command | null {
    for (const id of this.running.keys()) {
      const c = this.cache.get(id);
      if (c && c.type === type) return { ...c };
    }
    return null;
  }

  /**
   * Lookup by idempotency id. THROWS when the DB lookup fails: an unknown id must never be
   * treated as new while the DB is unavailable (caller retries).
   */
  async get(id: string): Promise<Command | null> {
    const cached = this.cache.get(id);
    if (cached) return { ...cached };
    const hit = await bounded(this.deps.repo.getCommand(id), this.dbTimeoutMs, 'getCommand');
    if (!hit) return null;
    this.cache.set(id, hit);
    return { ...hit };
  }

  /**
   * Create and persist a command WITHOUT sending it. Duplicate id → existing, duplicate=true.
   * pump_on persist failure throws (never start unpersisted).
   */
  async create(input: NewCommand): Promise<{ command: Command; duplicate: boolean }> {
    if (input.id !== undefined) {
      const existing = await this.get(input.id);
      if (existing) {
        if (existing.type !== input.type) {
          this.deps.log.warn(
            { id: input.id, requested: input.type, existing: existing.type },
            'duplicate command id with different type; returning existing command',
          );
        }
        return { command: existing, duplicate: true };
      }
    }
    const max_s = input.type === 'pump_on' ? (input.max_s ?? null) : null;
    if (input.type === 'pump_on' && (max_s === null || !Number.isInteger(max_s) || max_s < 1 || max_s > MAX_RUN_S)) {
      throw new RangeError(`pump_on max_s must be an integer 1..${MAX_RUN_S}, got ${String(max_s)}`);
    }
    const settings = this.deps.getSettings();
    const now = this.deps.clock.now();
    const command: Command = {
      id: input.id ?? randomUUID(),
      ts: iso(now),
      type: input.type,
      state: 'pending',
      expires_at: iso(now + settings.command_expiry_s * 1000),
      ack_ts: null,
      max_s,
      attempts: 0,
      trigger: input.trigger,
      reason: input.reason,
      last_error: null,
    };
    this.cache.set(command.id, command);
    if (input.type === 'pump_on') {
      try {
        await bounded(this.deps.repo.upsertCommand({ ...command }), this.dbTimeoutMs, 'upsertCommand');
      } catch (err) {
        this.cache.delete(command.id);
        throw err;
      }
    } else {
      this.persistDetached(command);
    }
    return { command, duplicate: false };
  }

  /** Create + start delivery. Duplicate id returns the existing command; no second send. */
  async submit(input: NewCommand): Promise<Submitted> {
    const { command, duplicate } = await this.create(input);
    if (duplicate) {
      const done = this.running.get(command.id) ?? Promise.resolve(this.settledOf(command));
      return { command, duplicate, done };
    }
    return { command, duplicate, done: this.dispatch(command) };
  }

  /**
   * Set max_s on a still-pending command before it is sent (persisted before send). The expiry is
   * clamped to now + max_s, so a start is never sent after its own run window has ended.
   */
  async prepareSend(cmd: Command, max_s: number): Promise<void> {
    const cur = this.cache.get(cmd.id) ?? cmd;
    if (cur.state !== 'pending' || this.running.has(cur.id)) {
      throw new Error(`command ${cur.id} is ${cur.state}; cannot prepare for send`);
    }
    cur.max_s = max_s;
    const cap = this.deps.clock.now() + max_s * 1000;
    if (Date.parse(cur.expires_at) > cap) cur.expires_at = iso(cap);
    await bounded(this.deps.repo.upsertCommand({ ...cur }), this.dbTimeoutMs, 'upsertCommand');
  }

  /** Close a command that was never sent (pending). No-op if already dispatched. */
  async closeUnsent(cmd: Command, state: 'failed' | 'expired', message: string): Promise<Command> {
    const cur = this.cache.get(cmd.id) ?? cmd;
    if (cur.state !== 'pending' || this.running.has(cur.id)) return { ...cur };
    await this.closeOpen(cur, state, message);
    return { ...cur };
  }

  /** Start delivery of an existing persisted pending command (idempotent while running). */
  dispatch(cmd: Command): Promise<Settled> {
    const live = this.running.get(cmd.id);
    if (live) return live;
    const current = this.cache.get(cmd.id) ?? cmd;
    if (TERMINAL.has(current.state)) return Promise.resolve(this.settledOf(current));
    this.cache.set(current.id, current);
    const p = this.loop(current).finally(() => {
      this.running.delete(current.id);
    });
    this.running.set(current.id, p);
    return p;
  }

  /** Stop retrying in-flight commands of the given types. Returns how many were flagged. */
  cancel(types: CommandType[], reason: string): number {
    let n = 0;
    for (const id of this.running.keys()) {
      const c = this.cache.get(id);
      if (c && types.includes(c.type)) {
        this.cancelled.set(id, reason);
        n++;
      }
    }
    return n;
  }

  /**
   * Startup: reload open commands. Expired → expired. pump_on → failed, never re-sent, and
   * always returned (even if expired) so the controller sends a safe OFF. Others → re-dispatched
   * with the same id.
   */
  async recover(): Promise<Command[]> {
    const open = await bounded(this.deps.repo.openCommands(), this.dbTimeoutMs, 'openCommands');
    const now = this.deps.clock.now();
    const interruptedOn: Command[] = [];
    for (const c of open) {
      if (this.running.has(c.id)) continue;
      this.cache.set(c.id, c);
      if (c.type === 'pump_on') {
        interruptedOn.push(c);
        const expired = now >= Date.parse(c.expires_at);
        await this.closeOpen(c, expired ? 'expired' : 'failed', expired ? 'expired before restart' : 'interrupted by restart; not re-sent');
        continue;
      }
      if (now >= Date.parse(c.expires_at)) {
        await this.closeOpen(c, 'expired', 'expired before restart');
        continue;
      }
      this.dispatch(c).catch((err: unknown) => {
        this.deps.log.error({ id: c.id, err: errMessage(err) }, 'recovered command failed to run');
      });
    }
    return interruptedOn;
  }

  // ───── internals ─────

  private settledOf(command: Command): Settled {
    return { command: { ...command }, ack: this.acks.get(command.id) ?? null };
  }

  /** Persist without blocking the caller (safety commands). Errors are logged. */
  private persistDetached(cmd: Command): void {
    if (cmd.type === 'pump_off' && this.detachedQueued >= DETACHED_PERSIST_CAP) {
      this.deps.log.error({ id: cmd.id, queued: this.detachedQueued }, 'detached persist queue full; OFF persistence dropped');
      return;
    }
    this.detachedQueued++;
    const snapshot = { ...cmd };
    Promise.resolve()
      .then(() => bounded(this.deps.repo.upsertCommand(snapshot), this.dbTimeoutMs, 'upsertCommand'))
      .catch((err: unknown) => {
        this.deps.log.error({ id: cmd.id, err: errMessage(err) }, 'command persist failed (not blocking)');
      })
      .finally(() => {
        this.detachedQueued--;
      });
  }

  /** Persist: pump_on awaited (bounded); other types detached so the OFF is never delayed. */
  private async persist(cmd: Command): Promise<void> {
    if (cmd.type !== 'pump_on') {
      this.persistDetached(cmd);
      return;
    }
    try {
      await bounded(this.deps.repo.upsertCommand({ ...cmd }), this.dbTimeoutMs, 'upsertCommand');
    } catch (err) {
      this.deps.log.error({ id: cmd.id, err: errMessage(err) }, 'command persist failed');
    }
  }

  private async closeOpen(cmd: Command, state: 'failed' | 'expired', message: string): Promise<void> {
    cmd.state = state;
    cmd.last_error = message;
    this.cache.set(cmd.id, cmd);
    this.markTerminal(cmd.id);
    await this.persist(cmd);
    this.deps.log.warn({ id: cmd.id, type: cmd.type, state, reason: message }, 'command closed');
  }

  /** Keep only the most recent TERMINAL_CACHE_LIMIT terminal entries in memory. */
  private markTerminal(id: string): void {
    this.terminalOrder.push(id);
    const deferred: string[] = [];
    while (this.terminalOrder.length > TERMINAL_CACHE_LIMIT) {
      const old = this.terminalOrder.shift();
      if (old === undefined) break;
      // Still delivering: keep it in the order so it is evicted once it has settled.
      if (this.running.has(old)) {
        deferred.push(old);
        continue;
      }
      this.cache.delete(old);
      this.acks.delete(old);
      this.cancelled.delete(old);
    }
    if (deferred.length > 0) this.terminalOrder.unshift(...deferred);
  }

  private async loop(cmd: Command): Promise<Settled> {
    const { adapter, clock, log } = this.deps;
    const maxAttempts = Math.max(1, this.deps.getSettings().command_max_retries);
    for (;;) {
      const cancelReason = this.cancelled.get(cmd.id);
      if (cancelReason !== undefined) return this.fail(cmd, `cancelled: ${cancelReason}`, false);
      if (cmd.attempts >= maxAttempts) {
        return this.fail(cmd, cmd.last_error ?? 'no acknowledgement', true);
      }
      // Hard rule: never send at or after expires_at.
      const expMs = Date.parse(cmd.expires_at);
      if (clock.now() >= expMs) return this.expire(cmd, 'expired before send');

      const attemptsBefore = cmd.attempts;
      const stateBefore = cmd.state;
      cmd.attempts += 1;
      cmd.state = 'sent';
      await this.persist(cmd);

      // Re-check after the persist await: a cancel or the expiry may have happened meanwhile.
      const lateCancel = this.cancelled.get(cmd.id);
      if (lateCancel !== undefined || clock.now() >= expMs) {
        cmd.attempts = attemptsBefore;
        cmd.state = stateBefore;
        if (lateCancel !== undefined) return this.fail(cmd, `cancelled: ${lateCancel}`, false);
        return this.expire(cmd, 'expired before send (checked after persist)');
      }

      try {
        const ack = cmd.type === 'pump_query' ? await adapter.query() : await adapter.send(cmd);
        return await this.ack(cmd, ack);
      } catch (err) {
        const msg = errMessage(err);
        if (err instanceof ActuatorExpiredError) return this.expire(cmd, msg);
        cmd.last_error = msg;
        log.warn(
          { id: cmd.id, type: cmd.type, attempt: cmd.attempts, max: maxAttempts, err: msg },
          'actuator attempt failed',
        );
        if (cmd.attempts < maxAttempts) await clock.sleep(backoffMs(cmd.attempts));
      }
    }
  }

  private async ack(cmd: Command, ack: ActuatorAck): Promise<Settled> {
    cmd.state = 'acked';
    cmd.ack_ts = iso(this.deps.clock.now());
    cmd.last_error = null;
    this.acks.set(cmd.id, ack);
    this.markTerminal(cmd.id);
    await this.persist(cmd);
    await this.deps.alarms.clear('actuator_unreachable');
    if (cmd.type === 'pump_on') await this.deps.alarms.clear('pump_failed');
    else await this.deps.alarms.clearIfStale('pump_failed', PUMP_FAILED_LATCH_MS);
    this.deps.log.info({ id: cmd.id, type: cmd.type, pump: ack.pump }, 'command acked');
    return { command: { ...cmd }, ack };
  }

  private async expire(cmd: Command, message: string): Promise<Settled> {
    cmd.state = 'expired';
    cmd.last_error = message;
    this.markTerminal(cmd.id);
    await this.persist(cmd);
    this.deps.log.warn({ id: cmd.id, type: cmd.type, attempts: cmd.attempts, reason: message }, 'command expired');
    return { command: { ...cmd }, ack: null };
  }

  private async fail(cmd: Command, message: string, raiseAlarm: boolean): Promise<Settled> {
    cmd.state = 'failed';
    cmd.last_error = message;
    this.markTerminal(cmd.id);
    await this.persist(cmd);
    this.deps.log.error({ id: cmd.id, type: cmd.type, attempts: cmd.attempts, reason: message }, 'command failed');
    if (raiseAlarm) {
      const detail = `${cmd.type} ${cmd.id}: no acknowledgement after ${cmd.attempts} attempt(s)`;
      await this.deps.alarms.raise('actuator_unreachable', detail, 'critical');
      if (PUMP_TYPES.has(cmd.type)) await this.deps.alarms.raise('pump_failed', detail, 'critical');
    }
    return { command: { ...cmd }, ack: null };
  }
}

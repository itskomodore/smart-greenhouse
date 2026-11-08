import type { Pool } from 'pg';
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

const SETTINGS_KEYS = Object.keys(SETTINGS_DEFAULTS) as (keyof Settings)[];
const ISO_FIELDS_EVENT = ['ts_start', 'ts_end', 'trigger', 'reason', 'result'] as const;
const DEFAULT_READ_LIMIT = 1000;
const MAX_READ_LIMIT = 5000;

/** pg returns timestamptz as Date; contract uses ISO-8601 UTC strings at the DB edge. */
function iso(v: Date | string): string;
function iso(v: Date | string | null): string | null;
function iso(v: Date | string | null): string | null {
  if (v === null) return null;
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

function toReading(r: Record<string, unknown>): Reading {
  return {
    id: Number(r.id),
    node_id: r.node_id as string,
    ts: iso(r.ts as Date),
    t: Number(r.t),
    rh: Number(r.rh),
    light_raw: Number(r.light_raw),
    soil_raw: Number(r.soil_raw),
    soil_pct: Number(r.soil_pct),
    light_pct: Number(r.light_pct),
  };
}

function toCommand(r: Record<string, unknown>): Command {
  return {
    id: r.id as string,
    ts: iso(r.ts as Date),
    type: r.type as Command['type'],
    state: r.state as Command['state'],
    expires_at: iso(r.expires_at as Date),
    ack_ts: iso(r.ack_ts as Date | null),
    max_s: r.max_s === null ? null : Number(r.max_s),
    attempts: Number(r.attempts),
    trigger: r.trigger as Command['trigger'],
    reason: r.reason as string,
    last_error: (r.last_error as string | null) ?? null,
  };
}

function toEvent(r: Record<string, unknown>): IrrigationEvent & { id: number } {
  return {
    id: Number(r.id),
    ts_start: iso(r.ts_start as Date),
    ts_end: iso(r.ts_end as Date | null),
    trigger: r.trigger as IrrigationEvent['trigger'],
    reason: r.reason as string,
    result: r.result as IrrigationEvent['result'],
  };
}

function toAlarm(r: Record<string, unknown>): Alarm {
  return {
    code: r.code as AlarmCode,
    since: iso(r.since as Date),
    message: r.message as string,
    severity: r.severity as Alarm['severity'],
  };
}

export interface PgRepoOptions {
  /** Boot defaults (SETTINGS_DEFAULTS + env). DB `settings` rows override these. */
  settingsDefaults?: Settings;
}

/** Postgres implementation of the Repo port. Schema: migrations/001_init.sql. */
export class PgRepo implements Repo {
  private readonly defaults: Settings;

  constructor(private readonly pool: Pool, opts: PgRepoOptions = {}) {
    this.defaults = opts.settingsDefaults ?? SETTINGS_DEFAULTS;
  }

  // ───── readings ─────

  async insertReading(r: Reading): Promise<void> {
    await this.pool.query(
      `INSERT INTO readings (node_id, ts, t, rh, light_raw, soil_raw, soil_pct, light_pct)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [r.node_id, r.ts, r.t, r.rh, r.light_raw, r.soil_raw, r.soil_pct, r.light_pct],
    );
  }

  async latestReading(node_id?: string): Promise<Reading | null> {
    const { sql, params } = nodeFilter('SELECT * FROM readings', node_id);
    const res = await this.pool.query(`${sql} ORDER BY ts DESC LIMIT 1`, params);
    const row = res.rows[0];
    return row ? toReading(row) : null;
  }

  /** Inclusive [from, to]. Returns the newest `limit` rows in range, ascending by ts. */
  async readings(q: { from?: string; to?: string; limit?: number; node_id?: string }): Promise<Reading[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.node_id !== undefined) { params.push(q.node_id); where.push(`node_id = $${params.length}`); }
    if (q.from !== undefined) { params.push(q.from); where.push(`ts >= $${params.length}`); }
    if (q.to !== undefined) { params.push(q.to); where.push(`ts <= $${params.length}`); }
    const limit = Math.min(Math.max(1, Math.floor(q.limit ?? DEFAULT_READ_LIMIT)), MAX_READ_LIMIT);
    params.push(limit);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const res = await this.pool.query(
      `SELECT * FROM (
         SELECT * FROM readings ${whereSql} ORDER BY ts DESC LIMIT $${params.length}
       ) x ORDER BY ts ASC`,
      params,
    );
    return res.rows.map(toReading);
  }

  async nodeLastSeen(): Promise<Record<string, string>> {
    const res = await this.pool.query(
      'SELECT DISTINCT ON (node_id) node_id, ts FROM readings ORDER BY node_id, ts DESC',
    );
    const out: Record<string, string> = {};
    for (const r of res.rows) out[r.node_id as string] = iso(r.ts as Date);
    return out;
  }

  // ───── settings ─────

  async getSettings(): Promise<Settings> {
    const res = await this.pool.query<{ key: string; value: unknown }>('SELECT key, value FROM settings');
    const stored: Partial<Settings> = {};
    for (const r of res.rows) {
      if ((SETTINGS_KEYS as string[]).includes(r.key)) {
        (stored as Record<string, unknown>)[r.key] = r.value;
      }
    }
    return { ...this.defaults, ...stored };
  }

  async putSettings(patch: Partial<Settings>): Promise<Settings> {
    const entries = SETTINGS_KEYS.filter((k) => patch[k] !== undefined);
    if (entries.length > 0) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        for (const k of entries) {
          await client.query(
            `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            [k, JSON.stringify(patch[k])],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }
    return this.getSettings();
  }

  // ───── commands ─────

  async upsertCommand(c: Command): Promise<void> {
    await this.pool.query(
      `INSERT INTO commands (id, ts, type, state, expires_at, ack_ts, max_s, attempts, trigger, reason, last_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET
         ts = EXCLUDED.ts, type = EXCLUDED.type, state = EXCLUDED.state,
         expires_at = EXCLUDED.expires_at, ack_ts = EXCLUDED.ack_ts, max_s = EXCLUDED.max_s,
         attempts = EXCLUDED.attempts, trigger = EXCLUDED.trigger, reason = EXCLUDED.reason,
         last_error = EXCLUDED.last_error`,
      [c.id, c.ts, c.type, c.state, c.expires_at, c.ack_ts, c.max_s, c.attempts, c.trigger, c.reason, c.last_error],
    );
  }

  async getCommand(id: string): Promise<Command | null> {
    const res = await this.pool.query('SELECT * FROM commands WHERE id = $1', [id]);
    const row = res.rows[0];
    return row ? toCommand(row) : null;
  }

  async openCommands(): Promise<Command[]> {
    const res = await this.pool.query(
      "SELECT * FROM commands WHERE state IN ('pending', 'sent') ORDER BY ts ASC",
    );
    return res.rows.map(toCommand);
  }

  // ───── irrigation events ─────

  async insertEvent(e: Omit<IrrigationEvent, 'id'>): Promise<number> {
    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO irrigation_events (ts_start, ts_end, trigger, reason, result)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [e.ts_start, e.ts_end, e.trigger, e.reason, e.result],
    );
    return Number(res.rows[0]?.id);
  }

  async updateEvent(id: number, patch: Partial<IrrigationEvent>): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const k of ISO_FIELDS_EVENT) {
      if (patch[k] !== undefined) {
        params.push(patch[k]);
        sets.push(`"${k}" = $${params.length}`);
      }
    }
    if (sets.length === 0) return;
    params.push(id);
    await this.pool.query(`UPDATE irrigation_events SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  }

  async recentEvents(limit: number): Promise<IrrigationEvent[]> {
    const res = await this.pool.query(
      'SELECT * FROM irrigation_events ORDER BY ts_start DESC LIMIT $1',
      [Math.max(1, Math.floor(limit))],
    );
    return res.rows.map(toEvent);
  }

  async openEvent(): Promise<(IrrigationEvent & { id: number }) | null> {
    const res = await this.pool.query(
      "SELECT * FROM irrigation_events WHERE result = 'running' ORDER BY ts_start DESC LIMIT 1",
    );
    const row = res.rows[0];
    return row ? toEvent(row) : null;
  }

  /**
   * Pump seconds overlapping [iso, now]. Completed events use ts_end; a running event counts up to now.
   * Events without ts_end that are not running count as zero.
   */
  async runtimeSecondsSince(since: string): Promise<number> {
    const res = await this.pool.query<{ s: number }>(
      `SELECT COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (e.end_ts - GREATEST(e.ts_start, $1::timestamptz))))), 0)::float8 AS s
       FROM (
         SELECT ts_start,
                CASE WHEN ts_end IS NOT NULL THEN ts_end
                     WHEN result = 'running' THEN now()
                     ELSE ts_start END AS end_ts
         FROM irrigation_events
       ) e
       WHERE e.end_ts > $1::timestamptz`,
      [since],
    );
    return Number(res.rows[0]?.s ?? 0);
  }

  /**
   * Pump seconds from CLOSED events only (ts_end set), clipped to [since, now]. No row cap.
   */
  async closedRuntimeSecondsSince(since: string): Promise<number> {
    const res = await this.pool.query<{ s: number }>(
      `SELECT COALESCE(SUM(GREATEST(0,
                EXTRACT(EPOCH FROM (LEAST(ts_end, now()) - GREATEST(ts_start, $1::timestamptz))))), 0)::float8 AS s
       FROM irrigation_events
       WHERE ts_end IS NOT NULL AND ts_end > $1::timestamptz`,
      [since],
    );
    return Number(res.rows[0]?.s ?? 0);
  }

  /** Latest ts_end among closed events, or null when none. */
  async lastEventEnd(): Promise<string | null> {
    const res = await this.pool.query<{ m: Date | null }>('SELECT MAX(ts_end) AS m FROM irrigation_events');
    return iso(res.rows[0]?.m ?? null);
  }

  // ───── alarms ─────

  async saveAlarm(a: Alarm | { code: AlarmCode; cleared: true }): Promise<void> {
    if ('cleared' in a) {
      await this.pool.query(
        'UPDATE alarms SET active = FALSE, cleared_at = now() WHERE code = $1 AND active',
        [a.code],
      );
      return;
    }
    await this.pool.query(
      `INSERT INTO alarms (code, since, message, severity, active, cleared_at)
       VALUES ($1, $2, $3, $4, TRUE, NULL)
       ON CONFLICT (code) DO UPDATE SET
         since = CASE WHEN alarms.active THEN alarms.since ELSE EXCLUDED.since END,
         message = EXCLUDED.message,
         severity = EXCLUDED.severity,
         active = TRUE,
         cleared_at = NULL`,
      [a.code, a.since, a.message, a.severity],
    );
  }

  async activeAlarms(): Promise<Alarm[]> {
    const res = await this.pool.query('SELECT code, since, message, severity FROM alarms WHERE active ORDER BY since ASC');
    return res.rows.map(toAlarm);
  }

  // ───── outbox ─────

  async enqueueOutbox(kind: string, payload: unknown): Promise<void> {
    await this.pool.query('INSERT INTO outbox (kind, payload) VALUES ($1, $2::jsonb)', [kind, JSON.stringify(payload)]);
  }

  async pendingOutbox(limit: number): Promise<OutboxRow[]> {
    const res = await this.pool.query(
      'SELECT id, ts, kind, payload, sent_at FROM outbox WHERE sent_at IS NULL ORDER BY id ASC LIMIT $1',
      [Math.max(1, Math.floor(limit))],
    );
    return res.rows.map((r) => ({
      id: Number(r.id),
      ts: iso(r.ts as Date),
      kind: r.kind as string,
      payload: r.payload,
      sent_at: iso(r.sent_at as Date | null),
    }));
  }

  async markOutboxSent(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pool.query(
      'UPDATE outbox SET sent_at = now() WHERE id = ANY($1::bigint[]) AND sent_at IS NULL',
      [ids],
    );
  }

  // ───── maintenance ─────

  /** Deletes readings older than `days`. Returns the number removed. */
  async purgeOlderThan(days: number): Promise<{ readings: number }> {
    const res = await this.pool.query(
      'DELETE FROM readings WHERE ts < now() - make_interval(days => $1::int)',
      [Math.floor(days)],
    );
    return { readings: res.rowCount ?? 0 };
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}

function nodeFilter(base: string, node_id?: string): { sql: string; params: unknown[] } {
  if (node_id === undefined) return { sql: base, params: [] };
  return { sql: `${base} WHERE node_id = $1`, params: [node_id] };
}

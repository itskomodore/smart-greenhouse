import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg, { type Pool } from 'pg';
import { createLogger } from '../log.js';
import { SETTINGS_DEFAULTS, type Command, type Reading } from '../types.js';
import { migrate } from './migrate.js';
import { PgRepo } from './pg-repo.js';
import { runRetention } from './retention.js';

/**
 * Runs only when DATABASE_URL_TEST is set. Each run gets its own schema
 * (dropped at the end), so it never touches existing tables in that database.
 */
const URL_TEST = process.env.DATABASE_URL_TEST;

function reading(node: string, iso: string, soil = 2000): Reading {
  return { node_id: node, ts: iso, t: 21.5, rh: 55, light_raw: 800, soil_raw: soil, soil_pct: 42, light_pct: 19.5 };
}

describe.skipIf(!URL_TEST)('PgRepo (integration)', () => {
  let admin: Pool;
  let pool: Pool;
  let repo: PgRepo;
  const schema = `gh_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const silent = createLogger('test', 'silent');

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: URL_TEST });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: URL_TEST, options: `-c search_path=${schema}` });
    await migrate(pool, { log: silent });
    repo = new PgRepo(pool, { settingsDefaults: { ...SETTINGS_DEFAULTS, soil_dry_raw: 3100 } });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  it('migrate is idempotent', async () => {
    expect(await migrate(pool, { log: silent })).toEqual([]);
  });

  it('ping is true', async () => {
    expect(await repo.ping()).toBe(true);
  });

  it('readings: insert, latest, range (ascending), node filter, last seen', async () => {
    await repo.insertReading(reading('node-a', '2026-01-01T00:00:00.000Z', 2000));
    await repo.insertReading(reading('node-a', '2026-01-01T00:01:00.000Z', 1900));
    await repo.insertReading(reading('node-b', '2026-01-01T00:02:00.000Z', 1800));

    const latest = await repo.latestReading();
    expect(latest?.node_id).toBe('node-b');
    expect(latest?.ts).toBe('2026-01-01T00:02:00.000Z');
    expect(typeof latest?.id).toBe('number');

    const aOnly = await repo.latestReading('node-a');
    expect(aOnly?.ts).toBe('2026-01-01T00:01:00.000Z');

    const range = await repo.readings({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:01:00.000Z' });
    expect(range.map((r) => r.ts)).toEqual(['2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z']);

    const limited = await repo.readings({ limit: 1, node_id: 'node-a' });
    expect(limited).toHaveLength(1);
    expect(limited[0]?.ts).toBe('2026-01-01T00:01:00.000Z');

    const seen = await repo.nodeLastSeen();
    expect(seen).toEqual({ 'node-a': '2026-01-01T00:01:00.000Z', 'node-b': '2026-01-01T00:02:00.000Z' });
  });

  it('settings: defaults from boot config, DB rows override, unknown keys ignored', async () => {
    const before = await repo.getSettings();
    expect(before.soil_dry_raw).toBe(3100);
    expect(before.low_threshold).toBe(SETTINGS_DEFAULTS.low_threshold);

    const after = await repo.putSettings({ low_threshold: 25, auto_enabled: false });
    expect(after.low_threshold).toBe(25);
    expect(after.auto_enabled).toBe(false);
    expect(after.high_threshold).toBe(SETTINGS_DEFAULTS.high_threshold);
    expect((await repo.getSettings()).low_threshold).toBe(25);
  });

  it('commands: upsert is idempotent by id, open list, get', async () => {
    const id = randomUUID();
    const c: Command = {
      id, ts: '2026-01-01T00:00:00.000Z', type: 'pump_on', state: 'pending',
      expires_at: '2026-01-01T00:00:30.000Z', ack_ts: null, max_s: 60, attempts: 0,
      trigger: 'auto', reason: 'soil low', last_error: null,
    };
    await repo.upsertCommand(c);
    await repo.upsertCommand({ ...c, state: 'acked', attempts: 1, ack_ts: '2026-01-01T00:00:01.000Z' });
    await repo.upsertCommand({ ...c, state: 'acked', attempts: 1, ack_ts: '2026-01-01T00:00:01.000Z' });

    const got = await repo.getCommand(id);
    expect(got).toMatchObject({ id, state: 'acked', attempts: 1, max_s: 60, ack_ts: '2026-01-01T00:00:01.000Z' });
    expect((await repo.openCommands()).some((x) => x.id === id)).toBe(false);
    expect(await repo.getCommand(randomUUID())).toBeNull();
  });

  it('irrigation events: insert, open, update, recent, runtime', async () => {
    const start = '2026-02-01T10:00:00.000Z';
    const id = await repo.insertEvent({ ts_start: start, ts_end: null, trigger: 'auto', reason: 'dry', result: 'running' });
    expect((await repo.openEvent())?.id).toBe(id);

    await repo.updateEvent(id, { ts_end: '2026-02-01T10:00:30.000Z', result: 'completed' });
    expect(await repo.openEvent()).toBeNull();

    const recent = await repo.recentEvents(10);
    expect(recent[0]).toMatchObject({ id, result: 'completed', ts_end: '2026-02-01T10:00:30.000Z' });

    expect(await repo.runtimeSecondsSince('2026-02-01T00:00:00.000Z')).toBeCloseTo(30, 3);
    expect(await repo.runtimeSecondsSince('2026-02-01T10:00:20.000Z')).toBeCloseTo(10, 3);
    expect(await repo.runtimeSecondsSince('2026-02-02T00:00:00.000Z')).toBe(0);
  });

  it('closed runtime excludes running events; lastEventEnd is max closed ts_end', async () => {
    // 1 closed event from earlier test (10:00:00 -> 10:00:30) + a closed one of 60 s on 2026-02-03
    await repo.insertEvent({ ts_start: '2026-02-03T00:00:00.000Z', ts_end: '2026-02-03T00:01:00.000Z', trigger: 'manual', reason: 'op', result: 'completed' });
    // a running event (must not count as closed)
    await repo.insertEvent({ ts_start: '2026-02-04T00:00:00.000Z', ts_end: null, trigger: 'auto', reason: 'dry', result: 'running' });

    expect(await repo.closedRuntimeSecondsSince('2026-02-01T00:00:00.000Z')).toBeCloseTo(90, 3);
    expect(await repo.closedRuntimeSecondsSince('2026-02-03T00:00:30.000Z')).toBeCloseTo(30, 3);
    expect(await repo.closedRuntimeSecondsSince('2026-02-05T00:00:00.000Z')).toBe(0);
    expect(await repo.lastEventEnd()).toBe('2026-02-03T00:01:00.000Z');

    // running event closes: now counts as closed
    const running = await repo.openEvent();
    await repo.updateEvent(running!.id, { ts_end: '2026-02-04T00:00:10.000Z', result: 'completed' });
    expect(await repo.lastEventEnd()).toBe('2026-02-04T00:00:10.000Z');
  });

  it('alarms: raise, re-raise keeps since, clear, active list', async () => {
    await repo.saveAlarm({ code: 'db_down', since: '2026-03-01T00:00:00.000Z', message: 'x', severity: 'critical' });
    await repo.saveAlarm({ code: 'db_down', since: '2026-03-01T00:05:00.000Z', message: 'y', severity: 'critical' });
    let active = await repo.activeAlarms();
    expect(active).toEqual([{ code: 'db_down', since: '2026-03-01T00:00:00.000Z', message: 'y', severity: 'critical' }]);

    await repo.saveAlarm({ code: 'db_down', cleared: true });
    expect(await repo.activeAlarms()).toEqual([]);

    await repo.saveAlarm({ code: 'db_down', since: '2026-03-02T00:00:00.000Z', message: 'z', severity: 'critical' });
    active = await repo.activeAlarms();
    expect(active.map((a) => a.since)).toEqual(['2026-03-02T00:00:00.000Z']);
  });

  it('outbox: enqueue, pending oldest first, mark sent', async () => {
    await repo.enqueueOutbox('reading', { a: 1 });
    await repo.enqueueOutbox('event', { b: 2 });
    const pending = await repo.pendingOutbox(10);
    expect(pending.map((r) => r.kind).slice(0, 2)).toEqual(['reading', 'event']);
    expect(pending[0]?.payload).toEqual({ a: 1 });

    await repo.markOutboxSent([pending[0]!.id]);
    const after = await repo.pendingOutbox(10);
    expect(after.some((r) => r.id === pending[0]!.id)).toBe(false);
    expect(after.some((r) => r.id === pending[1]!.id)).toBe(true);
  });

  it('retention: purges readings older than retention_days only', async () => {
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const fresh = new Date(Date.now() - 1 * 86_400_000).toISOString();
    await repo.insertReading(reading('node-r', old));
    await repo.insertReading(reading('node-r', fresh));

    const removed = await runRetention({ repo: { getSettings: async () => ({ ...SETTINGS_DEFAULTS, retention_days: 90 }), purgeOlderThan: (d) => repo.purgeOlderThan(d) }, log: silent });
    expect(removed).toBeGreaterThanOrEqual(1);
    const left = await repo.readings({ node_id: 'node-r' });
    expect(left.map((r) => r.ts)).toEqual([fresh]);
  });
});

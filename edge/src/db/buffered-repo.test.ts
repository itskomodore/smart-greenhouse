import { describe, it, expect, vi } from 'vitest';
import { createBus, type BusTopics } from '../bus.js';
import type { Logger } from '../log.js';
import { SETTINGS_DEFAULTS, type Alarm, type Reading, type Repo, type Settings } from '../types.js';
import { BufferedRepo } from './buffered-repo.js';

/** Fake Repo: only the methods BufferedRepo touches are real. `down` makes writes/ping fail. */
class FakeRepo implements Repo {
  down = false;
  /** When > 0, the next N insertReading calls succeed, then `down` takes effect. */
  failAfter = Infinity;
  written: Reading[] = [];
  insertCalls = 0;
  alarmWrites: (Alarm | { code: string; cleared: true })[] = [];
  alarms: Alarm[] = [];

  async insertReading(r: Reading): Promise<void> {
    this.insertCalls++;
    if (this.down || this.written.length >= this.failAfter) throw new Error('connect ECONNREFUSED');
    this.written.push(r);
  }
  async ping(): Promise<boolean> {
    return !this.down;
  }
  settings: Settings = { ...SETTINGS_DEFAULTS, low_threshold: 25 };
  settingsWrites = 0;
  settingsReads = 0;
  async getSettings(): Promise<Settings> {
    this.settingsReads++;
    if (this.down) throw new Error('timeout');
    return this.settings;
  }
  async putSettings(patch: Partial<Settings>): Promise<Settings> {
    if (this.down) throw new Error('timeout');
    this.settingsWrites++;
    this.settings = { ...this.settings, ...patch };
    return this.settings;
  }
  async saveAlarm(a: Alarm | { code: Alarm['code']; cleared: true }): Promise<void> {
    if (this.down) throw new Error('db down');
    this.alarmWrites.push(a);
  }
  async activeAlarms(): Promise<Alarm[]> {
    if (this.down) throw new Error('db down');
    return this.alarms;
  }

  // ── unused by BufferedRepo's buffer path ──
  latestReading(): never { throw new Error('unused'); }
  readings(): never { throw new Error('unused'); }
  nodeLastSeen(): never { throw new Error('unused'); }
  upsertCommand(): never { throw new Error('unused'); }
  getCommand(): never { throw new Error('unused'); }
  openCommands(): never { throw new Error('unused'); }
  insertEvent(): never { throw new Error('unused'); }
  updateEvent(): never { throw new Error('unused'); }
  recentEvents(): never { throw new Error('unused'); }
  openEvent(): never { throw new Error('unused'); }
  runtimeSecondsSince(): never { throw new Error('unused'); }
  closedRuntimeSecondsSince(): never { throw new Error('unused'); }
  lastEventEnd(): never { throw new Error('unused'); }
  enqueueOutbox(): never { throw new Error('unused'); }
  pendingOutbox(): never { throw new Error('unused'); }
  markOutboxSent(): never { throw new Error('unused'); }
  purgeOlderThan(): never { throw new Error('unused'); }
}

function fakeLog() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };
  return { log, asLogger: log as unknown as Logger };
}

function reading(i: number): Reading {
  return {
    node_id: 'node-a',
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    t: 20 + i,
    rh: 50,
    light_raw: 100,
    soil_raw: 2000,
    soil_pct: 40,
    light_pct: 2.4,
  };
}

function setup(maxBuffer: number, opts: { probeBackoffMs?: number } = {}) {
  const inner = new FakeRepo();
  const bus = createBus();
  const alarmEvents: BusTopics['alarms'][] = [];
  const healthEvents: BusTopics['db'][] = [];
  bus.on('alarms', (a) => alarmEvents.push(a));
  bus.on('db', (h) => healthEvents.push(h));
  const { log, asLogger } = fakeLog();
  let clock = 1_000_000;
  const repo = new BufferedRepo(inner, {
    maxBuffer,
    bus,
    log: asLogger,
    now: () => clock,
    probeBackoffMs: opts.probeBackoffMs ?? 0,
  });
  return {
    inner,
    repo,
    bus,
    log,
    alarmEvents,
    healthEvents,
    advance: (ms: number) => { clock += ms; },
  };
}

describe('BufferedRepo: DB up', () => {
  it('writes straight through in order', async () => {
    const { inner, repo } = setup(10);
    for (let i = 0; i < 3; i++) await repo.insertReading(reading(i));
    expect(inner.written.map((r) => r.t)).toEqual([20, 21, 22]);
    expect(repo.status()).toMatchObject({ up: true, buffered: 0, dropped: 0, since: null });
  });
});

describe('BufferedRepo: short outage', () => {
  it('loses nothing, flushes in order on recovery, raises then clears db_down', async () => {
    const { inner, repo, alarmEvents, healthEvents } = setup(100);

    await repo.insertReading(reading(0));
    inner.down = true;
    for (let i = 1; i <= 4; i++) await repo.insertReading(reading(i)); // resolve, not throw
    expect(repo.status()).toMatchObject({ up: false, buffered: 4, dropped: 0 });
    expect(inner.written.map((r) => r.t)).toEqual([20]);

    // raise: bus alarms carry db_down critical
    const raised = alarmEvents.at(-1);
    expect(raised?.map((a) => a.code)).toEqual(['db_down']);
    expect(raised?.[0]?.severity).toBe('critical');
    expect(healthEvents.at(-1)).toMatchObject({ up: false, buffered: 4 });

    inner.down = false;
    await repo.insertReading(reading(5));
    expect(inner.written.map((r) => r.t)).toEqual([20, 21, 22, 23, 24, 25]);
    expect(repo.status()).toMatchObject({ up: true, buffered: 0, dropped: 0, since: null });

    // clear: DB row cleared and bus alarms no longer contain db_down
    expect(inner.alarmWrites.some((a) => 'cleared' in a && a.code === 'db_down')).toBe(true);
    expect(alarmEvents.at(-1)?.some((a) => a.code === 'db_down')).toBe(false);
    expect(healthEvents.at(-1)).toMatchObject({ up: true, buffered: 0 });
  });

  it('a failure mid-flush keeps the remaining readings at the head, in order', async () => {
    const { inner, repo } = setup(100);
    inner.down = true;
    for (let i = 0; i < 5; i++) await repo.insertReading(reading(i));

    // DB comes back but dies again after writing 2 of the 5 buffered readings.
    inner.down = false;
    inner.failAfter = inner.written.length + 2;
    await repo.insertReading(reading(5));
    expect(inner.written.map((r) => r.t)).toEqual([20, 21]);
    expect(repo.status()).toMatchObject({ up: false, buffered: 4 });

    inner.failAfter = Infinity;
    expect(await repo.recover()).toBe(true);
    expect(inner.written.map((r) => r.t)).toEqual([20, 21, 22, 23, 24, 25]);
    expect(repo.status().buffered).toBe(0);
  });
});

describe('BufferedRepo: bounded ring', () => {
  it('drops the oldest reading on overflow and logs a warn', async () => {
    const { inner, repo, log } = setup(3);
    inner.down = true;
    for (let i = 0; i < 5; i++) await repo.insertReading(reading(i)); // 0,1 dropped

    expect(repo.status()).toMatchObject({ buffered: 3, dropped: 2 });
    expect(log.warn).toHaveBeenCalledTimes(2);

    inner.down = false;
    await repo.recover();
    expect(inner.written.map((r) => r.t)).toEqual([22, 23, 24]);
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new BufferedRepo(new FakeRepo(), { maxBuffer: 0 })).toThrow(RangeError);
  });
});

describe('BufferedRepo: probe backoff', () => {
  it('does not hit the DB again until the backoff elapses', async () => {
    const { inner, repo, advance } = setup(100, { probeBackoffMs: 5000 });
    inner.down = true;
    await repo.insertReading(reading(0)); // first failure: 1 call
    const callsAfterFail = inner.insertCalls;

    await repo.insertReading(reading(1)); // inside backoff: buffered only
    await repo.insertReading(reading(2));
    expect(inner.insertCalls).toBe(callsAfterFail);
    expect(repo.status().buffered).toBe(3);

    advance(5000);
    inner.down = false;
    await repo.insertReading(reading(3));
    expect(inner.written.map((r) => r.t)).toEqual([20, 21, 22, 23]);
    expect(repo.status().up).toBe(true);
  });
});

describe('BufferedRepo: recovery without new readings', () => {
  it('recover() flushes the ring and clears db_down when no new reading arrives', async () => {
    const { inner, repo, alarmEvents } = setup(10);
    inner.down = true;
    await repo.insertReading(reading(0));
    inner.down = false;
    expect(await repo.recover()).toBe(true);
    expect(inner.written.map((r) => r.t)).toEqual([20]);
    expect(repo.status().up).toBe(true);
    expect(alarmEvents.at(-1)?.some((a) => a.code === 'db_down')).toBe(false);
  });

  it('recover() is a no-op returning true when already up', async () => {
    const { inner, repo } = setup(10);
    expect(await repo.recover()).toBe(true);
    expect(inner.insertCalls).toBe(0);
  });

  it('recover() stays down while the DB is still unreachable', async () => {
    const { inner, repo } = setup(10);
    inner.down = true;
    await repo.insertReading(reading(0));
    expect(await repo.recover()).toBe(false);
    expect(repo.status()).toMatchObject({ up: false, buffered: 1 });
  });
});

describe('BufferedRepo: settings cache', () => {
  it('returns the last good settings when the DB is down, and marks it down', async () => {
    const { inner, repo, healthEvents } = setup(10);
    expect((await repo.getSettings()).low_threshold).toBe(25);
    inner.down = true;
    const s = await repo.getSettings();
    expect(s.low_threshold).toBe(25);
    expect(repo.status().up).toBe(false);
    expect(healthEvents.at(-1)?.up).toBe(false);
  });

  it('falls back to boot defaults when settings were never loaded', async () => {
    const inner = new FakeRepo();
    inner.down = true;
    const bootDefaults = { ...SETTINGS_DEFAULTS, soil_dry_raw: 3100 };
    const repo = new BufferedRepo(inner, { maxBuffer: 5, settingsFallback: bootDefaults, log: fakeLog().asLogger, bus: createBus() });
    expect(await repo.getSettings()).toEqual(bootDefaults);
    expect(repo.status().up).toBe(false);
  });

  it('within probe backoff, getSettings does not touch the DB', async () => {
    const inner = new FakeRepo();
    let clock = 0;
    const repo = new BufferedRepo(inner, {
      maxBuffer: 5, probeBackoffMs: 5000, log: fakeLog().asLogger, bus: createBus(), now: () => clock,
    });
    await repo.getSettings();
    expect(inner.settingsReads).toBe(1);
    inner.down = true;
    await repo.getSettings(); // fails: marks down, backoff starts
    expect(inner.settingsReads).toBe(2);
    clock += 1000;
    await repo.getSettings(); // inside backoff: cache only
    expect(inner.settingsReads).toBe(2);
    clock += 5000;
    await repo.getSettings(); // backoff elapsed: probes again
    expect(inner.settingsReads).toBe(3);
  });

  it('putSettings rejects while down and never reaches the DB', async () => {
    const { inner, repo } = setup(10);
    inner.down = true;
    await repo.getSettings(); // mark down
    await expect(repo.putSettings({ low_threshold: 10 })).rejects.toThrow(/database unavailable/);
    expect(inner.settingsWrites).toBe(0);
  });

  it('putSettings updates the cache on success', async () => {
    const { repo } = setup(10);
    await repo.putSettings({ low_threshold: 15 });
    expect((await repo.getSettings()).low_threshold).toBe(15);
  });
});

describe('BufferedRepo: alarms while down', () => {
  it('activeAlarms resolves from cache with db_down included instead of throwing', async () => {
    const { inner, repo, alarmEvents } = setup(10);
    inner.alarms = [{ code: 'sensor_stale', since: '2026-01-01T00:00:00.000Z', message: 'quiet', severity: 'warn' }];
    expect((await repo.activeAlarms()).map((a) => a.code)).toEqual(['sensor_stale']);

    inner.down = true;
    const alarms = await repo.activeAlarms();
    expect(alarms.map((a) => a.code).sort()).toEqual(['db_down', 'sensor_stale']);
    expect(alarms.find((a) => a.code === 'db_down')?.severity).toBe('critical');
    expect(alarmEvents.at(-1)?.some((a) => a.code === 'db_down')).toBe(true);
  });

  it('never loaded + DB down: returns only db_down', async () => {
    const inner = new FakeRepo();
    inner.down = true;
    const repo = new BufferedRepo(inner, { maxBuffer: 5, log: fakeLog().asLogger, bus: createBus() });
    const alarms = await repo.activeAlarms();
    expect(alarms.map((a) => a.code)).toEqual(['db_down']);
  });

  it('db_down disappears from activeAlarms after recovery', async () => {
    const { inner, repo } = setup(10);
    inner.down = true;
    await repo.insertReading(reading(0));
    inner.down = false;
    await repo.recover();
    expect((await repo.activeAlarms()).some((a) => a.code === 'db_down')).toBe(false);
  });
});

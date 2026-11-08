/**
 * S8: the database goes down briefly.
 *   a) Readings arriving during the outage are acknowledged (2.01), buffered in memory, and flushed
 *      in order after recovery. None is lost. The db_down alarm is raised and then cleared.
 *   b) The DB goes down while the pump is running. The pump is still stopped at max_run_s, and
 *      no new start is sent while the command cannot be persisted.
 *   c) Same as (b) but the DB hangs instead of failing fast. The OFF path must not wait on it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { closeAllRigs, Rig, soilRawFor } from '../harness/rig.js';

afterEach(closeAllRigs);

const S = 1000;

describe('S8 DB outage', () => {
  it('S8: readings during a brief outage are buffered, flushed in order after recovery, none lost; db_down raised then cleared', async () => {
    const rig = await Rig.start({ buffered: { maxBuffer: 100, probeBackoffMs: 5000 } });
    await rig.runFor(2 * S);

    const sent: number[] = [];
    const send = async (soil: number) => {
      sent.push(soil);
      const r = await rig.reading(soil);
      expect(r.code).toBe('2.01');
    };

    for (const soil of [50, 51, 52]) await send(soil);
    expect(rig.mem.rows).toHaveLength(3);

    // Outage: every store call fails.
    rig.mem.faults = 'throw';
    for (const soil of [53, 54, 55, 56, 57]) {
      await send(soil);
      await rig.runFor(10 * S); // lets the flush probe fire (backoff 5 s) and fail
    }
    expect(rig.buffered?.status().up).toBe(false);
    expect(rig.buffered?.status().buffered).toBe(5);
    expect(rig.mem.rows).toHaveLength(3);
    expect(rig.dbHistory).toContain(false);
    expect(rig.alarmHistory.at(-1)?.codes).toContain('db_down');

    // Recovery: the next reading triggers a FIFO flush of everything buffered, then itself.
    rig.mem.faults = 'ok';
    await rig.runFor(10 * S);
    await send(58);

    expect(rig.buffered?.status()).toMatchObject({ up: true, buffered: 0, dropped: 0 });
    // Same order as sent (FIFO), none missing, none duplicated.
    expect(rig.mem.rows.map((r) => r.soil_raw)).toEqual(sent.map(soilRawFor));
    const ts = rig.mem.rows.map((r) => Date.parse(r.ts));
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(rig.mem.rows).toHaveLength(sent.length);

    expect(rig.dbHistory.at(-1)).toBe(true);
    expect(rig.alarmHistory.at(-1)?.codes).not.toContain('db_down');
    expect(rig.mem.alarms.has('db_down')).toBe(false);
    expect(rig.ctl.latestAccepted?.soil_pct).toBeCloseTo(58, 6);
  });

  it('S8: DB down while irrigating: the pump is still stopped at max_run_s; no new start while the database is unavailable', async () => {
    const rig = await Rig.start({
      buffered: { maxBuffer: 100, probeBackoffMs: 5000 },
      settings: { min_interval_s: 0, max_run_s: 60 },
    });
    await rig.runFor(2 * S);
    await rig.reading(20);
    expect(await rig.runUntil(() => rig.pumpOnSends() === 1, 5 * S)).toBe(true);
    const onAt = rig.actuator.calls.find((c) => c.type === 'pump_on')!.at;

    await rig.runFor(10 * S);
    rig.mem.faults = 'throw';
    await rig.reading(20); // buffered, still 2.01
    await rig.runFor(70 * S, S);

    const off = rig.actuator.calls.find((c) => c.type === 'pump_off');
    expect(off).toBeDefined();
    expect(off!.at - onAt).toBeLessThanOrEqual(61 * S);
    expect(rig.actuator.actual).toBe('off');
    expect(rig.pumpSamples.at(-1)).toBe('off');

    // Still down, sensor low, min_interval 0: the rules would allow a start, but the controller
    // refuses new starts while the database is unhealthy, so nothing is sent.
    expect(rig.buffered?.status().up).toBe(false);
    expect(rig.pumpOnSends()).toBe(1);
  });

  it('S8: DB hangs (no fast error) while irrigating: the pump is still stopped at max_run_s', async () => {
    const rig = await Rig.start({
      dbTimeoutMs: 5,
      buffered: { maxBuffer: 100, probeBackoffMs: 5000 },
    });
    await rig.runFor(2 * S);
    await rig.reading(20);
    expect(await rig.runUntil(() => rig.pumpOnSends() === 1, 5 * S)).toBe(true);
    const onAt = rig.actuator.calls.find((c) => c.type === 'pump_on')!.at;

    rig.mem.faults = 'hang';
    await rig.runFor(70 * S, S);

    const off = rig.actuator.calls.find((c) => c.type === 'pump_off');
    expect(off).toBeDefined();
    expect(off!.at - onAt).toBeLessThanOrEqual(61 * S);
    expect(rig.actuator.actual).toBe('off');
    expect(rig.pumpSamples.at(-1)).toBe('off');
    expect(rig.pumpOnSends()).toBe(1);
  });
});

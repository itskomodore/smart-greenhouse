/**
 * S11: the DB goes down after a run has closed.
 *   - While the DB is down, no new start is sent, even with fresh low soil and min_interval 0.
 *   - The daily runtime already used (the closed run) is still counted during the outage.
 *   - After recovery the next start is limited to the remaining budget, not the full daily_max_s.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { closeAllRigs, Rig } from '../harness/rig.js';

afterEach(closeAllRigs);

const S = 1000;

describe('S11 DB down after a run is closed', () => {
  it('S11: during a DB outage no start is sent, the used daily runtime still counts, and the post-recovery start gets only the remaining budget', async () => {
    const rig = await Rig.start({
      buffered: { maxBuffer: 100, probeBackoffMs: 5000 },
      settings: { daily_max_s: 100, max_run_s: 60, min_interval_s: 0 },
    });
    await rig.runFor(2 * S);
    await rig.reading(20);

    // Run 1: 60 s, closed as completed while the DB is up.
    expect(await rig.runUntil(() => rig.pumpOnSends() === 1, 5 * S)).toBe(true);
    expect(
      await rig.runUntil(() => rig.pumpSamples.at(-1) === 'off' && rig.mem.events.some((e) => e.ts_end !== null), 120 * S),
    ).toBe(true);
    expect(rig.ctl.dailyRuntimeSeconds).toBeGreaterThanOrEqual(58);

    // DB goes down. Readings keep arriving (buffered, 2.01) with fresh low soil.
    rig.mem.faults = 'throw';
    for (let t = 0; t < 60; t += 10) {
      expect((await rig.reading(20)).code).toBe('2.01');
      await rig.runFor(10 * S);
    }
    expect(rig.buffered?.status().up).toBe(false);
    expect(rig.pumpOnSends()).toBe(1); // no new start while the DB is unavailable
    expect(rig.ctl.dailyRuntimeSeconds).toBeGreaterThanOrEqual(58); // still counted

    // Recovery: the buffer flushes, then the next start is limited to the remaining 40 s.
    rig.mem.faults = 'ok';
    await rig.runFor(10 * S);
    expect((await rig.reading(20)).code).toBe('2.01');
    expect(await rig.runUntil(() => rig.pumpOnSends() === 2, 30 * S)).toBe(true);

    const ons = rig.commandsOfType('pump_on').sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    expect(ons.map((c) => c.max_s)).toEqual([60, 40]);
    await rig.close();
  });
});

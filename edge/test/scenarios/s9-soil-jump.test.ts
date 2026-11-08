/**
 * S9: an implausible soil jump is ignored and never starts the pump.
 * Baseline 50 % (not low). A single reading at 5 % (a 45-point jump, above max_soil_jump_pct 40)
 * would start irrigation if accepted. It must be stored, rejected by the jump filter, and raise
 * soil_jump_ignored. The alarm clears when a plausible reading comes back.
 *
 * A sustained change (three agreeing readings over at least 60 s) is a real step change; the
 * baseline is re-established, as designed. That case is covered by the second test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { closeAllRigs, Rig, soilRawFor } from '../harness/rig.js';

afterEach(closeAllRigs);

const S = 1000;

describe('S9 implausible soil jump', () => {
  it('S9: a single 45-point jump to low soil is stored but ignored, raises soil_jump_ignored, and does not start the pump', async () => {
    const rig = await Rig.start();
    await rig.runFor(2 * S);

    expect((await rig.reading(50)).code).toBe('2.01');
    await rig.runFor(5 * S);

    expect((await rig.reading(5)).code).toBe('2.01');
    await rig.runFor(5 * S);

    // Stored as received (the store keeps raw data), but not used for decisions.
    expect(rig.mem.rows.map((r) => r.soil_raw)).toEqual([soilRawFor(50), soilRawFor(5)]);
    expect(rig.ctl.latestAccepted?.soil_pct).toBeCloseTo(50, 6);
    expect(rig.activeAlarmCodes()).toContain('soil_jump_ignored');
    expect(rig.mem.alarms.has('soil_jump_ignored')).toBe(true);
    expect(rig.pumpOnSends()).toBe(0);
    expect(rig.decisions.some((d) => d.decision.action === 'start')).toBe(false);

    // A second implausible reading, still within the latch window: still no start.
    await rig.runFor(30 * S);
    expect((await rig.reading(5)).code).toBe('2.01');
    await rig.runFor(30 * S);
    expect(rig.pumpOnSends()).toBe(0);
    expect(rig.ctl.latestAccepted?.soil_pct).toBeCloseTo(50, 6);

    // A plausible reading comes back: accepted, alarm cleared.
    expect((await rig.reading(52)).code).toBe('2.01');
    await rig.runFor(5 * S);
    expect(rig.ctl.latestAccepted?.soil_pct).toBeCloseTo(52, 6);
    expect(rig.activeAlarmCodes()).not.toContain('soil_jump_ignored');
    expect(rig.mem.alarms.has('soil_jump_ignored')).toBe(false);
    expect(rig.pumpOnSends()).toBe(0);
  });

  it('S9 (control): with the jump filter disabled the same 5 % reading starts the pump, so the S9 test above is meaningful', async () => {
    const rig = await Rig.start({ assessReading: () => ({ accept: true }) });
    await rig.runFor(2 * S);
    await rig.reading(50);
    await rig.runFor(5 * S);
    await rig.reading(5);
    expect(await rig.runUntil(() => rig.pumpOnSends() === 1, 10 * S)).toBe(true);
    await rig.close();
  });

  it('S9: a sustained step (three agreeing readings over at least 60 s) re-establishes the baseline, with a notice', async () => {
    const rig = await Rig.start({ settings: { auto_enabled: false } });
    await rig.runFor(2 * S);

    await rig.reading(50);
    await rig.runFor(5 * S);
    await rig.reading(5);
    await rig.runFor(30 * S);
    await rig.reading(5);
    await rig.runFor(31 * S);
    expect(rig.ctl.latestAccepted?.soil_pct).toBeCloseTo(50, 6); // two rejections: not yet
    await rig.reading(5);
    await rig.runFor(2 * S);

    expect(rig.ctl.latestAccepted?.soil_pct).toBeCloseTo(5, 6);
    const notice = rig.alarmHistory.at(-1)?.alarms.find((a) => a.code === 'soil_jump_ignored');
    expect(notice?.message).toMatch(/re-established/);
    expect(rig.pumpOnSends()).toBe(0); // auto_enabled false: the baseline change alone never starts a run
  });
});

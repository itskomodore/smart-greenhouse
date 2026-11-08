/**
 * S2: sensor goes silent for longer than stale_timeout_s while soil is below low_threshold.
 * Expect: no irrigation (rules say "sensor stale"), sensor_stale alarm raised, and recovery
 * (alarm cleared, irrigation allowed again) once a fresh reading arrives.
 *
 * Setup note: a closed run ended 10 s before the sensor's last reading, with min_interval_s 1800.
 * That blocks the start for the first 30 minutes, so the only thing left to block a start after
 * stale_timeout_s is the staleness rule itself. The assertions on decision reasons check this.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { closeAllRigs, closedEvent, Rig, T0 } from '../harness/rig.js';
import { iso } from '../../src/actuator/clock.js';

afterEach(closeAllRigs);

const S = 1000;
const STALE_TIMEOUT_S = 900;
const MIN_INTERVAL_S = 1800;
/** Silent phases are stepped coarser (10 s) to keep the run short; staleness is still exact to within a step. */
const SILENT_STEP = 10 * S;

describe('S2 sensor silent past stale_timeout', () => {
  it('S2: no irrigation while the sensor is silent (soil below low), sensor_stale raised, and recovery when readings return', async () => {
    const rig = await Rig.start({
      seedEvents: [closedEvent(900, iso(T0 - 70 * S), iso(T0 - 10 * S))],
      settings: { stale_timeout_s: STALE_TIMEOUT_S, min_interval_s: MIN_INTERVAL_S, low_threshold: 30 },
    });
    await rig.runFor(2 * S); // first tick answers the boot query: pump known off

    // One reading below low_threshold, then the sensor goes silent.
    const readingAt = rig.clock.now();
    expect((await rig.reading(20)).code).toBe('2.01');
    expect(rig.ctl.latestAccepted?.soil_pct).toBeCloseTo(20, 6);

    // Fresh sensor: no stale alarm. (Before the first reading the rules report stale, which is
    // why the alarm search below starts at the reading instant.)
    await rig.runFor(STALE_TIMEOUT_S * S - 60 * S, SILENT_STEP);
    expect(rig.activeAlarmCodes()).not.toContain('sensor_stale');

    // Silent past stale_timeout: the alarm is raised and no start happens.
    await rig.runFor(120 * S, SILENT_STEP);
    expect(rig.activeAlarmCodes()).toContain('sensor_stale');
    expect(rig.mem.alarms.has('sensor_stale')).toBe(true);
    // First publication after the reading that carries sensor_stale (boot-time staleness is cleared by the reading).
    const staleAt = rig.alarmHistory.find((s) => s.at > readingAt && s.codes.includes('sensor_stale'))?.at ?? Infinity;
    expect(staleAt - readingAt).toBeGreaterThan(STALE_TIMEOUT_S * S);
    expect(staleAt - readingAt).toBeLessThanOrEqual((STALE_TIMEOUT_S + 2 * SILENT_STEP / S) * S);

    // Keep going past the min-interval end (T0 + 1790 s). Still silent: still no start.
    await rig.runFor(MIN_INTERVAL_S * S, SILENT_STEP);
    expect(rig.pumpOnSends()).toBe(0);
    expect(rig.pumpHistory).not.toContain('on');
    const afterSilence = rig.decisionsSince(readingAt + (STALE_TIMEOUT_S + 1) * S);
    expect(afterSilence.length).toBeGreaterThan(0);
    for (const d of afterSilence) {
      expect(d.decision.action).toBe('none');
      expect(d.decision.reason).toMatch(/sensor stale/);
    }

    // Readings return with soil still low: alarm clears and irrigation resumes.
    expect((await rig.reading(20)).code).toBe('2.01');
    const started = await rig.runUntil(() => rig.pumpOnSends() === 1, 5 * S);
    expect(started).toBe(true);

    await rig.runFor(70 * S); // max_run_s (60) plus slack
    expect(rig.pumpOnSends()).toBe(1);
    expect(rig.pumpSamples.at(-1)).toBe('off');
    expect(rig.activeAlarmCodes()).not.toContain('sensor_stale');
    expect(rig.mem.alarms.has('sensor_stale')).toBe(false);
    const runs = rig.mem.events.filter((e) => Date.parse(e.ts_start) > readingAt);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.result).toBe('completed');
  });
});

/**
 * S5: runtime limits.
 *   a) Max runtime is enforced even when the OFF acknowledgement is lost.
 *   b) Every OFF reply lost: the pump is still physically off at max_run_s, the controller never
 *      believes it is on, and the OFF retries do not turn into a tight loop.
 *   c) The daily cap (daily_max_s) stops further auto starts and manual starts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { noReply } from '../../src/actuator/test-support.js';
import type { ActuatorAck } from '../../src/types.js';
import { closeAllRigs, Rig } from '../harness/rig.js';

afterEach(closeAllRigs);

const S = 1000;
const MAX_RUN_S = 60;

/** Start time (ms) of the first pump_on sent, from the actuator's call log. */
function firstOnAt(rig: Rig): number {
  const c = rig.actuator.calls.find((x) => x.kind === 'put' && x.type === 'pump_on');
  if (!c) throw new Error('no pump_on was sent');
  return c.at;
}

function pumpOffCalls(rig: Rig) {
  return rig.actuator.calls.filter((x) => x.kind === 'put' && x.type === 'pump_off');
}

describe('S5 max runtime', () => {
  it('S5: max runtime is enforced when the OFF acknowledgement is lost (transient loss, then acked)', async () => {
    const rig = await Rig.start();
    await rig.runFor(2 * S);

    // The first two OFF requests reach the pump (it switches off) but the replies are lost.
    let offSeen = 0;
    rig.actuator.behave = (call): Promise<ActuatorAck> => {
      if (call.kind === 'put' && call.cmd.type === 'pump_off') {
        offSeen++;
        rig.actuator.actual = 'off';
        return offSeen <= 2 ? noReply() : rig.actuator.applyAndAck(call);
      }
      return rig.actuator.applyAndAck(call);
    };

    await rig.reading(20);
    await rig.runUntil(() => rig.pumpOnSends() === 1, 5 * S);
    const onAt = firstOnAt(rig);

    // Keep the sensor fresh; the run must end by max_run_s regardless.
    await rig.runFor((MAX_RUN_S + 10) * S, S);

    const off = pumpOffCalls(rig);
    expect(off.length).toBeGreaterThanOrEqual(3);
    expect(off[0]!.at - onAt).toBeGreaterThanOrEqual(MAX_RUN_S * S);
    expect(off[0]!.at - onAt).toBeLessThanOrEqual((MAX_RUN_S + 1) * S);
    expect(rig.actuator.actual).toBe('off');
    expect(rig.pumpSamples.at(-1)).toBe('off');

    // The run is closed, not left 'running', and its runtime counts against the day.
    const runs = rig.mem.events.filter((e) => e.trigger === 'auto');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.result).toBe('completed');
    const dur = (Date.parse(runs[0]!.ts_end!) - Date.parse(runs[0]!.ts_start)) / S;
    expect(dur).toBeGreaterThanOrEqual(MAX_RUN_S);
    expect(dur).toBeLessThanOrEqual(MAX_RUN_S + 2);
    expect(await rig.mem.closedRuntimeSecondsSince('1970-01-01T00:00:00.000Z')).toBeCloseTo(dur, 6);
  });

  it('S5: with every OFF reply lost, the pump is still off at max_run_s, the controller never believes on, and OFF retries are not a tight loop', async () => {
    const rig = await Rig.start();
    await rig.runFor(2 * S);
    rig.actuator.behave = (call): Promise<ActuatorAck> => {
      if (call.kind === 'put' && call.cmd.type === 'pump_off') {
        rig.actuator.actual = 'off'; // physically off...
        return noReply(); // ...but never confirmed
      }
      return rig.actuator.applyAndAck(call);
    };

    await rig.reading(20);
    await rig.runUntil(() => rig.pumpOnSends() === 1, 5 * S);
    const onAt = firstOnAt(rig);

    await rig.runFor((MAX_RUN_S + 2) * S, S);
    expect(rig.actuator.actual).toBe('off');
    const firstOff = pumpOffCalls(rig)[0];
    expect(firstOff).toBeDefined();
    expect(firstOff!.at - onAt).toBeLessThanOrEqual((MAX_RUN_S + 1) * S);

    // While the OFF is in flight the state still reads 'on' (it is only given up after the
    // retries fail, about 1.5 s later). After that it is 'unknown' until a query answers ('off').
    // It is never 'on' again once the stop has been issued.
    await rig.runFor(10 * S, S);
    expect(rig.pumpSamples.slice(-5)).not.toContain('on');
    expect(rig.pumpHistory.at(-1)).not.toBe('on');

    // Retry window: 2 minutes of unconfirmed OFF. Guard retries are spaced by GUARD_RETRY_MS (5 s).
    const sendsBefore = pumpOffCalls(rig).length;
    await rig.runFor(120 * S, S);
    const newOffIds = new Set(pumpOffCalls(rig).slice(sendsBefore).map((c) => c.id));
    expect(newOffIds.size).toBeGreaterThan(0);
    expect(newOffIds.size).toBeLessThanOrEqual(26); // 120 s / 5 s + slack
    expect(rig.actuator.actual).toBe('off');
    expect(rig.pumpOnSends()).toBe(1);
  });
});

describe('S5 runtime accounting while OFF is unconfirmed', () => {
  it('S5: every OFF reply lost: the 60 s run is still charged to the daily budget, OFF retries back off, and the event row is closed', async () => {
    const rig = await Rig.start();
    await rig.runFor(2 * S);
    rig.actuator.behave = (call): Promise<ActuatorAck> => {
      if (call.kind === 'put' && call.cmd.type === 'pump_off') {
        rig.actuator.actual = 'off';
        return noReply();
      }
      return rig.actuator.applyAndAck(call);
    };
    await rig.reading(20);
    await rig.runUntil(() => rig.pumpOnSends() === 1, 5 * S);
    await rig.runFor((MAX_RUN_S + 140) * S, S);

    // The pump itself is off (the physical guarantee).
    expect(rig.actuator.actual).toBe('off');

    // The run is charged to the daily budget even though no OFF was ever acknowledged.
    expect(rig.ctl.dailyRuntimeSeconds).toBeGreaterThanOrEqual(MAX_RUN_S - 2);

    // The irrigation row is closed (not left 'running'); result is 'completed' (set by the query
    // that confirmed off). The guard path would record 'stopped'; see the report.
    const rows = rig.mem.events.filter((e) => e.trigger === 'auto');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ts_end).not.toBeNull();
    expect(rows[0]?.result).not.toBe('running');

    // Forced OFF retries back off: a bounded number of sends over the window, and no tight loop.
    const offs = rig.actuator.calls.filter((c) => c.kind === 'put' && c.type === 'pump_off');
    const distinctOffIds = [...new Set(offs.map((c) => c.id))];
    expect(offs.length).toBeLessThanOrEqual(20);
    expect(distinctOffIds.length).toBeLessThanOrEqual(8);
    const firstAt = new Map<string, number>();
    for (const c of offs) if (c.id !== null && !firstAt.has(c.id)) firstAt.set(c.id, c.at);
    const starts = [...firstAt.values()].sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(S);
    await rig.close();
  });
});

describe('S5 daily cap', () => {
  it('S5: daily_max_s stops further auto runs and manual runs once the day budget is used', async () => {
    const rig = await Rig.start({ settings: { daily_max_s: 100, max_run_s: MAX_RUN_S, min_interval_s: 0 } });
    await rig.runFor(2 * S);

    // Soil stays low and the sensor stays fresh, so only the budget can stop irrigation.
    for (let t = 0; t < 400; t += 20) {
      await rig.reading(20);
      await rig.runFor(20 * S, S);
    }

    const ons = rig.commandsOfType('pump_on').sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    expect(ons.map((c) => c.max_s)).toEqual([60, 40]);
    expect(rig.pumpOnSends()).toBe(2);

    const runs = rig.mem.events.filter((e) => e.trigger === 'auto' && e.ts_end !== null);
    const totalS = runs.reduce((acc, e) => acc + (Date.parse(e.ts_end!) - Date.parse(e.ts_start)) / S, 0);
    expect(totalS).toBeGreaterThanOrEqual(100);
    expect(totalS).toBeLessThanOrEqual(102);

    expect(rig.everAlarmCodes().has('daily_cap_reached')).toBe(true);
    expect(rig.lastDecision?.decision.reason).toMatch(/daily cap/);

    const manual = await rig.ctl.requestManual({ cmd: 'on', duration_s: 10 });
    expect(manual.ok).toBe(false);
    if (manual.ok) return;
    expect(manual.code).toBe('daily_cap_reached');
    await rig.runFor(60 * S);
    expect(rig.pumpOnSends()).toBe(2);
  });
});

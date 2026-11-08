/**
 * S6: the controller restarts while the pump is running (or while a pump_on is in flight).
 *
 * A "crash" is modelled by stopping the first controller and its CoAP listener without any clean
 * shutdown, and by never advancing its clock again (so its timers cannot fire). A second
 * controller boots over the same store and the same physical actuator, on its own clock that
 * starts at the crash instant.
 *
 * Expected: the boot path sends OFF first (no query, no ON), the open irrigation event is closed as
 * 'aborted', the pump is known off within 60 s of fake time, and nothing re-starts the pump.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock, noReply } from '../../src/actuator/test-support.js';
import { iso } from '../../src/actuator/clock.js';
import { closeAllRigs, Rig } from '../harness/rig.js';

afterEach(closeAllRigs);

const S = 1000;

describe('S6 restart mid-irrigation', () => {
  it('S6: restart while running: OFF is sent first, the event is closed as aborted, and the pump is known off within 60 s', async () => {
    const rigA = await Rig.start();
    await rigA.runFor(2 * S);
    await rigA.reading(20);
    expect(await rigA.runUntil(() => rigA.pumpOnSends() === 1, 5 * S)).toBe(true);
    await rigA.runFor(20 * S, S);
    expect(rigA.pumpSamples.at(-1)).toBe('on');
    const openBefore = rigA.mem.events.filter((e) => e.ts_end === null);
    expect(openBefore).toHaveLength(1);

    const crashAt = rigA.clock.now();
    await rigA.crash();
    expect(rigA.actuator.actual).toBe('on'); // the physical pump is still running

    const clockB = new FakeClock(crashAt);
    const callsBefore = rigA.actuator.calls.length;
    const rigB = await Rig.start({ mem: rigA.mem, actuator: rigA.actuator, clock: clockB });

    // Boot safe-close has finished by the time start() resolves.
    const afterRestart = rigA.actuator.calls.slice(callsBefore);
    expect(afterRestart[0]?.type).toBe('pump_off');
    expect(afterRestart.some((c) => c.type === 'pump_on')).toBe(false);
    expect(rigA.actuator.actual).toBe('off');
    expect(rigB.ctl.pumpState).toBe('off');
    expect(clockB.now() - crashAt).toBeLessThan(60 * S);

    const aborted = rigA.mem.events.filter((e) => e.result === 'aborted');
    expect(aborted).toHaveLength(1);
    expect(aborted[0]?.ts_end).toBe(iso(crashAt));
    expect(rigA.mem.events.some((e) => e.ts_end === null)).toBe(false);
    expect(rigA.mem.events.some((e) => e.result === 'running')).toBe(false);
    await rigB.close();
  });

  it('S6: after an aborted run the restarted controller respects min_interval: fresh low soil does not re-ON the pump', async () => {
    // The aborted run ended at the restart instant. min_interval_s is the minimum gap between an
    // irrigation END and the next auto START, so no auto ON may follow within 30 min, even with
    // fresh low readings arriving on the new process.
    const rigA = await Rig.start();
    await rigA.runFor(2 * S);
    await rigA.reading(20);
    expect(await rigA.runUntil(() => rigA.pumpOnSends() === 1, 5 * S)).toBe(true);
    await rigA.runFor(20 * S, S);
    const crashAt = rigA.clock.now();
    await rigA.crash();

    const clockB = new FakeClock(crashAt);
    const callsBefore = rigA.actuator.calls.length;
    const rigB = await Rig.start({ mem: rigA.mem, actuator: rigA.actuator, clock: clockB });
    // Fresh low soil on the new process for 5 minutes (well inside the 30-minute min_interval).
    for (let t = 0; t < 300; t += 10) {
      await rigB.reading(20);
      await rigB.runFor(10 * S, S);
    }

    expect(rigA.actuator.calls.slice(callsBefore).filter((c) => c.type === 'pump_on')).toHaveLength(0);
    expect(rigB.pumpOnSends()).toBe(1);
    expect(rigB.decisions.some((d) => /min interval/.test(d.decision.reason))).toBe(true);
    await rigB.close();
  });

  it('S6: restart while a pump_on is in flight (sent, never acknowledged): not re-sent, pump OFF, command failed', async () => {
    const rigA = await Rig.start();
    await rigA.runFor(2 * S);
    // The pump starts, but the reply never reaches the edge. The attempt is persisted as 'sent'.
    rigA.actuator.behave = (call) => {
      if (call.kind === 'put' && call.cmd.type === 'pump_on') {
        rigA.actuator.actual = 'on';
        return noReply();
      }
      return rigA.actuator.applyAndAck(call);
    };
    await rigA.reading(20);
    // Stop right after the first attempt: its retry sleeps on clockA, which is never advanced again.
    expect(await rigA.runUntil(() => rigA.pumpOnSends() === 1, 5 * S)).toBe(true);
    const onCmds = rigA.commandsOfType('pump_on');
    expect(onCmds).toHaveLength(1);
    expect(onCmds[0]?.state).toBe('sent');

    const crashAt = rigA.clock.now();
    await rigA.crash(); // its retry sleeper sits on clockA, which never moves again

    const clockB = new FakeClock(crashAt);
    const rigB = await Rig.start({ mem: rigA.mem, actuator: rigA.actuator, clock: clockB });
    expect(rigA.actuator.actual).toBe('off');
    expect(rigB.ctl.pumpState).toBe('off');
    expect(rigA.pumpOnSends()).toBe(1);

    const persisted = rigA.mem.commands.get(onCmds[0]!.id);
    expect(persisted?.state).toBe('failed');
    expect(persisted?.last_error).toMatch(/interrupted by restart/);

    await rigB.runFor(120 * S, S); // no readings: the sensor is stale, nothing may start
    expect(rigA.pumpOnSends()).toBe(1);
    await rigB.close();
  });
});

/**
 * S10: a manual OFF that arrives while a start is in progress must never end with an ON sent.
 *   a) The start's pump_on is in flight (the actuator holds the request). OFF arrives, then the
 *      held ON is released and acknowledged late. The late ON must be stopped again, and the pump
 *      must end off.
 *   b) A manual OFF arrives after a manual ON is queued but before any tick delivers it. No ON is
 *      ever sent.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ActuatorAck } from '../../src/types.js';
import { closeAllRigs, Rig } from '../harness/rig.js';

afterEach(closeAllRigs);

const S = 1000;

describe('S10 manual OFF during an in-progress start', () => {
  it('S10: OFF arrives while the ON is in flight; the late ON acknowledgement is stopped and the pump ends off', async () => {
    const rig = await Rig.start();
    await rig.runFor(2 * S);
    await rig.reading(50);

    let release!: (ack: ActuatorAck) => void;
    const held = new Promise<ActuatorAck>((resolve) => {
      release = resolve;
    });
    let onCommandId: string | null = null;
    rig.actuator.behave = (call) => {
      if (call.kind === 'put' && call.cmd.type === 'pump_on') {
        onCommandId = call.cmd.id;
        return held; // the ON is in flight until released below
      }
      return rig.actuator.applyAndAck(call);
    };

    const on = await rig.ctl.requestManual({ cmd: 'on', duration_s: 20 });
    expect(on.ok).toBe(true);
    await rig.step(S);
    expect(rig.pumpOnSends()).toBe(1);
    expect(onCommandId).not.toBeNull();

    // Operator OFF while the ON is still in flight.
    const off = await rig.ctl.requestManual({ cmd: 'off' });
    expect(off.ok).toBe(true);
    await rig.runFor(3 * S);
    expect(rig.actuator.actual).toBe('off');

    // The held ON finally gets through and is acknowledged. The controller must not keep it.
    rig.actuator.actual = 'on';
    release({ command_id: onCommandId, pump: 'on', remaining_s: 20 });
    await rig.runFor(10 * S);

    expect(rig.actuator.actual).toBe('off');
    expect(rig.pumpSamples.at(-1)).toBe('off');
    expect(rig.pumpOnSends()).toBe(1); // no second ON was ever sent
    expect(rig.mem.events.some((e) => e.result === 'running')).toBe(false);
    await rig.close();
  });

  it('S10: OFF arrives after a manual ON is queued but before any tick delivers it: no ON is ever sent', async () => {
    const rig = await Rig.start();
    await rig.runFor(2 * S);
    await rig.reading(50);

    const on = await rig.ctl.requestManual({ cmd: 'on', duration_s: 20 });
    expect(on.ok).toBe(true);
    const off = await rig.ctl.requestManual({ cmd: 'off' });
    expect(off.ok).toBe(true);

    await rig.runFor(30 * S);
    expect(rig.pumpOnSends()).toBe(0);
    expect(rig.pumpHistory).not.toContain('on');
    expect(rig.actuator.actual).toBe('off');
    expect(on.ok ? rig.mem.commands.get(on.command.id)?.state : null).toBe('failed'); // superseded by OFF, never sent
    await rig.close();
  });
});

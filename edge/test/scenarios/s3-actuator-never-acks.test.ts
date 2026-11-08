/**
 * S3: the actuator never acknowledges a pump_on.
 * Expect exactly command_max_retries (3) ON attempts, the command ends `failed`, the alarms
 * actuator_unreachable + pump_failed are raised, the controller never believes the pump is on,
 * a best-effort OFF is sent, and nothing loops (no further ON attempts inside the window).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { noReply } from '../../src/actuator/test-support.js';
import type { ActuatorAck } from '../../src/types.js';
import { closeAllRigs, Rig } from '../harness/rig.js';

afterEach(closeAllRigs);

const S = 1000;
/** Fresh readings during the observation window so the sensor never goes stale. */
async function observeWithFreshReadings(rig: Rig, totalS: number, every = 30): Promise<void> {
  for (let t = 0; t < totalS; t += every) {
    await rig.reading(20);
    await rig.runFor(every * S);
  }
}

describe('S3 actuator never acks', () => {
  it('S3: a pump_on that is never acknowledged is retried exactly 3 times, then failed with alarms; pump never believed on', async () => {
    const rig = await Rig.start({ settings: { command_max_retries: 3 } });
    await rig.runFor(2 * S);
    rig.actuator.behave = (call) =>
      call.kind === 'put' && call.cmd.type === 'pump_on' ? noReply() : rig.actuator.applyAndAck(call);

    await observeWithFreshReadings(rig, 600);

    expect(rig.pumpOnSends()).toBe(3);
    const ons = rig.commandsOfType('pump_on');
    expect(ons).toHaveLength(1);
    expect(ons[0]?.state).toBe('failed');
    expect(ons[0]?.attempts).toBe(3);
    expect(ons[0]?.ack_ts).toBeNull();

    // Raised on the bus when the start failed. Note: the best-effort OFF's ack clears both codes
    // again (CommandManager.ack clears actuator_unreachable and pump_failed), so they are checked
    // in the bus history, not in the final store. See the report.
    expect(rig.everAlarmCodes().has('actuator_unreachable')).toBe(true);
    expect(rig.everAlarmCodes().has('pump_failed')).toBe(true);

    // Never believed on, never physically on (the ack never came and nothing was applied).
    expect(rig.pumpHistory).not.toContain('on');
    expect(rig.pumpSamples).not.toContain('on');
    expect(rig.actuator.actual).toBe('off');

    // Best-effort OFF was attempted and acknowledged; the run is closed as failed, not running.
    expect(rig.pumpOffSends()).toBeGreaterThanOrEqual(1);
    expect(rig.mem.events.some((e) => e.result === 'running')).toBe(false);
    expect(rig.mem.events.some((e) => e.result === 'failed')).toBe(true);
    expect(rig.pumpSamples.at(-1)).toBe('off');
  });

  // pump_failed latches: a successful best-effort OFF ack must not clear the failed-start alarm.
  it('S3: a failed pump start keeps its pump_failed alarm after the best-effort OFF is acknowledged', async () => {
    const rig = await Rig.start();
    await rig.runFor(2 * S);
    rig.actuator.behave = (call) =>
      call.kind === 'put' && call.cmd.type === 'pump_on' ? noReply() : rig.actuator.applyAndAck(call);
    await rig.reading(20);
    await rig.runFor(30 * S, S);
    expect(rig.pumpOnSends()).toBe(3);
    expect(rig.mem.alarms.has('pump_failed')).toBe(true);
    await rig.close();
  });

  it('S3: a pump_on that is applied by the actuator but whose ack is always lost is never believed on, and the pump is switched off', async () => {
    const rig = await Rig.start();
    await rig.runFor(2 * S);
    const physicalOn: boolean[] = [];
    rig.actuator.behave = (call): Promise<ActuatorAck> => {
      if (call.kind === 'put' && call.cmd.type === 'pump_on') {
        rig.actuator.actual = 'on'; // the pump really starts...
        physicalOn.push(true);
        return noReply(); // ...but the reply never reaches the edge
      }
      return rig.actuator.applyAndAck(call);
    };

    await observeWithFreshReadings(rig, 120);

    expect(rig.pumpOnSends()).toBe(3);
    expect(physicalOn).toHaveLength(3);
    expect(rig.pumpHistory).not.toContain('on');
    expect(rig.pumpSamples).not.toContain('on');
    // The unconfirmed ON is undone by the best-effort OFF, which the actuator acknowledges.
    expect(rig.actuator.actual).toBe('off');
    expect(rig.pumpSamples.at(-1)).toBe('off');
  });
});

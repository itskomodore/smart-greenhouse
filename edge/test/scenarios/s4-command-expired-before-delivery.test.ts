/**
 * S4: a command that expires before it can be delivered must never reach the actuator.
 *   a) A manual `on` waits in the queue because the pump state is unknown (the actuator's
 *      query keeps failing). It expires (command_expiry_s = 30) before the state resolves.
 *      When the query finally succeeds, no pump_on may be sent.
 *   b) A pump_on persisted as `pending` by an earlier process has already expired when the
 *      controller boots. Recovery must close it as expired and never send it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { noReply } from '../../src/actuator/test-support.js';
import type { Command } from '../../src/types.js';
import { closeAllRigs, Rig, T0 } from '../harness/rig.js';
import { iso } from '../../src/actuator/clock.js';

afterEach(closeAllRigs);

const S = 1000;
const QUERY_RECOVERS_AT = T0 + 120 * S;

describe('S4 command expired before delivery', () => {
  it('S4: a queued manual on that expires while the pump state is unknown is never sent, even after the state resolves', async () => {
    const rig = await Rig.start({ settings: { command_expiry_s: 30 }, start: true });
    rig.actuator.behave = (call) => {
      if (call.kind === 'query' && rig.clock.now() < QUERY_RECOVERS_AT) return noReply();
      return rig.actuator.applyAndAck(call);
    };
    await rig.reading(50); // fresh, above low_threshold: nothing else may start the pump

    const res = await rig.ctl.requestManual({ cmd: 'on', duration_s: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const id = res.command.id;
    expect(res.command.state).toBe('pending');

    // Expiry is 30 s; the query has not succeeded yet, so the request sits in the queue and expires.
    await rig.runFor(40 * S);
    const expired = rig.mem.commands.get(id);
    expect(expired?.state).toBe('expired');
    expect(expired?.attempts).toBe(0);
    expect(expired?.last_error).toMatch(/not started before expiry/);
    expect(rig.ctl.pendingManual).toBeNull();

    // The pump state resolves later (query succeeds). The expired request must stay unsent.
    await rig.runUntil(() => rig.pumpSamples.at(-1) === 'off', 200 * S);
    expect(rig.clock.now()).toBeGreaterThan(QUERY_RECOVERS_AT);
    expect(rig.actuator.calls.filter((c) => c.kind === 'put' && c.type === 'pump_on')).toHaveLength(0);
    expect(rig.pumpOnSends()).toBe(0);
    expect(rig.pumpHistory).not.toContain('on');
    expect(rig.mem.commands.get(id)?.state).toBe('expired');
    expect(rig.mem.commands.get(id)?.attempts).toBe(0);
  });

  it('S4: a pump_on persisted as pending that expired before the restart is closed as expired and never sent', async () => {
    const rig0 = await Rig.start({ start: false });
    const staleId = '3f9b1c2e-0000-4000-8000-00000000abcd';
    const expired: Command = {
      id: staleId,
      ts: iso(T0 - 600 * S),
      type: 'pump_on',
      state: 'pending',
      expires_at: iso(T0 - 570 * S), // expired ten minutes before boot
      ack_ts: null,
      max_s: 20,
      attempts: 0,
      trigger: 'manual',
      reason: 'operator request (before restart)',
      last_error: null,
    };
    rig0.mem.commands.set(staleId, expired);
    await rig0.close();

    // Boot a new controller over the same store and actuator.
    const rig = await Rig.start({ mem: rig0.mem, actuator: rig0.actuator, clock: rig0.clock });
    await rig.runFor(60 * S);

    expect(rig.pumpOnSends()).toBe(0);
    expect(rig.pumpHistory).not.toContain('on');
    expect(rig.mem.commands.get(staleId)?.state).toBe('expired');
    expect(rig.mem.commands.get(staleId)?.attempts).toBe(0);
  });
});

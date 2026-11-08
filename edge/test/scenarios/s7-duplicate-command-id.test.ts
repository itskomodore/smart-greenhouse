/**
 * S7: a repeated command id is idempotent. The same id returns the same Command and sends nothing
 * new to the actuator, whether the first request is still queued, in flight, or already done.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { closeAllRigs, Rig } from '../harness/rig.js';

afterEach(closeAllRigs);

const S = 1000;
const ON_ID = '0c7e1f7a-1111-4222-8333-944455556666';
const OFF_ID = '0c7e1f7a-2222-4333-8444-955566667777';

describe('S7 duplicate command id', () => {
  it('S7: a manual on sent twice with the same id is sent once and both calls return the same Command', async () => {
    const rig = await Rig.start();
    await rig.runFor(2 * S);
    await rig.reading(50);

    const first = await rig.ctl.requestManual({ cmd: 'on', duration_s: 20, id: ON_ID });
    const second = await rig.ctl.requestManual({ cmd: 'on', duration_s: 20, id: ON_ID });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.command.id).toBe(first.command.id);
    expect(second.command.ts).toBe(first.command.ts);
    expect(second.command.expires_at).toBe(first.command.expires_at);

    // Once the start has been delivered, a replay still returns the same command and sends nothing.
    await rig.runUntil(() => rig.pumpSamples.at(-1) === 'on', 5 * S);
    const third = await rig.ctl.requestManual({ cmd: 'on', duration_s: 20, id: ON_ID });
    expect(third.ok).toBe(true);
    if (third.ok) {
      expect(third.duplicate).toBe(true);
      expect(third.command.id).toBe(ON_ID);
    }

    await rig.runFor(30 * S, S);
    expect(rig.pumpOnSends()).toBe(1);
    expect(rig.commandsOfType('pump_on').map((c) => c.id)).toEqual([ON_ID]);
    expect(rig.mem.commands.get(ON_ID)?.state).toBe('acked');
    await rig.close();
  });

  it('S7: a manual off sent twice with the same id is sent once', async () => {
    const rig = await Rig.start();
    await rig.runFor(2 * S);
    await rig.reading(50);
    const on = await rig.ctl.requestManual({ cmd: 'on', duration_s: 30 });
    expect(on.ok).toBe(true);
    await rig.runUntil(() => rig.pumpSamples.at(-1) === 'on', 5 * S);

    const off1 = await rig.ctl.requestManual({ cmd: 'off', id: OFF_ID });
    const off2 = await rig.ctl.requestManual({ cmd: 'off', id: OFF_ID });
    expect(off1.ok && off2.ok).toBe(true);
    if (!off1.ok || !off2.ok) return;
    expect(off1.duplicate).toBe(false);
    expect(off2.duplicate).toBe(true);
    expect(off2.command.id).toBe(OFF_ID);

    await rig.runFor(5 * S);
    expect(rig.actuator.calls.filter((c) => c.type === 'pump_off' && c.id === OFF_ID)).toHaveLength(1);
    expect(rig.pumpOffSends()).toBe(1);
    expect(rig.actuator.actual).toBe('off');
    await rig.close();
  });

  it('S7: two concurrent requests with the same id send one start (the second gets the same command, not a second send)', async () => {
    const rig = await Rig.start();
    await rig.runFor(2 * S);
    await rig.reading(50);

    const [a, b] = await Promise.all([
      rig.ctl.requestManual({ cmd: 'on', duration_s: 20, id: ON_ID }),
      rig.ctl.requestManual({ cmd: 'on', duration_s: 20, id: ON_ID }),
    ]);
    await rig.runFor(10 * S);

    // Safety property: never more than one send for the id.
    expect(rig.pumpOnSends()).toBe(1);
    // Idempotency property: the replay is answered with the same command, not a refusal.
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.command.id).toBe(a.command.id);
    await rig.close();
  });
});

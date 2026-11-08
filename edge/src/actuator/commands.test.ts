import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../log.js';
import type { Alarm, AlarmCode, Settings } from '../types.js';
import { ActuatorExpiredError } from './adapter.js';
import { CommandManager, type AlarmSink } from './commands.js';
import { drive, FakeActuator, FakeClock, MemRepo, noReply, T0 } from './test-support.js';

const silent = createLogger('test', 'silent');

class RecordingAlarms implements AlarmSink {
  readonly raised = new Map<AlarmCode, Alarm>();
  constructor(private readonly now: () => number = () => 0) {}
  async raise(code: AlarmCode, message: string): Promise<void> {
    if (!this.raised.has(code)) {
      this.raised.set(code, { code, since: new Date(this.now()).toISOString(), message, severity: 'critical' });
    }
  }
  async clear(code: AlarmCode): Promise<void> {
    this.raised.delete(code);
  }
  async clearIfStale(code: AlarmCode, minAgeMs: number): Promise<void> {
    const a = this.raised.get(code);
    if (a && this.now() - Date.parse(a.since) >= minAgeMs) this.raised.delete(code);
  }
}

function setup(settings: Partial<Settings> = {}) {
  const clock = new FakeClock(T0);
  const repo = new MemRepo(settings);
  const actuator = new FakeActuator(clock);
  const alarms = new RecordingAlarms(() => clock.now());
  const cm = new CommandManager({
    repo,
    adapter: actuator,
    clock,
    alarms,
    log: silent,
    getSettings: () => repo.settings,
    dbTimeoutMs: 20,
  });
  return { clock, repo, actuator, alarms, cm };
}

describe('CommandManager', () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => {
    env = setup();
  });

  it('never acks: exactly command_max_retries tries, then failed + alarms, never acked', async () => {
    const { cm, actuator, alarms, clock, repo } = env;
    actuator.behave = () => noReply();

    const sub = await cm.submit({ type: 'pump_on', trigger: 'manual', reason: 'test', max_s: 20 });
    const settled = await drive(sub.done, clock);

    expect(settled.command.state).toBe('failed');
    expect(settled.command.attempts).toBe(3);
    expect(settled.ack).toBeNull();
    expect(actuator.count('pump_on')).toBe(3);
    expect(alarms.raised.has('pump_failed')).toBe(true);
    expect(alarms.raised.has('actuator_unreachable')).toBe(true);
    expect((await repo.getCommand(sub.command.id))?.state).toBe('failed');
  });

  it('respects a different retry setting', async () => {
    env = setup({ command_max_retries: 1 });
    env.actuator.behave = () => noReply();
    const sub = await env.cm.submit({ type: 'pump_on', trigger: 'manual', reason: 't', max_s: 5 });
    const settled = await drive(sub.done, env.clock);
    expect(settled.command.state).toBe('failed');
    expect(env.actuator.count('pump_on')).toBe(1);
  });

  it('persists the command before the first send', async () => {
    const { cm, actuator, repo } = env;
    let persistedBeforeSend = false;
    actuator.behave = async (call) => {
      if (call.kind === 'put') persistedBeforeSend = (await repo.getCommand(call.cmd.id))?.state === 'sent';
      return actuator.applyAndAck(call);
    };
    const sub = await cm.submit({ type: 'pump_off', trigger: 'manual', reason: 't' });
    await drive(sub.done, env.clock);
    expect(persistedBeforeSend).toBe(true);
  });

  it('acks, records ack_ts and clears alarms', async () => {
    const { cm, alarms, clock } = env;
    alarms.raised.set('actuator_unreachable', { code: 'actuator_unreachable', since: '', message: '', severity: 'critical' });
    const sub = await cm.submit({ type: 'pump_off', trigger: 'manual', reason: 't' });
    const settled = await drive(sub.done, clock);
    expect(settled.command.state).toBe('acked');
    expect(settled.command.ack_ts).not.toBeNull();
    expect(settled.ack?.pump).toBe('off');
    expect(alarms.raised.has('actuator_unreachable')).toBe(false);
  });

  it('does not send a command whose expires_at has passed (expired, zero sends)', async () => {
    const { cm, actuator, clock, repo } = env;
    const { command } = await cm.create({ type: 'pump_on', trigger: 'manual', reason: 't', max_s: 10 });
    await clock.advance(31_000); // command_expiry_s default is 30
    const settled = await cm.dispatch(command);
    expect(settled.command.state).toBe('expired');
    expect(actuator.calls).toHaveLength(0);
    expect((await repo.getCommand(command.id))?.state).toBe('expired');
  });

  it('expires during retry backoff and never sends after expires_at', async () => {
    env = setup({ command_expiry_s: 1 });
    const { cm, actuator, clock } = env;
    actuator.behave = () => noReply();
    const sub = await cm.submit({ type: 'pump_on', trigger: 'manual', reason: 't', max_s: 10 });
    const settled = await drive(sub.done, clock);
    expect(settled.command.state).toBe('expired');
    // attempt 1 at t=0, attempt 2 at t=500ms; 1500ms is past the 1 s expiry, so no third send.
    expect(actuator.count('pump_on')).toBe(2);
    expect(settled.command.attempts).toBe(2); // possibly applied: the controller must treat as unknown
    for (const call of actuator.calls) expect(call.at).toBeLessThan(Date.parse(sub.command.expires_at));
  });

  it('an actuator-side 4.08 marks the command expired without retries', async () => {
    const { cm, actuator, clock } = env;
    actuator.behave = () => Promise.reject(new ActuatorExpiredError('4.08'));
    const sub = await cm.submit({ type: 'pump_on', trigger: 'manual', reason: 't', max_s: 10 });
    const settled = await drive(sub.done, clock);
    expect(settled.command.state).toBe('expired');
    expect(actuator.count('pump_on')).toBe(1);
  });

  it('duplicate id is idempotent: returns the existing command and sends nothing again', async () => {
    const { cm, actuator, clock } = env;
    const first = await cm.submit({ id: 'cmd-1', type: 'pump_on', trigger: 'manual', reason: 't', max_s: 10 });
    await drive(first.done, clock);
    expect(actuator.count('pump_on')).toBe(1);

    const again = await cm.submit({ id: 'cmd-1', type: 'pump_on', trigger: 'manual', reason: 't', max_s: 10 });
    expect(again.duplicate).toBe(true);
    expect(again.command.id).toBe('cmd-1');
    const settled = await again.done;
    expect(settled.command.state).toBe('acked');
    expect(actuator.count('pump_on')).toBe(1);
  });

  it('duplicate id while the first copy is still retrying: same run, no second send stream', async () => {
    const { cm, actuator, clock } = env;
    actuator.behave = () => noReply();
    const first = await cm.submit({ id: 'cmd-2', type: 'pump_on', trigger: 'manual', reason: 't', max_s: 10 });
    const second = await cm.submit({ id: 'cmd-2', type: 'pump_on', trigger: 'manual', reason: 't', max_s: 10 });
    expect(second.duplicate).toBe(true);
    const [a, b] = await Promise.all([drive(first.done, clock), drive(second.done, clock)]);
    expect(a.command.state).toBe('failed');
    expect(b.command.state).toBe('failed');
    expect(actuator.count('pump_on')).toBe(3);
  });

  it('rejects pump_on without a valid max_s', async () => {
    await expect(env.cm.create({ type: 'pump_on', trigger: 'manual', reason: 't', max_s: 0 })).rejects.toThrow(RangeError);
    await expect(env.cm.create({ type: 'pump_on', trigger: 'manual', reason: 't', max_s: null })).rejects.toThrow(RangeError);
  });

  it('recover: expires stale open commands, never re-sends an open pump_on, re-dispatches pump_off', async () => {
    const { repo, clock } = env;
    const base = {
      ts: new Date(T0).toISOString(),
      ack_ts: null,
      attempts: 1,
      trigger: 'auto' as const,
      reason: 'old',
      last_error: null,
    };
    await repo.upsertCommand({
      ...base,
      id: 'stale',
      type: 'pump_off',
      state: 'sent',
      expires_at: new Date(T0 - 1000).toISOString(),
      max_s: null,
    });
    await repo.upsertCommand({
      ...base,
      id: 'on-open',
      type: 'pump_on',
      state: 'sent',
      expires_at: new Date(T0 + 30_000).toISOString(),
      max_s: 20,
    });
    await repo.upsertCommand({
      ...base,
      id: 'off-open',
      type: 'pump_off',
      state: 'pending',
      expires_at: new Date(T0 + 30_000).toISOString(),
      max_s: null,
    });

    const { cm, actuator } = env;
    const interrupted = await cm.recover();
    expect(interrupted.map((c) => c.id)).toEqual(['on-open']);
    expect((await repo.getCommand('stale'))?.state).toBe('expired');
    expect((await repo.getCommand('on-open'))?.state).toBe('failed');
    await clock.advance(100);
    expect(actuator.count('pump_on')).toBe(0);
    expect((await repo.getCommand('off-open'))?.state).toBe('acked');
  });

  it('cancel that lands between the persist and the send: nothing is sent', async () => {
    const { cm, actuator, clock, repo } = env;
    repo.onUpsert = (c) => {
      if (c.state === 'sent') cm.cancel(['pump_on'], 'superseded');
    };
    const sub = await cm.submit({ type: 'pump_on', trigger: 'manual', reason: 't', max_s: 10 });
    const settled = await drive(sub.done, clock);
    expect(settled.command.state).toBe('failed');
    expect(settled.command.last_error).toBe('cancelled: superseded');
    expect(actuator.count('pump_on')).toBe(0);
  });

  it('expiry that passes between the persist and the send: nothing is sent', async () => {
    const { cm, actuator, clock, repo } = env;
    let armed = true;
    repo.onUpsert = (c) => {
      if (armed && c.state === 'sent') {
        armed = false;
        clock.jump(31_000);
      }
    };
    const sub = await cm.submit({ type: 'pump_on', trigger: 'manual', reason: 't', max_s: 10 });
    const settled = await drive(sub.done, clock);
    expect(settled.command.state).toBe('expired');
    expect(settled.command.attempts).toBe(0); // never sent, so not 'possibly applied'
    expect(actuator.count('pump_on')).toBe(0);
  });

  it('pump_off is sent even when every repo call hangs', async () => {
    const { cm, actuator, clock, repo } = env;
    repo.faults = 'hang';
    const sub = await cm.submit({ type: 'pump_off', trigger: 'recovery', reason: 'guard' });
    const settled = await drive(sub.done, clock);
    expect(settled.command.state).toBe('acked');
    expect(actuator.count('pump_off')).toBe(1);
    expect(actuator.actual).toBe('off');
  });

  it('recover returns an expired pump_on too, so the controller still sends OFF', async () => {
    const { cm, repo } = env;
    await repo.upsertCommand({
      id: 'old-on',
      ts: new Date(T0 - 60_000).toISOString(),
      type: 'pump_on',
      state: 'sent',
      expires_at: new Date(T0 - 30_000).toISOString(),
      ack_ts: null,
      max_s: 10,
      attempts: 1,
      trigger: 'auto',
      reason: 'old',
      last_error: null,
    });
    const interrupted = await cm.recover();
    expect(interrupted.map((c) => c.id)).toEqual(['old-on']);
    expect((await repo.getCommand('old-on'))?.state).toBe('expired');
  });

  it('keeps in-memory terminal entries bounded', async () => {
    const { cm } = env;
    for (let i = 0; i < 260; i++) {
      const { command } = await cm.create({ type: 'pump_off', trigger: 'manual', reason: `n${i}` });
      await cm.closeUnsent(command, 'failed', 'test');
    }
    expect(cm.trackedCount()).toBeLessThanOrEqual(200);
  });

  it('pump_failed latches: an OFF ack does not clear it; a pump_on ack does', async () => {
    const { cm, alarms, clock } = env;
    alarms.raised.set('pump_failed', { code: 'pump_failed', since: new Date(clock.now()).toISOString(), message: 'x', severity: 'critical' });
    const off = await cm.submit({ type: 'pump_off', trigger: 'recovery', reason: 't' });
    await drive(off.done, clock);
    expect(alarms.raised.has('pump_failed')).toBe(true);
    const on = await cm.submit({ type: 'pump_on', trigger: 'manual', reason: 't', max_s: 5 });
    await drive(on.done, clock);
    expect(alarms.raised.has('pump_failed')).toBe(false);
  });

  it('pump_failed clears on an OFF ack only after 15 minutes', async () => {
    const { cm, alarms, clock } = env;
    alarms.raised.set('pump_failed', { code: 'pump_failed', since: new Date(clock.now()).toISOString(), message: 'x', severity: 'critical' });
    clock.jump(14 * 60 * 1000);
    const early = await cm.submit({ type: 'pump_off', trigger: 'recovery', reason: 't' });
    await drive(early.done, clock);
    expect(alarms.raised.has('pump_failed')).toBe(true);
    clock.jump(2 * 60 * 1000);
    const late = await cm.submit({ type: 'pump_off', trigger: 'recovery', reason: 't' });
    await drive(late.done, clock);
    expect(alarms.raised.has('pump_failed')).toBe(false);
  });
});

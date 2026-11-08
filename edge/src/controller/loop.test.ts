import { afterEach, describe, expect, it } from 'vitest';
import { createBus, type TypedBus } from '../bus.js';
import { appliedButLost, driveUntil, FakeActuator, FakeClock, makeReading, MemRepo, noReply, settle, T0 } from '../actuator/test-support.js';
import { createLogger } from '../log.js';
import type { AlarmCode, Decision, ReadingAssessment, RulesState, Settings } from '../types.js';
import { Controller, GUARD_RETRY_MS, JUMP_MIN_SPAN_MS, type SoilPoint } from './loop.js';
import { noReply as lostReply } from '../actuator/test-support.js';

// Local-day arithmetic in the controller uses the process time zone; pin it for stable runtime totals.
process.env.TZ = 'UTC';

const silent = createLogger('test', 'silent');

/**
 * Stand-in for decide(): the real engine is tested in src/rules. This one only needs the
 * behaviours the controller relies on (query when unknown, start on manual, refuse with reason).
 */
function fakeDecide(s: RulesState): Decision {
  const none = (reason: string): Decision => ({ action: 'none', reason, alarms: [] });
  const m = s.manual;
  if (m?.cmd === 'on') {
    if (s.pump === 'unknown') return { action: 'query', reason: 'pump unknown', alarms: ['actuator_state_unknown'] };
    if (s.commandInFlight) return none('command in flight');
    if (s.pump === 'on') return none('pump already on');
    if (!s.latest || s.now - s.latest.ts > s.settings.stale_timeout_s * 1000) return none('sensor stale');
    if (s.dailyRuntimeMs >= s.settings.daily_max_s * 1000) return none('daily cap reached');
    return { action: 'start', max_s: Math.min(m.duration_s, s.settings.max_run_s), trigger: 'manual', reason: 'manual', alarms: [] };
  }
  if (s.pump === 'unknown') return { action: 'query', reason: 'pump unknown', alarms: ['actuator_state_unknown'] };
  return none('idle');
}

/** Accept unless the jump from the baseline exceeds max_soil_jump_pct. */
function fakeAssess(prev: SoilPoint | null, next: SoilPoint, settings: Settings): ReadingAssessment {
  if (prev === null || Math.abs(next.soil_pct - prev.soil_pct) <= settings.max_soil_jump_pct) return { accept: true };
  return { accept: false, reason: `jump ${Math.abs(next.soil_pct - prev.soil_pct).toFixed(1)} pct` };
}

interface Env {
  clock: FakeClock;
  repo: MemRepo;
  actuator: FakeActuator;
  bus: TypedBus;
  ctl: Controller;
  pumpStates: string[];
  alarmCodes: AlarmCode[];
  states: RulesState[];
}

function build(opts: { reading?: boolean; settings?: Partial<Settings>; repo?: MemRepo; clock?: FakeClock; actuator?: FakeActuator; bus?: TypedBus; dbTimeoutMs?: number; tickTimeoutMs?: number; decide?: (s: RulesState) => Decision } = {}): Env {
  const clock = opts.clock ?? new FakeClock(T0);
  const repo = opts.repo ?? new MemRepo(opts.settings ?? {});
  const actuator = opts.actuator ?? new FakeActuator(clock);
  const bus = opts.bus ?? createBus();
  const pumpStates: string[] = [];
  const alarmCodes: AlarmCode[] = [];
  const states: RulesState[] = [];
  bus.on('pump', (p) => pumpStates.push(p.state));
  bus.on('alarms', (a) => alarmCodes.push(...a.map((x) => x.code)));
  const ctl = new Controller({
    repo,
    adapter: actuator,
    bus,
    clock,
    log: silent,
    decide: (s) => {
      states.push(s);
      return opts.decide ? opts.decide(s) : fakeDecide(s);
    },
    assessReading: fakeAssess,
    dbTimeoutMs: opts.dbTimeoutMs ?? 20,
    tickTimeoutMs: opts.tickTimeoutMs ?? 2000,
  });
  return { clock, repo, actuator, bus, ctl, pumpStates, alarmCodes, states };
}

let open: Controller[] = [];
afterEach(() => {
  for (const c of open) c.stop();
  open = [];
});

/** Start with a fresh sensor reading and the pump known OFF (query answered). */
/** A live sensor reading arriving on the bus (boot does not seed `latest`). */
async function liveReading(env: Env, soil = 20): Promise<void> {
  env.bus.emit('reading', makeReading(soil, env.clock.now()));
  await settle();
}

async function startKnownOff(env: Env): Promise<void> {
  open.push(env.ctl);
  await env.ctl.start();
  await liveReading(env);
  await env.ctl.tick();
  await driveUntil(() => env.ctl.pumpState === 'off', env.clock);
}

describe('Controller: actuator failure handling', () => {
  it('never-acks: 3 tries then failed; pump never assumed on; best-effort OFF', async () => {
    const env = build();
    await startKnownOff(env);
    env.actuator.behave = (call) =>
      call.kind === 'put' && call.cmd.type === 'pump_on' ? noReply() : env.actuator.applyAndAck(call);

    const res = await env.ctl.requestManual({ cmd: 'on', duration_s: 20 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await env.ctl.tick();

    await driveUntil(
      () => env.repo.commands.get(res.command.id)?.state === 'failed' && env.ctl.pumpState === 'off' && env.ctl.activeRun === null,
      env.clock,
    );

    expect(env.actuator.count('pump_on')).toBe(3);
    expect(env.repo.commands.get(res.command.id)?.state).toBe('failed');
    expect(env.repo.commands.get(res.command.id)?.attempts).toBe(3);
    expect(env.pumpStates).not.toContain('on');
    expect(env.alarmCodes).toContain('pump_failed');
    expect(env.alarmCodes).toContain('actuator_unreachable');
    expect(env.actuator.actual).toBe('off');
    // The unacked start produced an audit row (conservative runtime), not a running event.
    expect(env.repo.events.every((e) => e.result !== 'running')).toBe(true);
  });

  it('manual on stays pending while the pump state is unknown, then starts once it is known', async () => {
    const env = build();
    open.push(env.ctl);
    await env.ctl.start();
    await liveReading(env);
    let queries = 0;
    env.actuator.behave = (call) => {
      if (call.kind === 'query') {
        queries++;
        return queries <= 3 ? noReply() : env.actuator.applyAndAck(call);
      }
      return env.actuator.applyAndAck(call);
    };

    const res = await env.ctl.requestManual({ cmd: 'on', duration_s: 10 });
    expect(res.ok).toBe(true);
    await env.ctl.tick(); // query fails (3 lost replies)
    await env.clock.advance(3000);
    expect(env.ctl.pumpState).toBe('unknown');
    expect(env.ctl.pendingManual).not.toBeNull(); // kept, not dropped
    expect(env.actuator.count('pump_on')).toBe(0);

    await env.clock.advance(11_000); // past the query cooldown
    await env.ctl.tick(); // query answers OFF
    await driveUntil(() => env.ctl.pumpState === 'off', env.clock);
    await env.ctl.tick(); // decide now starts the queued manual on
    await driveUntil(() => env.ctl.pumpState === 'on', env.clock);

    expect(env.actuator.count('pump_on')).toBe(1);
    expect(env.ctl.pendingManual).toBeNull();
  });

  it('refuses a manual on with the decide() reason when the rules say none', async () => {
    const env = build(); // no reading at all => decide says sensor stale
    open.push(env.ctl);
    await env.ctl.start();
    await env.ctl.tick();
    await driveUntil(() => env.ctl.pumpState === 'off', env.clock);

    const res = await env.ctl.requestManual({ cmd: 'on', duration_s: 10 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await env.ctl.tick();
    const stored = env.repo.commands.get(res.command.id);
    expect(stored?.state).toBe('failed');
    expect(stored?.last_error).toBe('refused: sensor stale');
    expect(env.actuator.count('pump_on')).toBe(0);
  });
});

describe('Controller: expiry and idempotency', () => {
  it('an expired manual command is never sent', async () => {
    const env = build();
    open.push(env.ctl);
    await env.ctl.start();
    await liveReading(env);
    env.actuator.behave = (call) => (call.kind === 'query' ? noReply() : env.actuator.applyAndAck(call));

    const res = await env.ctl.requestManual({ cmd: 'on', duration_s: 10 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await env.ctl.tick(); // pump unknown => query, which never answers
    await env.clock.advance(2000);
    await env.clock.advance(31_000); // past command_expiry_s (30)
    await env.ctl.tick();

    expect(env.repo.commands.get(res.command.id)?.state).toBe('expired');
    expect(env.actuator.calls.filter((c) => c.type === 'pump_on')).toHaveLength(0);
    expect(env.ctl.pendingManual).toBeNull();
  });

  it('duplicate idempotency id returns the same command and does not resend', async () => {
    const env = build();
    await startKnownOff(env);

    const first = await env.ctl.requestManual({ cmd: 'on', duration_s: 5, id: 'dup-1' });
    expect(first.ok && first.duplicate).toBe(false);
    await env.ctl.tick();
    await driveUntil(() => env.ctl.pumpState === 'on', env.clock);

    const second = await env.ctl.requestManual({ cmd: 'on', duration_s: 5, id: 'dup-1' });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.duplicate).toBe(true);
    expect(second.command.id).toBe('dup-1');
    expect(second.command.state).toBe('acked');
    expect(env.actuator.count('pump_on')).toBe(1);
  });

  it('refuses invalid durations and a start while the pump is running', async () => {
    const env = build({ settings: { max_run_s: 60 } });
    await startKnownOff(env);
    const bad = await env.ctl.requestManual({ cmd: 'on', duration_s: 0 });
    expect(bad.ok).toBe(false);
    const tooLong = await env.ctl.requestManual({ cmd: 'on', duration_s: 61 });
    expect(tooLong.ok).toBe(false);

    await env.ctl.requestManual({ cmd: 'on', duration_s: 30 });
    await env.ctl.tick();
    await driveUntil(() => env.ctl.pumpState === 'on', env.clock);
    const busy = await env.ctl.requestManual({ cmd: 'on', duration_s: 5 });
    expect(busy).toMatchObject({ ok: false, code: 'run_active' });
  });
});

describe('Controller: restart and runtime', () => {
  it('restart mid-irrigation: OFF is sent, the open event is aborted, control resumes quickly', async () => {
    const env = build();
    await startKnownOff(env);
    await env.ctl.requestManual({ cmd: 'on', duration_s: 30 });
    await env.ctl.tick();
    await driveUntil(() => env.ctl.pumpState === 'on' && env.ctl.activeRun?.eventId != null, env.clock);
    expect(env.actuator.actual).toBe('on');
    expect(env.repo.events.filter((e) => e.ts_end === null)).toHaveLength(1);

    // Crash: the first process goes away; a new one boots on the same repo and actuator.
    env.ctl.stop();
    const bus2 = createBus();
    const ctl2 = new Controller({
      repo: env.repo,
      adapter: env.actuator,
      bus: bus2,
      clock: env.clock,
      log: silent,
      decide: fakeDecide,
      assessReading: fakeAssess,
    });
    open.push(ctl2);
    await env.clock.advance(1000);
    const bootAt = env.clock.now();
    await ctl2.start();

    expect(ctl2.pumpState).toBe('off');
    expect(env.actuator.actual).toBe('off');
    expect(env.actuator.count('pump_on')).toBe(1); // no new start from the new process
    expect(env.actuator.count('pump_off')).toBe(1);
    expect(env.repo.events.find((e) => e.ts_end === null)).toBeUndefined();
    const aborted = env.repo.events.find((e) => e.result === 'aborted');
    expect(aborted?.ts_end).not.toBeNull();
    expect(env.clock.now() - bootAt).toBeLessThan(60_000);
  });

  it('max runtime stop: OFF ack lost is retried by the guard until acknowledged', async () => {
    const env = build();
    await startKnownOff(env);
    await env.ctl.requestManual({ cmd: 'on', duration_s: 5 });
    await env.ctl.tick();
    await driveUntil(() => env.ctl.pumpState === 'on' && env.ctl.activeRun?.eventId != null, env.clock);

    env.actuator.behave = (call) =>
      call.kind === 'put' && call.cmd.type === 'pump_off' ? appliedButLost(env.actuator, 'off')() : env.actuator.applyAndAck(call);
    await env.clock.advance(10_000); // past max_s (5) + grace
    await env.ctl.tick();
    await driveUntil(() => env.actuator.count('pump_off') >= 3 && env.ctl.pumpState === 'unknown', env.clock);
    expect(env.ctl.activeRun).not.toBeNull();
    // The row is closed at the forced stop (runtime charged); the pump itself is still unknown.
    expect(env.repo.events.find((e) => e.result === 'stopped' && e.ts_end !== null)).toBeDefined();
    expect(env.ctl.pumpState).toBe('unknown');

    env.actuator.behave = (call) => env.actuator.applyAndAck(call);
    await env.clock.advance(GUARD_RETRY_MS + 1);
    await env.ctl.tick();
    await driveUntil(() => env.ctl.activeRun === null, env.clock);

    expect(env.ctl.pumpState).toBe('off');
    // Guard-forced stops are recorded as 'stopped', not a normal completion.
    const ev = env.repo.events.find((e) => e.result === 'stopped');
    expect(ev).toBeDefined();
    expect(ev?.ts_end).not.toBeNull();
    expect(env.repo.events.filter((e) => e.ts_end === null)).toHaveLength(0);
  });

  it('decide() receives completed runtime only: the running portion is not double counted', async () => {
    const env = build();
    await startKnownOff(env);
    await env.ctl.requestManual({ cmd: 'on', duration_s: 20 });
    await env.ctl.tick();
    await driveUntil(() => env.ctl.pumpState === 'on' && env.ctl.activeRun?.eventId != null, env.clock);

    await env.clock.advance(3000);
    await env.ctl.tick();
    expect(env.states.at(-1)?.dailyRuntimeMs).toBe(0);

    await env.ctl.requestManual({ cmd: 'off' });
    await driveUntil(() => env.ctl.activeRun === null, env.clock);
    const ev = env.repo.events.find((e) => e.ts_end !== null && e.result === 'stopped');
    expect(ev).toBeDefined();
    const closedMs = Date.parse(ev!.ts_end!) - Date.parse(ev!.ts_start);
    await env.ctl.tick();
    expect(env.states.at(-1)?.dailyRuntimeMs).toBe(closedMs);
  });
});

describe('Controller: jump filter latch', () => {
  it('rejects implausible readings, raises soil_jump_ignored, and re-baselines after 3 agreeing rejections', async () => {
    const env = build();
    open.push(env.ctl);
    await env.ctl.start();
    const emit = async (soil: number, gapMs = 30_000): Promise<void> => {
      env.bus.emit('reading', makeReading(soil, env.clock.now()));
      await env.clock.advance(gapMs);
    };

    await emit(30); // first reading: no baseline, accepted
    expect(env.ctl.latestAccepted?.soil_pct).toBe(30);

    await emit(80);
    expect(env.ctl.latestAccepted?.soil_pct).toBe(30);
    expect(env.repo.alarms.has('soil_jump_ignored')).toBe(true);
    await emit(81);
    await emit(80.5); // third rejection, spread <= 10 and span 60 s
    expect(env.ctl.latestAccepted?.soil_pct).toBe(80.5);
    // Operator-visible notice stays up for REBASELINE_NOTICE_MS.
    expect(env.repo.alarms.get('soil_jump_ignored')?.message).toMatch(/re-established/);

    await emit(81, 1000); // normal acceptance again
    expect(env.ctl.latestAccepted?.soil_pct).toBe(81);
    expect(env.repo.alarms.has('soil_jump_ignored')).toBe(true);
  });

  it('does not re-baseline when the rejected readings disagree', async () => {
    const env = build();
    open.push(env.ctl);
    await env.ctl.start();
    const emit = async (soil: number): Promise<void> => {
      env.bus.emit('reading', makeReading(soil, env.clock.now()));
      await env.clock.advance(1000);
    };
    await emit(30);
    await emit(90);
    await emit(72);
    await emit(95);
    expect(env.ctl.latestAccepted?.soil_pct).toBe(30);
    expect(env.repo.alarms.has('soil_jump_ignored')).toBe(true);
  });

  it('a burst of agreeing rejections within one minute does not re-baseline', async () => {
    const env = build();
    open.push(env.ctl);
    await env.ctl.start();
    const emit = async (soil: number): Promise<void> => {
      env.bus.emit('reading', makeReading(soil, env.clock.now()));
      await env.clock.advance(1000);
    };
    await emit(30);
    await emit(80);
    await emit(81);
    await emit(80.5);
    await emit(80.2);
    expect(env.ctl.latestAccepted?.soil_pct).toBe(30);
    expect(JUMP_MIN_SPAN_MS).toBe(60_000);
  });
});

describe('Controller: regressions from review', () => {
  it('repo hangs everywhere: a run past max_s still gets OFF, and the tick is not blocked', async () => {
    const env = build();
    await startKnownOff(env);
    await env.ctl.requestManual({ cmd: 'on', duration_s: 5 });
    await env.ctl.tick();
    await driveUntil(() => env.ctl.pumpState === 'on' && env.ctl.activeRun?.eventId != null, env.clock);

    env.repo.faults = 'hang';
    await env.clock.advance(8000);
    const t0 = Date.now();
    await env.ctl.tick();
    expect(Date.now() - t0).toBeLessThan(1000);
    await driveUntil(() => env.actuator.actual === 'off' && env.ctl.pumpState === 'off', env.clock);
    expect(env.actuator.count('pump_off')).toBeGreaterThanOrEqual(1);
  });

  it('repo throws everywhere: the guard still sends OFF', async () => {
    const env = build();
    await startKnownOff(env);
    await env.ctl.requestManual({ cmd: 'on', duration_s: 5 });
    await env.ctl.tick();
    await driveUntil(() => env.ctl.pumpState === 'on' && env.ctl.activeRun?.eventId != null, env.clock);

    env.repo.faults = 'throw';
    await env.clock.advance(8000);
    await env.ctl.tick();
    await driveUntil(() => env.actuator.actual === 'off' && env.ctl.pumpState === 'off', env.clock);
  });

  it('a stuck tick is released by its deadline so the next tick can run', async () => {
    const env = build({ dbTimeoutMs: 5000, tickTimeoutMs: 50 });
    await startKnownOff(env);
    env.repo.faults = 'hang';
    const t0 = Date.now();
    await env.ctl.tick();
    await env.ctl.tick();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('late ON ack after the run was closed: pump never claimed on, event extended, OFF re-sent', async () => {
    const env = build();
    await startKnownOff(env);
    const hooks: { release?: () => void } = {};
    env.actuator.behave = (call) => {
      if (call.kind === 'put' && call.cmd.type === 'pump_on') {
        env.actuator.actual = 'on';
        return new Promise((resolve) => {
          hooks.release = () => resolve({ command_id: call.cmd.id, pump: 'on', remaining_s: 30 });
        });
      }
      return env.actuator.applyAndAck(call);
    };
    await env.ctl.requestManual({ cmd: 'on', duration_s: 30 });
    await env.ctl.tick();
    await driveUntil(() => hooks.release !== undefined, env.clock);

    await env.ctl.requestManual({ cmd: 'off' });
    await driveUntil(() => env.ctl.pumpState === 'off' && env.ctl.activeRun === null, env.clock);
    env.actuator.behave = (call) => env.actuator.applyAndAck(call);
    await env.clock.advance(500);
    const lateAt = env.clock.now();
    hooks.release?.();
    await driveUntil(() => env.actuator.count('pump_off') >= 2 && env.ctl.pumpState === 'off', env.clock);

    expect(env.pumpStates).not.toContain('on');
    expect(env.actuator.actual).toBe('off');
    const ev = env.repo.events[0];
    expect(ev?.result).toBe('stopped');
    expect(Date.parse(ev!.ts_end!)).toBeGreaterThanOrEqual(lateAt);
  });

  it('an OFF ack that does not report off leaves the pump unknown and re-sends OFF', async () => {
    const env = build();
    await startKnownOff(env);
    await env.ctl.requestManual({ cmd: 'on', duration_s: 30 });
    await env.ctl.tick();
    await driveUntil(() => env.ctl.pumpState === 'on' && env.ctl.activeRun?.eventId != null, env.clock);

    let offCalls = 0;
    env.actuator.behave = (call) => {
      if (call.kind === 'put' && call.cmd.type === 'pump_off') {
        offCalls++;
        if (offCalls === 1) return Promise.resolve({ command_id: call.cmd.id, pump: 'on' as const });
      }
      return env.actuator.applyAndAck(call);
    };
    await env.ctl.requestManual({ cmd: 'off' });
    await driveUntil(() => env.actuator.count('pump_off') >= 1 && env.ctl.pumpState === 'unknown', env.clock);
    expect(env.ctl.pumpState).toBe('unknown');

    await env.clock.advance(GUARD_RETRY_MS + 1);
    await env.ctl.tick();
    await driveUntil(() => env.ctl.pumpState === 'off' && env.ctl.activeRun === null, env.clock);
    expect(env.actuator.count('pump_off')).toBe(2);
  });

  it('start timed out then expired (possibly applied): pump unknown and a safe OFF is sent', async () => {
    const env = build({ settings: { command_expiry_s: 1 } });
    await startKnownOff(env);
    env.actuator.behave = (call) =>
      call.kind === 'put' && call.cmd.type === 'pump_on' ? lostReply() : env.actuator.applyAndAck(call);
    await env.ctl.requestManual({ cmd: 'on', duration_s: 10 });
    await env.ctl.tick();
    await driveUntil(() => env.actuator.count('pump_off') >= 1 && env.ctl.pumpState === 'off', env.clock);
    expect(env.pumpStates).not.toContain('on');
    expect(env.actuator.count('pump_on')).toBe(2);
  });

  it('concurrent manual on requests: exactly one is accepted', async () => {
    const env = build();
    await startKnownOff(env);
    const [a, b] = await Promise.all([
      env.ctl.requestManual({ cmd: 'on', duration_s: 5 }),
      env.ctl.requestManual({ cmd: 'on', duration_s: 6 }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const refused = a.ok ? b : a;
    expect(refused).toMatchObject({ ok: false, code: 'manual_pending' });
  });

  it('restart: min interval survives (lastRunEndedAt from DB) and latest is not seeded from an old reading', async () => {
    const repo = new MemRepo();
    await repo.insertEvent({
      ts_start: new Date(T0 - 600_000).toISOString(),
      ts_end: new Date(T0 - 300_000).toISOString(),
      trigger: 'auto',
      reason: 'earlier',
      result: 'completed',
    });
    await repo.insertReading(makeReading(20, T0 - 1000));
    const env = build({ repo });
    open.push(env.ctl);
    await env.ctl.start();
    await env.ctl.tick();
    expect(env.states[0]?.lastRunEndedAt).toBe(T0 - 300_000);
    expect(env.states[0]?.latest).toBeNull();
    expect(env.ctl.latestAccepted).toBeNull();
  });

  it('aborted-event update fails once: it is retried and the boot still completes', async () => {
    const env = build();
    await startKnownOff(env);
    await env.ctl.requestManual({ cmd: 'on', duration_s: 30 });
    await env.ctl.tick();
    await driveUntil(() => env.ctl.pumpState === 'on' && env.ctl.activeRun?.eventId != null, env.clock);
    env.ctl.stop();
    env.repo.failNextUpdateEvent = true;
    const ctl2 = new Controller({
      repo: env.repo,
      adapter: env.actuator,
      bus: createBus(),
      clock: env.clock,
      log: silent,
      decide: fakeDecide,
      assessReading: fakeAssess,
      dbTimeoutMs: 20,
    });
    open.push(ctl2);
    await ctl2.start();
    expect(ctl2.pumpState).toBe('off');
    expect(env.repo.events.find((e) => e.result === 'aborted')).toBeDefined();
  });

  it('insert failure at ack: the run is still recorded as the real run, not as an unacked start', async () => {
    const env = build();
    await startKnownOff(env);
    env.repo.failNextInsertEvent = true;
    await env.ctl.requestManual({ cmd: 'on', duration_s: 30 });
    await env.ctl.tick();
    await driveUntil(() => env.ctl.pumpState === 'on', env.clock);
    await env.ctl.requestManual({ cmd: 'off' });
    await driveUntil(() => env.ctl.activeRun === null, env.clock);
    expect(env.repo.events).toHaveLength(1);
    expect(env.repo.events[0]?.result).toBe('stopped');
    expect(env.repo.events[0]?.reason).not.toMatch(/not acknowledged/);
  });

  it('manual OFF overtakes an auto start that is still creating its command: no ON is ever sent', async () => {
    const autoDecide = (s: RulesState): Decision =>
      !s.manual && s.pump === 'off' && s.latest && !s.commandInFlight
        ? { action: 'start', max_s: 5, trigger: 'auto', reason: 'auto', alarms: [] }
        : fakeDecide(s);
    const env = build({ decide: autoDecide });
    await startKnownOff(env);
    let hooked = false;
    env.repo.onUpsert = (c) => {
      if (c.type === 'pump_on' && c.state === 'pending' && !hooked) {
        hooked = true;
        return env.ctl.requestManual({ cmd: 'off' }).then(() => undefined);
      }
      return undefined;
    };
    await env.ctl.tick();
    await driveUntil(() => env.actuator.count('pump_off') >= 1 && env.ctl.pumpState === 'off', env.clock);
    await settle();
    expect(env.actuator.count('pump_on')).toBe(0);
    const on = [...env.repo.commands.values()].find((c) => c.type === 'pump_on');
    expect(on?.state).toBe('failed');
    expect(on?.last_error).toBe('superseded by off');
  });

  it('daily budget counts a run closed while the DB was down; new starts are refused while it is down', async () => {
    const env = build({ settings: { daily_max_s: 10, max_run_s: 60 } });
    await startKnownOff(env);
    await env.ctl.requestManual({ cmd: 'on', duration_s: 8 });
    await env.ctl.tick();
    await driveUntil(() => env.ctl.pumpState === 'on' && env.ctl.activeRun?.eventId != null, env.clock);

    await env.clock.advance(7000); // run ~7 s, still under max_s (8)
    env.repo.faults = 'throw';
    await env.ctl.requestManual({ cmd: 'off' });
    await driveUntil(() => env.ctl.activeRun === null && env.ctl.pumpState === 'off', env.clock);
    expect(env.ctl.dailyRuntimeSeconds).toBeGreaterThanOrEqual(7);

    const refused = await env.ctl.requestManual({ cmd: 'on', duration_s: 5 });
    expect(refused.ok).toBe(false);

    env.repo.faults = 'ok';
    const res = await env.ctl.requestManual({ cmd: 'on', duration_s: 60 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // DB still shows the event open, but this process counted the run: the remaining budget is what is left.
    expect(res.command.max_s).toBe(10 - env.ctl.dailyRuntimeSeconds);
    expect(res.command.max_s).toBeLessThan(5);
  });

  it('DB-down ticks do not block on the database and still run the guard', async () => {
    const env = build({ dbTimeoutMs: 5000, tickTimeoutMs: 5000 });
    await startKnownOff(env);
    env.repo.faults = 'hang';
    const t0 = Date.now();
    await env.ctl.tick();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(env.ctl.healthy).toBe(false);
  });

  it('a run acknowledged while its row insert is pending: the row is completed, not orphaned', async () => {
    const env = build();
    await startKnownOff(env);
    let hooked = false;
    env.repo.onInsert = (row) => {
      if (row.result === 'running' && !hooked) {
        hooked = true;
        return env.ctl.requestManual({ cmd: 'off' }).then(() => undefined);
      }
      return undefined;
    };
    await env.ctl.requestManual({ cmd: 'on', duration_s: 30 });
    await env.ctl.tick();
    await driveUntil(() => env.ctl.activeRun === null && env.ctl.pumpState === 'off', env.clock);
    await settle();
    expect(env.repo.events).toHaveLength(1);
    expect(env.repo.events[0]?.result).toBe('stopped');
    expect(env.repo.events[0]?.ts_end).not.toBeNull();
  });

  it('an ON still in flight when the run goes overdue: it is cancelled, OFF is sent, and ON is never re-sent', async () => {
    const env = build();
    await startKnownOff(env);
    env.actuator.behave = (call) => (call.kind === 'put' && call.cmd.type === 'pump_on' ? new Promise<never>(() => undefined) : env.actuator.applyAndAck(call));
    await env.ctl.requestManual({ cmd: 'on', duration_s: 5 });
    await env.ctl.tick();
    await driveUntil(() => env.actuator.count('pump_on') === 1, env.clock);
    await env.clock.advance(8000);
    await env.ctl.tick();
    await driveUntil(() => env.actuator.count('pump_off') >= 1 && env.ctl.activeRun === null, env.clock);
    await settle();
    expect(env.actuator.count('pump_on')).toBe(1);
    expect(env.actuator.actual).toBe('off');
    expect(env.pumpStates).not.toContain('on');
  });

  it('a second manual OFF while one is in flight is coalesced (duplicate:true, no second send)', async () => {
    const env = build();
    await startKnownOff(env);
    env.actuator.behave = (call) => (call.kind === 'put' && call.cmd.type === 'pump_off' ? new Promise<never>(() => undefined) : env.actuator.applyAndAck(call));
    const first = await env.ctl.requestManual({ cmd: 'off' });
    const second = await env.ctl.requestManual({ cmd: 'off' });
    expect(first.ok && first.duplicate).toBe(false);
    expect(second).toMatchObject({ ok: true, duplicate: true });
    await settle();
    expect(env.actuator.count('pump_off')).toBe(1);
  });

  it('a lookup failure for an idempotency id rejects instead of being treated as new', async () => {
    const env = build();
    await startKnownOff(env);
    env.repo.faults = 'throw';
    await expect(env.ctl.requestManual({ cmd: 'on', duration_s: 5, id: 'lookup-1' })).rejects.toThrow();
    expect(env.actuator.count('pump_on')).toBe(0);
  });

  it('a duplicate id arriving during the reservation returns duplicate:true, not manual_pending', async () => {
    const env = build();
    await startKnownOff(env);
    const [a, b] = await Promise.all([
      env.ctl.requestManual({ cmd: 'on', duration_s: 5, id: 'same-1' }),
      env.ctl.requestManual({ cmd: 'on', duration_s: 5, id: 'same-1' }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    expect(a.command.id).toBe(b.command.id);
  });

  it('boot aborts every open event (bounded loop), with a single safe OFF', async () => {
    const repo = new MemRepo();
    for (const i of [1, 2]) {
      await repo.insertEvent({
        ts_start: new Date(T0 - i * 60_000).toISOString(),
        ts_end: null,
        trigger: 'auto',
        reason: `open ${i}`,
        result: 'running',
      });
    }
    const env = build({ repo });
    open.push(env.ctl);
    await env.ctl.start();
    expect(env.repo.events.every((e) => e.result === 'aborted')).toBe(true);
    expect(env.actuator.count('pump_off')).toBe(1);
    expect(env.ctl.pumpState).toBe('off');
  });

  it('restart with an aborted run: min_interval counts from the restart instant (no immediate re-ON)', async () => {
    const env = build();
    await startKnownOff(env);
    await env.ctl.requestManual({ cmd: 'on', duration_s: 30 });
    await env.ctl.tick();
    await driveUntil(() => env.ctl.pumpState === 'on' && env.ctl.activeRun?.eventId != null, env.clock);
    env.ctl.stop();
    await env.clock.advance(1000);
    const bootAt = env.clock.now();
    let seen: RulesState | null = null;
    const ctl2 = new Controller({
      repo: env.repo,
      adapter: env.actuator,
      bus: createBus(),
      clock: env.clock,
      log: silent,
      decide: (s) => {
        seen = s;
        return fakeDecide(s);
      },
      assessReading: fakeAssess,
      dbTimeoutMs: 20,
    });
    open.push(ctl2);
    await ctl2.start();
    await ctl2.tick();
    expect(env.repo.events.find((e) => e.result === 'aborted')).toBeDefined();
    expect((seen as RulesState | null)?.lastRunEndedAt).toBe(bootAt);
  });

  it('a fresh accepted reading clears a stale sensor alarm immediately', async () => {
    const env = build({ decide: (s) => ({ ...fakeDecide(s), alarms: s.latest ? [] : ['sensor_stale'] }) });
    open.push(env.ctl);
    await env.ctl.start();
    await env.ctl.tick(); // no reading: sensor_stale raised by the rules
    expect(env.repo.alarms.has('sensor_stale')).toBe(true);
    await liveReading(env);
    expect(env.repo.alarms.has('sensor_stale')).toBe(false);
  });

  it('a start cannot be sent after its own run window: expires_at is clamped to start + max_s', async () => {
    const env = build();
    await startKnownOff(env);
    const res = await env.ctl.requestManual({ cmd: 'on', duration_s: 5, id: 'window-1' });
    expect(res.ok).toBe(true);
    await env.ctl.tick();
    await driveUntil(() => env.ctl.pumpState === 'on' && env.ctl.activeRun?.eventId != null, env.clock);
    const stored = env.repo.commands.get('window-1');
    expect(stored).toBeDefined();
    expect(Date.parse(stored!.expires_at)).toBeLessThanOrEqual(env.ctl.activeRun!.startSentAt + 5_000);
  });

  it('every OFF reply lost: the run is charged to the daily budget at the force-stop, its row is closed, and OFF retries back off', async () => {
    const env = build();
    await startKnownOff(env);
    env.actuator.behave = (call) =>
      call.kind === 'put' && call.cmd.type === 'pump_off' ? noReply() : env.actuator.applyAndAck(call);
    await env.ctl.requestManual({ cmd: 'on', duration_s: 20 });
    await env.ctl.tick();
    await driveUntil(() => env.ctl.pumpState === 'on' && env.ctl.activeRun?.eventId != null, env.clock);

    for (let t = 0; t < 200; t++) {
      await env.clock.advance(1000);
      await env.ctl.tick();
    }
    await settle();

    // Charged at the force-stop, not at an OFF ack that never came.
    expect(env.ctl.dailyRuntimeSeconds).toBeGreaterThanOrEqual(19);
    expect(env.ctl.dailyRuntimeSeconds).toBeLessThanOrEqual(23);
    // The row is closed while the pump is still unknown (row close is not a confirmed OFF).
    expect(env.repo.events.filter((e) => e.ts_end === null)).toHaveLength(0);
    expect(env.repo.events.find((e) => e.result === 'stopped')).toBeDefined();
    expect(env.ctl.pumpState).toBe('unknown');
    // Backoff 5, 10, 20, 40, 60 ... : a handful of commands over 200 s, not one every few seconds.
    expect(env.actuator.count('pump_off')).toBeLessThan(30);

    // OFF finally acked: no double count.
    env.actuator.behave = (call) => env.actuator.applyAndAck(call);
    await env.clock.advance(60_000);
    await env.ctl.tick();
    await driveUntil(() => env.ctl.pumpState === 'off' && env.ctl.activeRun === null, env.clock);
    expect(env.ctl.dailyRuntimeSeconds).toBeLessThanOrEqual(23);
  });
});

import { describe, expect, it } from 'vitest';
import { createBus } from '../bus.js';
import { createLogger } from '../log.js';
import type { Alarm } from '../types.js';
import { FakeClock, MemRepo, T0 } from '../actuator/test-support.js';
import { AlarmBoard } from './alarms.js';

const silent = createLogger('test', 'silent');

describe('AlarmBoard', () => {
  it('keeps the last known persisted set (incl. db_down) when activeAlarms() fails', async () => {
    const repo = new MemRepo();
    await repo.saveAlarm({ code: 'db_down', since: new Date(T0).toISOString(), message: 'db', severity: 'critical' });
    const bus = createBus();
    let last: Alarm[] = [];
    bus.on('alarms', (a) => {
      last = a;
    });
    const board = new AlarmBoard({ repo, bus, clock: new FakeClock(T0), log: silent, dbTimeoutMs: 20 });
    await board.hydrate();

    await board.raise('pump_failed', 'first', 'critical');
    expect(last.map((a) => a.code).sort()).toEqual(['db_down', 'pump_failed']);

    repo.faults = 'throw';
    await board.raise('actuator_unreachable', 'second', 'critical');
    expect(last.map((a) => a.code).sort()).toEqual(['actuator_unreachable', 'db_down', 'pump_failed']);
  });

  it('a hung repo does not block raising an alarm', async () => {
    const repo = new MemRepo();
    const bus = createBus();
    const board = new AlarmBoard({ repo, bus, clock: new FakeClock(T0), log: silent, dbTimeoutMs: 20 });
    repo.faults = 'hang';
    const t0 = Date.now();
    await board.raise('soil_jump_ignored', 'x', 'warn');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

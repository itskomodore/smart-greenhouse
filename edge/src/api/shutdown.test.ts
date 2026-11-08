import { describe, expect, it } from 'vitest';
import { createBus } from '../bus.js';
import { createLogger } from '../log.js';
import { createShutdown, pumpOffBestEffort, type ShutdownSteps } from './shutdown.js';
import { makeCommand } from './test-support.js';
import type { ManualResult } from './deps.js';

const silent = createLogger('shutdown-test', 'silent');

function recordingSteps(over: Partial<ShutdownSteps> = {}): { steps: ShutdownSteps; calls: string[] } {
  const calls: string[] = [];
  const steps: ShutdownSteps = {
    stopBackground: () => void calls.push('stopBackground'),
    closeHttp: async () => void calls.push('closeHttp'),
    stopControl: () => void calls.push('stopControl'),
    pumpOff: async () => void calls.push('pumpOff'),
    closeIngest: async () => void calls.push('closeIngest'),
    closePool: async () => void calls.push('closePool'),
    ...over,
  };
  return { steps, calls };
}

describe('createShutdown', () => {
  it('runs the steps in order, then exits 0', async () => {
    const { steps, calls } = recordingSteps();
    const exits: number[] = [];
    const shutdown = createShutdown({ steps, log: silent, exit: (c) => exits.push(c), stepMs: 500, hardLimitMs: 5000 });
    await shutdown('SIGTERM');
    expect(calls).toEqual(['stopBackground', 'closeHttp', 'stopControl', 'pumpOff', 'closeIngest', 'closePool']);
    expect(exits).toEqual([0]);
  });

  it('a failing step does not stop the rest, and the process still exits 0', async () => {
    const { steps, calls } = recordingSteps({
      closeIngest: async () => {
        throw new Error('bind lost');
      },
    });
    const exits: number[] = [];
    const shutdown = createShutdown({ steps, log: silent, exit: (c) => exits.push(c), stepMs: 500, hardLimitMs: 5000 });
    await shutdown('SIGINT');
    expect(calls).toContain('closePool');
    expect(exits).toEqual([0]);
  });

  it('a hung async step is bounded by stepMs', async () => {
    const { steps, calls } = recordingSteps({ closeHttp: () => new Promise<void>(() => undefined) });
    const exits: number[] = [];
    const started = Date.now();
    const shutdown = createShutdown({ steps, log: silent, exit: (c) => exits.push(c), stepMs: 50, hardLimitMs: 5000 });
    await shutdown('SIGTERM');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(calls).toContain('closePool');
    expect(exits).toEqual([0]);
  });

  it('a second signal exits 1 immediately and does not re-run the steps', async () => {
    let release!: () => void;
    let httpCalls = 0;
    const { steps } = recordingSteps({
      closeHttp: () => {
        httpCalls++;
        return new Promise<void>((r) => (release = r));
      },
    });
    const exits: number[] = [];
    const shutdown = createShutdown({ steps, log: silent, exit: (c) => exits.push(c), stepMs: 5000, hardLimitMs: 10000 });
    const first = shutdown('SIGTERM');
    await shutdown('SIGTERM');
    expect(exits).toEqual([1]);
    release();
    await first;
    expect(httpCalls).toBe(1);
    expect(exits).toEqual([1, 0]);
  });
});

describe('pumpOffBestEffort', () => {
  it('confirms when the terminal pump event for the OFF arrives', async () => {
    const bus = createBus();
    const cmd = makeCommand({ type: 'pump_off', state: 'pending', max_s: null });
    const controller = {
      requestManual: async (): Promise<ManualResult> => {
        setTimeout(() => bus.emit('pump', { state: 'off', command: { ...cmd, state: 'acked' } }), 5);
        return { ok: true, command: cmd, duplicate: false };
      },
    };
    await pumpOffBestEffort(controller, bus, createLogger('t', 'silent'), { sendMs: 200, confirmMs: 500 });
    expect(bus.listenerCount('pump')).toBe(0);
  });

  it('never throws when the controller hangs (bounded by sendMs)', async () => {
    const bus = createBus();
    const controller = { requestManual: () => new Promise<ManualResult>(() => undefined) };
    const started = Date.now();
    await pumpOffBestEffort(controller, bus, createLogger('t', 'silent'), { sendMs: 30, confirmMs: 30 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(bus.listenerCount('pump')).toBe(0);
  });

  it('gives up after confirmMs when no terminal event arrives, and unsubscribes', async () => {
    const bus = createBus();
    const cmd = makeCommand({ type: 'pump_off', max_s: null });
    const controller = { requestManual: async (): Promise<ManualResult> => ({ ok: true, command: cmd, duplicate: false }) };
    await pumpOffBestEffort(controller, bus, createLogger('t', 'silent'), { sendMs: 200, confirmMs: 30 });
    expect(bus.listenerCount('pump')).toBe(0);
  });
});

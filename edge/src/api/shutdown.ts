/**
 * Graceful shutdown as a testable unit. main.ts supplies the steps; this module fixes their order,
 * bounds each step, and makes a second signal exit immediately.
 */
import type { TypedBus } from '../bus.js';
import type { Logger } from '../log.js';
import type { BusEvents } from '../types.js';
import { errorMessage, tryWithin } from './deadline.js';
import type { ManualResult } from './deps.js';

export const TERMINAL_COMMAND_STATES: ReadonlySet<string> = new Set(['acked', 'failed', 'expired']);

/** Resolves true when a `pump` bus event reports `commandId` terminal, false on timeout. */
export function awaitCommandSettled(
  bus: Pick<TypedBus, 'on' | 'off'>,
  commandId: string,
  ms: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const finish = (ok: boolean): void => {
      clearTimeout(timer);
      bus.off('pump', onPump);
      resolve(ok);
    };
    const onPump = (p: BusEvents['pump']): void => {
      if (p.command?.id === commandId && TERMINAL_COMMAND_STATES.has(p.command.state)) finish(true);
    };
    const timer = setTimeout(() => finish(false), ms);
    bus.on('pump', onPump);
  });
}

export interface PumpOffTiming {
  sendMs: number;
  confirmMs: number;
}

/** Asks for OFF and waits briefly for its terminal event. Never throws; the actuator's max_s timer is the backstop. */
export async function pumpOffBestEffort(
  controller: { requestManual(req: { cmd: 'off' }): Promise<ManualResult> },
  bus: Pick<TypedBus, 'on' | 'off'>,
  log: Logger,
  timing: PumpOffTiming,
): Promise<void> {
  const sent = await tryWithin(controller.requestManual({ cmd: 'off' }), timing.sendMs);
  if (!sent.ok) {
    log.error({ err: errorMessage(sent.error) }, 'pump OFF could not be queued at shutdown');
    return;
  }
  if (!sent.value.ok) {
    log.error({ reason: sent.value.message }, 'pump OFF refused at shutdown');
    return;
  }
  const id = sent.value.command.id;
  if (await awaitCommandSettled(bus, id, timing.confirmMs)) {
    log.info({ command_id: id }, 'pump OFF settled at shutdown');
  } else {
    log.warn({ command_id: id }, 'pump OFF not confirmed before shutdown deadline');
  }
}

export interface ShutdownSteps {
  /** Synchronous: clear timers and background jobs. */
  stopBackground(): void;
  /** Stop accepting HTTP; end streams. */
  closeHttp(): Promise<void>;
  /** Synchronous: stop the control loop so no new start is decided. */
  stopControl(): void;
  /** Best-effort pump OFF (bounded internally). */
  pumpOff(): Promise<void>;
  /** Stop sensor ingest. */
  closeIngest(): Promise<void>;
  /** Release the database pool. */
  closePool(): Promise<void>;
}

export interface ShutdownDeps {
  steps: ShutdownSteps;
  log: Logger;
  exit: (code: number) => void;
  /** Per-async-step bound. */
  stepMs: number;
  /** Whole-shutdown bound; the process exits with 1 if exceeded. */
  hardLimitMs: number;
}

/** Returns the signal handler. The first call runs the steps in order and exits 0; a repeat exits 1. */
export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const { steps, log } = deps;
  let started = false;

  const bounded = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      const r = await tryWithin(fn(), deps.stepMs);
      if (!r.ok) log.error({ step: name, err: errorMessage(r.error) }, 'shutdown step failed');
    } catch (err) {
      log.error({ step: name, err: errorMessage(err) }, 'shutdown step threw');
    }
  };

  return async (signal: string): Promise<void> => {
    if (started) {
      log.warn({ signal }, 'second shutdown signal; exiting now');
      deps.exit(1);
      return;
    }
    started = true;
    log.info({ signal }, 'shutting down');
    const hard = setTimeout(() => {
      log.error('shutdown exceeded its hard limit; exiting');
      deps.exit(1);
    }, deps.hardLimitMs);
    hard.unref();

    try {
      steps.stopBackground();
    } catch (err) {
      log.error({ step: 'stopBackground', err: errorMessage(err) }, 'shutdown step threw');
    }
    await bounded('closeHttp', () => steps.closeHttp());
    try {
      steps.stopControl();
    } catch (err) {
      log.error({ step: 'stopControl', err: errorMessage(err) }, 'shutdown step threw');
    }
    await bounded('pumpOff', () => steps.pumpOff());
    await bounded('closeIngest', () => steps.closeIngest());
    await bounded('closePool', () => steps.closePool());

    clearTimeout(hard);
    log.info('shutdown complete');
    deps.exit(0);
  };
}

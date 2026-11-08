/**
 * Waits (HTTP side only) for a command to reach a terminal state. Holds no controller lock and
 * cancels nothing: it only observes. Completion, timeout and abort all release the bus listener,
 * the poll interval and the timeout.
 */
import type { TypedBus } from '../bus.js';
import type { BusEvents, Command, Repo } from '../types.js';
import { tryWithin } from './deadline.js';

export const TERMINAL_STATES: ReadonlySet<Command['state']> = new Set(['acked', 'failed', 'expired']);

export function isTerminal(c: Command): boolean {
  return TERMINAL_STATES.has(c.state);
}

export interface AwaitDeps {
  bus: Pick<TypedBus, 'on' | 'off'>;
  repo: Pick<Repo, 'getCommand'>;
  /** How often the DB is checked in case no bus event fires. Default 250 ms. */
  pollMs?: number;
  /** Bound on one DB lookup. Default 300 ms. */
  readMs?: number;
}

/**
 * Resolves with the newest known snapshot of `initial.id`: terminal as soon as the bus or the DB
 * shows it, otherwise the last snapshot when `waitMs` elapses or `signal` aborts.
 */
export function awaitCommandFinal(deps: AwaitDeps, initial: Command, waitMs: number, signal?: AbortSignal): Promise<Command> {
  const pollMs = deps.pollMs ?? 250;
  const readMs = deps.readMs ?? 300;
  return new Promise<Command>((resolve) => {
    let latest: Command = { ...initial };
    let finished = false;
    let polling = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      clearInterval(poll);
      deps.bus.off('pump', onPump);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (): void => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(latest);
    };
    const offer = (c: Command): void => {
      if (c.id !== initial.id) return;
      latest = { ...c };
      if (isTerminal(c)) finish();
    };
    const onPump = (p: BusEvents['pump']): void => {
      if (p.command) offer(p.command);
    };
    const onAbort = (): void => finish();

    const timer = setTimeout(finish, waitMs);
    const poll = setInterval(() => {
      if (finished || polling) return;
      polling = true;
      void tryWithin(deps.repo.getCommand(initial.id), readMs).then((r) => {
        polling = false;
        if (r.ok && r.value) offer(r.value);
      });
    }, pollMs);

    deps.bus.on('pump', onPump);
    if (signal?.aborted) finish();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

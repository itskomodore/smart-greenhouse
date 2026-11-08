/**
 * Time-bounding helpers for the HTTP path. A hung DB or controller must never stall a response
 * past its contract deadline (POST /api/pump answers within 2 s).
 */

export type Attempt<T> = { ok: true; value: T } | { ok: false; error: unknown };

export class DeadlineError extends Error {
  constructor(public readonly ms: number) {
    super(`timed out after ${ms} ms`);
    this.name = 'DeadlineError';
  }
}

/**
 * Settles with the promise outcome, or with a DeadlineError when `ms` elapses first.
 * Never rejects; the losing promise's outcome is swallowed (no unhandled rejection).
 */
export function tryWithin<T>(p: Promise<T>, ms: number): Promise<Attempt<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Attempt<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: new DeadlineError(ms) }), ms);
  });
  const work = p.then(
    (value): Attempt<T> => ({ ok: true, value }),
    (error: unknown): Attempt<T> => ({ ok: false, error }),
  );
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function isDeadlineError(err: unknown): err is DeadlineError {
  return err instanceof DeadlineError;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class DbTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not complete within ${ms} ms`);
    this.name = 'DbTimeoutError';
  }
}

/**
 * Bound a repo call so a hung database can never block the safety path.
 * Rejects with DbTimeoutError after `ms` (real time; repo I/O is not on the injected clock).
 */
export function bounded<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DbTimeoutError(what, ms)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

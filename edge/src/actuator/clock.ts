/** Injected time source. Production uses systemClock; tests use a fake that controls `sleep`. */
export interface Clock {
  /** Epoch ms. */
  now(): number;
  /** Resolve after `ms` of this clock's time. */
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** ISO-8601 UTC string for an epoch-ms instant (DB/API edge format). */
export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

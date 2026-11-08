/**
 * Token bucket: `capacity` tokens, one token regained every `refillMs` (capped at capacity).
 * Time comes from an injected clock so tests stay deterministic.
 */
export type TakeResult = { ok: true } | { ok: false; retryAfterS: number };

export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillMs: number,
    private readonly now: () => number,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  take(): TakeResult {
    const t = this.now();
    const elapsed = t - this.last;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed / this.refillMs);
      this.last = t;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterS: Math.max(1, Math.ceil(((1 - this.tokens) * this.refillMs) / 1000)) };
  }
}

/** Bounded map: inserting beyond `max` evicts the least recently set key. */
export class LruMap<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly max: number) {}

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get(key: string): V | undefined {
    return this.map.get(key);
  }

  entries(): IterableIterator<[string, V]> {
    return this.map.entries();
  }

  get size(): number {
    return this.map.size;
  }
}

import { describe, expect, it } from 'vitest';
import { downsample } from './downsample.js';
import { T0, makeReading } from './test-support.js';

function series(count: number, stepMs: number, node = 'node-a', value = (i: number) => i): ReturnType<typeof makeReading>[] {
  return Array.from({ length: count }, (_, i) =>
    makeReading({
      node_id: node,
      ts: new Date(T0 - (count - i) * stepMs).toISOString(),
      soil_pct: value(i),
      t: value(i),
    }),
  );
}

describe('downsample', () => {
  it('returns rows unchanged (sorted) when they already fit', () => {
    const rows = series(10, 60_000);
    const out = downsample([...rows].reverse(), 100);
    expect(out).toHaveLength(10);
    expect(out.map((r) => r.ts)).toEqual(rows.map((r) => r.ts));
  });

  it('caps a long single-node series at the limit and keeps ascending order', () => {
    const out = downsample(series(5000, 60_000), 1000);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out.length).toBeGreaterThan(900);
    for (let i = 1; i < out.length; i++) {
      expect(Date.parse(out[i]!.ts)).toBeGreaterThan(Date.parse(out[i - 1]!.ts));
    }
  });

  it('averages within buckets (constant input stays constant)', () => {
    const out = downsample(series(300, 60_000, 'node-a', () => 37), 30);
    expect(out.length).toBeLessThanOrEqual(30);
    for (const r of out) expect(r.soil_pct).toBe(37);
  });

  it('keeps nodes separate: each node is bucketed on its own values', () => {
    const a = series(400, 60_000, 'node-a', () => 10);
    const b = series(400, 60_000, 'node-b', () => 90);
    const out = downsample([...a, ...b], 100);
    expect(out.length).toBeLessThanOrEqual(100);
    for (const r of out) expect(r.soil_pct).toBe(r.node_id === 'node-a' ? 10 : 90);
    expect(new Set(out.map((r) => r.node_id))).toEqual(new Set(['node-a', 'node-b']));
  });

  it('bucket output carries no id and a mean timestamp inside the bucket span', () => {
    const rows = series(100, 60_000);
    const out = downsample(rows, 10);
    const first = Date.parse(rows[0]!.ts);
    const last = Date.parse(rows[rows.length - 1]!.ts);
    for (const r of out) {
      expect(r).not.toHaveProperty('id');
      const t = Date.parse(r.ts);
      expect(t).toBeGreaterThanOrEqual(first);
      expect(t).toBeLessThanOrEqual(last);
    }
  });

  it('handles an empty input', () => {
    expect(downsample([], 1000)).toEqual([]);
  });
});

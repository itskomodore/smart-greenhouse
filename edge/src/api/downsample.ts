import type { Reading } from '../types.js';

/**
 * Time-bucket average so a long window fits in `limit` points. Rows are grouped per node first so
 * two sensors never average into each other; each node gets an equal share of the budget.
 * Input may be in any order; output is ascending by ts. Returns the input unchanged when it
 * already fits. Bucket output has no `id` (it is an aggregate, not a stored row).
 */
export function downsample(rows: readonly Reading[], limit: number): Reading[] {
  const budgetTotal = Math.max(1, Math.floor(limit));
  if (rows.length <= budgetTotal) return [...rows].sort(byTs);

  const groups = new Map<string, Reading[]>();
  for (const r of rows) {
    const g = groups.get(r.node_id);
    if (g) g.push(r);
    else groups.set(r.node_id, [r]);
  }
  const perNode = Math.max(1, Math.floor(budgetTotal / groups.size));

  const out: Reading[] = [];
  for (const g of groups.values()) {
    g.sort(byTs);
    if (g.length <= perNode) out.push(...g);
    else out.push(...bucketAverage(g, perNode));
  }
  return out.sort(byTs);
}

function byTs(a: Reading, b: Reading): number {
  return Date.parse(a.ts) - Date.parse(b.ts);
}

interface Acc {
  n: number;
  ts: number;
  t: number;
  rh: number;
  light_raw: number;
  soil_raw: number;
  soil_pct: number;
  light_pct: number;
}

/** `g` is sorted ascending and belongs to a single node. */
function bucketAverage(g: readonly Reading[], buckets: number): Reading[] {
  const first = Date.parse(g[0]!.ts);
  const last = Date.parse(g[g.length - 1]!.ts);
  const span = last - first;
  const acc: (Acc | undefined)[] = new Array<Acc | undefined>(buckets);

  for (const r of g) {
    const t = Date.parse(r.ts);
    const idx = span === 0 ? 0 : Math.min(buckets - 1, Math.floor(((t - first) / span) * buckets));
    let a = acc[idx];
    if (!a) {
      a = { n: 0, ts: 0, t: 0, rh: 0, light_raw: 0, soil_raw: 0, soil_pct: 0, light_pct: 0 };
      acc[idx] = a;
    }
    a.n += 1;
    a.ts += t;
    a.t += r.t;
    a.rh += r.rh;
    a.light_raw += r.light_raw;
    a.soil_raw += r.soil_raw;
    a.soil_pct += r.soil_pct;
    a.light_pct += r.light_pct;
  }

  const node_id = g[0]!.node_id;
  const out: Reading[] = [];
  for (const a of acc) {
    if (!a) continue;
    out.push({
      node_id,
      ts: new Date(a.ts / a.n).toISOString(),
      t: round(a.t / a.n, 2),
      rh: round(a.rh / a.n, 2),
      light_raw: Math.round(a.light_raw / a.n),
      soil_raw: Math.round(a.soil_raw / a.n),
      soil_pct: round(a.soil_pct / a.n, 2),
      light_pct: round(a.light_pct / a.n, 2),
    });
  }
  return out;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

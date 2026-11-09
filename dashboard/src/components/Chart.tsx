import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import type { Reading } from '../types.js';
import { api } from '../lib/api.js';
import { useDark } from '../lib/useDark.js';
import { useLive } from '../lib/live.js';
import { fmtPct } from '../lib/format.js';

type MetricKey = 'soil_pct' | 't' | 'rh' | 'light_pct';
type RangeKey = '1h' | '24h' | '7d';

const METRICS: { key: MetricKey; label: string; unit: string; fixed: boolean }[] = [
  { key: 'soil_pct', label: 'Soil', unit: '%', fixed: true },
  { key: 't', label: 'Temp', unit: '°C', fixed: false },
  { key: 'rh', label: 'Humidity', unit: '%RH', fixed: true },
  { key: 'light_pct', label: 'Light', unit: '%', fixed: true },
];

const RANGES: { key: RangeKey; label: string; ms: number }[] = [
  { key: '1h', label: '1 h', ms: 3600_000 },
  { key: '24h', label: '24 h', ms: 86_400_000 },
  { key: '7d', label: '7 d', ms: 7 * 86_400_000 },
];

const HEIGHT = 240;

interface Thresholds {
  low: number;
  high: number;
}

/** Full host width, floored so a transiently hidden host never yields a degenerate plot. */
function plotWidth(el: HTMLElement): number {
  return Math.max(200, el.clientWidth);
}

/** Shade the soil chart: dry zone below low, wet zone at/above high. */
function drawBands(u: uPlot, thr: Thresholds, dark: boolean) {
  const { ctx, bbox } = u;
  const yLow = u.valToPos(thr.low, 'y', true);
  const yHigh = u.valToPos(thr.high, 'y', true);
  const top = bbox.top;
  const bottom = bbox.top + bbox.height;
  const left = bbox.left;
  const width = bbox.width;
  ctx.save();
  ctx.fillStyle = dark ? 'rgba(220,90,70,0.16)' : 'rgba(200,70,50,0.10)';
  ctx.fillRect(left, yLow, width, bottom - yLow);
  ctx.fillStyle = dark ? 'rgba(70,160,220,0.14)' : 'rgba(40,110,190,0.09)';
  ctx.fillRect(left, top, width, yHigh - top);
  ctx.fillStyle = dark ? 'rgba(120,200,140,0.10)' : 'rgba(40,140,80,0.08)';
  ctx.fillRect(left, yHigh, width, yLow - yHigh);
  ctx.restore();
}

export function Chart() {
  const { latest, settings, serverNow } = useLive();
  const dark = useDark();
  const [metric, setMetric] = useState<MetricKey>('soil_pct');
  const [range, setRange] = useState<RangeKey>('24h');
  const [readings, setReadings] = useState<Reading[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);

  const nodeId = latest?.node_id;
  const latestTs = latest?.ts;

  useEffect(() => {
    let alive = true;
    const to = new Date(serverNow());
    const span = RANGES.find((r) => r.key === range)?.ms ?? 86_400_000;
    const from = new Date(to.getTime() - span);
    api
      .readings({ from: from.toISOString(), to: to.toISOString(), limit: 1000, node_id: nodeId })
      .then((r) => {
        if (!alive) return;
        setReadings(r.readings);
        setErr(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setErr(e instanceof Error ? e.message : 'Failed to load readings');
      });
    return () => {
      alive = false;
    };
    // Refetch when the range/node changes or a new reading lands.
  }, [range, nodeId, latestTs, serverNow]);

  const xs = useMemo(() => (readings ?? []).map((r) => Date.parse(r.ts) / 1000), [readings]);
  const ys = useMemo(() => (readings ?? []).map((r) => r[metric]), [readings, metric]);

  const thr: Thresholds | null = settings ? { low: settings.low_threshold, high: settings.high_threshold } : null;
  const metricDef = METRICS.find((m) => m.key === metric) ?? METRICS[0]!;
  const hasData = xs.length > 0;

  useEffect(() => {
    const el = hostRef.current;
    if (!el || !hasData) return;
    const axisColor = dark ? '#9fb3a6' : '#3d4f44';
    const gridColor = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
    const lineColor = dark ? '#7fd9a8' : '#1f7a4d';
    const opts: uPlot.Options = {
      width: plotWidth(el),
      height: HEIGHT,
      cursor: { drag: { x: false, y: false } },
      legend: { show: false },
      scales: {
        x: { time: true },
        y: metricDef.fixed ? { range: [0, 100] } : {},
      },
      axes: [
        { stroke: axisColor, grid: { stroke: gridColor, width: 1 }, ticks: { stroke: gridColor, width: 1 } },
        { stroke: axisColor, grid: { stroke: gridColor, width: 1 }, ticks: { stroke: gridColor, width: 1 }, size: 56 },
      ],
      series: [
        {},
        { label: metricDef.label, stroke: lineColor, width: 2, points: { show: false } },
      ],
      hooks: {
        draw: metric === 'soil_pct' && thr ? [(u: uPlot) => drawBands(u, thr, dark)] : [],
      },
    };
    const plot = new uPlot(opts, [xs, ys] as uPlot.AlignedData, el);
    plotRef.current = plot;
    // Re-measure once the host is laid out: uPlot sizes itself from a width
    // read taken before the new canvas is attached, so correct it here.
    plot.setSize({ width: plotWidth(el), height: HEIGHT });
    return () => {
      plot.destroy();
      if (plotRef.current === plot) plotRef.current = null;
    };
    // Rebuild on threshold change is intentional (bands are drawn from thr).
  }, [xs, ys, metric, dark, hasData, thr?.low, thr?.high, metricDef.label, metricDef.unit, metricDef.fixed]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const plot = plotRef.current;
      if (!plot) return;
      const width = plotWidth(el);
      if (width !== plot.width) plot.setSize({ width, height: HEIGHT });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <section className="card chart-card" aria-labelledby="chart-title">
      <div className="chart-head">
        <h2 id="chart-title">History</h2>
        <div className="seg" role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              className="seg-btn"
              aria-pressed={range === r.key}
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="seg seg-wrap" role="group" aria-label="Metric">
        {METRICS.map((m) => (
          <button
            key={m.key}
            type="button"
            className="seg-btn"
            aria-pressed={metric === m.key}
            onClick={() => setMetric(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>
      {err && <p className="error" role="alert">Could not load history: {err}</p>}
      {!hasData && !err && <p className="hint">{readings === null ? 'Loading…' : 'No readings in this range yet.'}</p>}
      <div ref={hostRef} className="plot" style={{ minHeight: hasData ? HEIGHT : 0 }} aria-label={`${metricDef.label} history chart`} role="img" />
      {metric === 'soil_pct' && thr && (
        <p className="hint">Shaded: dry below {fmtPct(thr.low)}, wet at or above {fmtPct(thr.high)}.</p>
      )}
    </section>
  );
}

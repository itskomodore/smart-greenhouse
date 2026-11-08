import type { ReactNode } from 'react';
import type { Reading } from '../types.js';
import { clamp, fmtAgo, fmtNum, soilZone } from '../lib/format.js';
import { useLive, useTick } from '../lib/live.js';

export function ageSeconds(reading: Reading, serverNowMs: number): number {
  const t = Date.parse(reading.ts);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (serverNowMs - t) / 1000);
}

interface CardProps {
  title: string;
  value: string;
  unit: string;
  ageS: number | null;
  stale: boolean;
  children?: ReactNode;
}

function Card({ title, value, unit, ageS, stale, children }: CardProps) {
  return (
    <article className={`card metric ${stale ? 'metric-stale' : ''}`} aria-labelledby={`m-${title}`}>
      <h2 id={`m-${title}`}>{title}</h2>
      <p className="value">
        <span>{value}</span>
        <span className="unit">{unit}</span>
      </p>
      {children}
      <p className="meta">
        {ageS === null ? 'No data yet' : `Updated ${fmtAgo(ageS)}`}
        {stale && <strong className="stale"> · stale</strong>}
      </p>
    </article>
  );
}

export function Cards() {
  const { latest, settings, status, serverNow } = useLive();
  useTick(1000);

  const reading = latest;
  const ageS = reading ? ageSeconds(reading, serverNow()) : null;
  const nodeStatus = reading ? status?.nodes[reading.node_id] : undefined;
  const staleLimit = settings?.stale_timeout_s ?? 900;
  const stale = reading ? (nodeStatus?.stale ?? false) || (ageS ?? Infinity) >= staleLimit : false;

  const soil = reading?.soil_pct ?? null;
  const zone = soil !== null && settings ? soilZone(soil, settings) : null;
  const lo = settings?.low_threshold ?? 30;
  const hi = settings?.high_threshold ?? 60;

  return (
    <section className="cards" aria-label="Current readings">
      <Card title="Temperature" value={reading ? fmtNum(reading.t) : '—'} unit="°C" ageS={ageS} stale={stale} />
      <Card title="Humidity" value={reading ? fmtNum(reading.rh, 0) : '—'} unit="%RH" ageS={ageS} stale={stale} />
      <Card title="Soil moisture" value={soil !== null ? fmtNum(soil, 0) : '—'} unit="%" ageS={ageS} stale={stale}>
        <div
          className="soil-bar"
          role="img"
          aria-label={`Soil ${soil !== null ? Math.round(soil) : 'unknown'} percent. Dry below ${lo}, wet at or above ${hi}.`}
        >
          <span className="band band-dry" style={{ left: 0, width: `${clamp(lo, 0, 100)}%` }} />
          <span className="band band-ok" style={{ left: `${clamp(lo, 0, 100)}%`, width: `${clamp(hi - lo, 0, 100)}%` }} />
          <span className="band band-wet" style={{ left: `${clamp(hi, 0, 100)}%`, width: `${clamp(100 - hi, 0, 100)}%` }} />
          {soil !== null && <span className="marker" style={{ left: `${clamp(soil, 0, 100)}%` }} />}
        </div>
        <p className="hint">
          {zone === 'dry' && 'Below low threshold: irrigation may start'}
          {zone === 'ok' && 'Within band'}
          {zone === 'wet' && 'At or above high threshold'}
          {zone === null && `Thresholds ${lo}–${hi}%`}
        </p>
      </Card>
      <Card title="Light" value={reading ? fmtNum(reading.light_pct, 0) : '—'} unit="%" ageS={ageS} stale={stale} />
    </section>
  );
}

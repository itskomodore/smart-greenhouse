import { useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import { fmtAgo, fmtNum } from '../lib/format.js';
import { useLive, useTick } from '../lib/live.js';
import { ageSeconds } from './Cards.js';
import { log } from '../lib/log.js';

interface Props {
  token: string;
}

/** Server rejects captures older than this (docs/API.md). */
const MAX_CAPTURE_AGE_S = 60;

const REFUSAL_TEXT: Record<string, string> = {
  stale_reading: 'The latest reading is too old. Wait for a fresh sample.',
  dry_equals_wet: 'Dry and wet values would be identical. Recalibrate with a clear difference.',
};

export function Calibration({ token }: Props) {
  const { latest, settings, serverNow, refreshSettings } = useLive();
  useTick(1000);
  const [busy, setBusy] = useState<'dry' | 'wet' | null>(null);
  const [result, setResult] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const ageS = latest ? ageSeconds(latest, serverNow()) : null;
  const fresh = ageS !== null && ageS < MAX_CAPTURE_AGE_S;
  const canWrite = token.length > 0;

  const capture = async (which: 'dry' | 'wet') => {
    setBusy(which);
    setResult(null);
    try {
      const r = await api.calibrate(token, which);
      await refreshSettings();
      setResult({
        kind: 'ok',
        text: `Captured raw ${r.captured_raw} as ${which === 'dry' ? 'DRY' : 'WET'}. Dry ${r.soil_dry_raw}, wet ${r.soil_wet_raw}.`,
      });
      log.info({ which, captured: r.captured_raw }, 'calibration captured');
    } catch (err) {
      let text = err instanceof Error ? err.message : 'Capture failed';
      if (err instanceof ApiError) {
        if (err.status === 409) text = `Refused (${err.code}): ${REFUSAL_TEXT[err.code] ?? err.message}`;
        else if (err.status === 401) text = 'Token rejected (401). Check the API token.';
      }
      setResult({ kind: 'error', text });
      log.warn({ which, err: String(err) }, 'calibration capture failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card calib" aria-labelledby="calib-title">
      <h2 id="calib-title">Soil calibration</h2>
      <p className="muted">
        Hold the sensor in dry air, capture DRY. Then submerge the probe in water (not the electronics), capture WET.
        Captures use the latest raw reading and must be less than {MAX_CAPTURE_AGE_S} s old.
      </p>

      <div className="calib-live">
        <div>
          <p className="label">Current raw soil</p>
          <p className="value big">{latest ? latest.soil_raw : '—'}</p>
          <p className={`meta ${fresh ? '' : 'stale'}`}>
            {ageS === null ? 'No reading yet' : `Updated ${fmtAgo(ageS)}`}
            {ageS !== null && !fresh && ' · too old to capture'}
          </p>
        </div>
        <div>
          <p className="label">Stored</p>
          <p className="value">
            DRY {settings?.soil_dry_raw ?? '—'} · WET {settings?.soil_wet_raw ?? '—'}
          </p>
          <p className="meta">Soil % = (dry − raw) / (dry − wet) × 100, clamped 0–100.</p>
        </div>
      </div>

      <div className="row calib-actions">
        <button type="button" className="btn" disabled={!canWrite || !fresh || busy !== null} onClick={() => void capture('dry')}>
          {busy === 'dry' ? 'Capturing…' : 'Capture DRY'}
        </button>
        <button type="button" className="btn" disabled={!canWrite || !fresh || busy !== null} onClick={() => void capture('wet')}>
          {busy === 'wet' ? 'Capturing…' : 'Capture WET'}
        </button>
      </div>
      {!canWrite && <p className="hint">Enter the API token on the Dashboard tab to capture.</p>}
      {result && (
        <p className={result.kind === 'ok' ? 'ok' : 'error'} role={result.kind === 'ok' ? 'status' : 'alert'}>
          {result.text}
        </p>
      )}
      {latest && <p className="hint">Latest soil % {fmtNum(latest.soil_pct, 0)}.</p>}
    </section>
  );
}

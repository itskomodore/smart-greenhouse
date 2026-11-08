import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Settings } from '../types.js';
import { api, ApiError } from '../lib/api.js';
import { settingsToDraft, validateSettings } from '../lib/format.js';
import type { SettingsDraft, SettingsErrors } from '../lib/format.js';
import { useLive } from '../lib/live.js';
import { log } from '../lib/log.js';

interface Props {
  token: string;
}

interface FieldDef {
  key: keyof Settings;
  label: string;
  help: string;
  unit?: string;
  kind: 'int' | 'num' | 'bool';
  min?: number;
  max?: number;
  group: string;
}

// Ranges mirror docs/API.md PUT /api/settings. Keep in sync with the server.
const FIELDS: FieldDef[] = [
  { key: 'low_threshold', label: 'Low threshold', unit: '%', kind: 'num', min: 0, max: 100, group: 'Irrigation', help: 'Start watering below this soil moisture.' },
  { key: 'high_threshold', label: 'High threshold', unit: '%', kind: 'num', min: 0, max: 100, group: 'Irrigation', help: 'Stop at or above this soil moisture. Must be above low.' },
  { key: 'max_run_s', label: 'Max run per cycle', unit: 's', kind: 'int', min: 1, max: 600, group: 'Irrigation', help: 'Hard cap for one pump run.' },
  { key: 'daily_max_s', label: 'Daily max', unit: 's', kind: 'int', min: 0, group: 'Irrigation', help: 'Total pump seconds per local day. At least max run.' },
  { key: 'min_interval_s', label: 'Min interval', unit: 's', kind: 'int', min: 0, group: 'Irrigation', help: 'Minimum gap between a run ending and the next automatic start.' },
  { key: 'auto_enabled', label: 'Automatic irrigation', kind: 'bool', group: 'Irrigation', help: 'Off = only manual control.' },
  { key: 'command_expiry_s', label: 'Command expiry', unit: 's', kind: 'int', min: 5, max: 300, group: 'Delivery', help: 'Commands not resolved within this time expire.' },
  { key: 'command_max_retries', label: 'Max delivery attempts', kind: 'int', min: 1, max: 5, group: 'Delivery', help: 'Attempts before a command fails.' },
  { key: 'stale_timeout_s', label: 'Sensor stale after', unit: 's', kind: 'int', min: 60, max: 86400, group: 'Sensor', help: 'Silence longer than this raises an alarm and blocks auto start.' },
  { key: 'max_soil_jump_pct', label: 'Max soil jump', unit: '%', kind: 'num', min: 0, max: 100, group: 'Sensor', help: 'Readings jumping more than this between samples are ignored.' },
  { key: 'soil_dry_raw', label: 'Soil dry raw', kind: 'int', min: 0, max: 4095, group: 'Calibration', help: 'Set on the Calibrate page.' },
  { key: 'soil_wet_raw', label: 'Soil wet raw', kind: 'int', min: 0, max: 4095, group: 'Calibration', help: 'Set on the Calibrate page.' },
  { key: 'retention_days', label: 'Keep history', unit: 'days', kind: 'int', min: 1, max: 3650, group: 'Storage', help: 'Older readings are purged.' },
];

export function SettingsForm({ token }: Props) {
  const { settings, applySettings, refreshSettings } = useLive();
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [serverErr, setServerErr] = useState<string | null>(null);
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (settings && !dirtyRef.current) setDraft(settingsToDraft(settings));
  }, [settings]);

  if (!settings || !draft) {
    return (
      <section className="card">
        <h2>Settings</h2>
        <p className="hint">Loading settings…</p>
      </section>
    );
  }

  const { errors, patch } = validateSettings(draft, settings);
  const hasErrors = Object.keys(errors).length > 0;
  const changed = patch !== null && Object.keys(patch).length > 0;
  const canWrite = token.length > 0;

  const setField = (k: keyof SettingsDraft, v: string | boolean) => {
    dirtyRef.current = true;
    setNotice(null);
    setServerErr(null);
    setDraft((d) => (d ? ({ ...d, [k]: v } as SettingsDraft) : d));
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setNotice(null);
    setServerErr(null);
    if (hasErrors) {
      setNotice({ kind: 'error', text: 'Fix the highlighted fields before saving.' });
      return;
    }
    if (!patch || Object.keys(patch).length === 0) {
      setNotice({ kind: 'ok', text: 'No changes to save.' });
      return;
    }
    setBusy(true);
    try {
      const saved = await api.putSettings(token, patch);
      dirtyRef.current = false;
      applySettings(saved);
      setDraft(settingsToDraft(saved));
      setNotice({ kind: 'ok', text: `Saved ${Object.keys(patch).length} setting(s).` });
      log.info({ keys: Object.keys(patch) }, 'settings saved');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setServerErr('Token rejected (401). Check the API token.');
      else if (err instanceof ApiError && err.status === 400) setServerErr(`Rejected by edge: ${err.message}`);
      else setServerErr(err instanceof Error ? err.message : 'Save failed');
      log.warn({ err: String(err) }, 'settings save failed');
    } finally {
      setBusy(false);
    }
  };

  const onRevert = () => {
    dirtyRef.current = false;
    setDraft(settingsToDraft(settings));
    setNotice(null);
    setServerErr(null);
  };

  const groups = Array.from(new Set(FIELDS.map((f) => f.group)));
  const showErr = (k: keyof Settings): string | undefined => (errors as SettingsErrors)[k];

  return (
    <form className="card settings" onSubmit={onSubmit} noValidate aria-labelledby="settings-title">
      <h2 id="settings-title">Settings</h2>
      {!canWrite && <p className="hint">Enter the API token on the Dashboard tab to save changes.</p>}

      {groups.map((g) => (
        <fieldset key={g} className="fs">
          <legend>{g}</legend>
          {FIELDS.filter((f) => f.group === g).map((f) => {
            const id = `s-${f.key}`;
            const err = showErr(f.key);
            const errId = `${id}-err`;
            const helpId = `${id}-help`;
            if (f.kind === 'bool') {
              return (
                <div className="field field-check" key={f.key}>
                  <label htmlFor={id}>
                    <input
                      id={id}
                      type="checkbox"
                      checked={draft.auto_enabled === true}
                      onChange={(e) => setField('auto_enabled', e.target.checked)}
                      disabled={!canWrite || busy}
                      aria-describedby={helpId}
                    />{' '}
                    {f.label}
                  </label>
                  <p id={helpId} className="hint">{f.help}</p>
                </div>
              );
            }
            return (
              <div className={`field ${err ? 'field-bad' : ''}`} key={f.key}>
                <label htmlFor={id}>
                  {f.label}
                  {f.unit ? <span className="muted"> ({f.unit})</span> : null}
                </label>
                <input
                  id={id}
                  type="number"
                  inputMode={f.kind === 'int' ? 'numeric' : 'decimal'}
                  step={f.kind === 'int' ? 1 : 'any'}
                  min={f.min}
                  max={f.max}
                  value={String(draft[f.key])}
                  onChange={(e) => setField(f.key, e.target.value)}
                  disabled={!canWrite || busy}
                  aria-invalid={err ? true : undefined}
                  aria-describedby={[helpId, err ? errId : ''].filter(Boolean).join(' ')}
                />
                <p id={helpId} className="hint">{f.help}</p>
                {err && <p id={errId} className="error">{err}</p>}
              </div>
            );
          })}
        </fieldset>
      ))}

      {notice && (
        <p className={notice.kind === 'ok' ? 'ok' : 'error'} role="status">
          {notice.text}
        </p>
      )}
      {serverErr && (
        <p className="error" role="alert">
          {serverErr}
        </p>
      )}
      <div className="row actions">
        <button type="submit" className="btn" disabled={!canWrite || busy || !changed}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
        <button type="button" className="btn ghost" onClick={onRevert} disabled={busy || !changed}>
          Revert
        </button>
      </div>
    </form>
  );
}

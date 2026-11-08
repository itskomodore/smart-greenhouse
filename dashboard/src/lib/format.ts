import type { Settings } from '../types.js';

export function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/** Clamp a pump run duration to integer 1..maxRun (mirrors API behaviour). */
export function clampDuration(n: number, maxRun: number): number {
  return clamp(Math.round(n), 1, Math.max(1, Math.floor(maxRun)));
}

/** "12s", "3m 05s", "2h 10m", "1d 4h". Input in whole or fractional seconds. */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** "updated 5s ago" style age text. */
export function fmtAgo(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return 'no data';
  const s = Math.max(0, Math.floor(seconds));
  if (s < 1) return 'just now';
  return `${fmtDuration(s)} ago`;
}

export function fmtNum(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { hour12: false, dateStyle: 'short', timeStyle: 'medium' });
}

/** Soil percent zone relative to thresholds. */
export type SoilZone = 'dry' | 'ok' | 'wet';
export function soilZone(pct: number, s: Pick<Settings, 'low_threshold' | 'high_threshold'>): SoilZone {
  if (pct < s.low_threshold) return 'dry';
  if (pct >= s.high_threshold) return 'wet';
  return 'ok';
}

// ───────── Settings validation (mirrors docs/API.md PUT /api/settings) ─────────

export type SettingsDraft = {
  [K in keyof Settings]: Settings[K] extends boolean ? boolean : string;
};

export type SettingsErrors = Partial<Record<keyof Settings, string>>;

const INT_RE = /^-?\d+$/;
const NUM_RE = /^-?(\d+\.?\d*|\.\d+)$/;

export function settingsToDraft(s: Settings): SettingsDraft {
  const d: Partial<SettingsDraft> = {};
  for (const k of Object.keys(s) as (keyof Settings)[]) {
    const v = s[k];
    (d as Record<string, unknown>)[k] = typeof v === 'boolean' ? v : String(v);
  }
  return d as SettingsDraft;
}

function parseNum(raw: string, integer: boolean): number | null {
  const t = raw.trim();
  if (t === '') return null;
  if (integer ? !INT_RE.test(t) : !NUM_RE.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Validate a draft form. Returns field errors and, when valid, the typed
 * values. Only the keys listed in `changedOnly` (if given) are returned in
 * `patch`, so PUT stays partial.
 */
export function validateSettings(
  draft: SettingsDraft,
  original: Settings,
): { errors: SettingsErrors; patch: Partial<Settings> | null } {
  const errors: SettingsErrors = {};
  const num = (k: keyof Settings, integer: boolean, lo: number, hi: number, label: string): number | undefined => {
    const n = parseNum(String(draft[k]), integer);
    if (n === null) {
      errors[k] = integer ? `${label} must be a whole number` : `${label} must be a number`;
      return undefined;
    }
    if (n < lo || n > hi) {
      errors[k] = `${label} must be between ${lo} and ${hi}`;
      return undefined;
    }
    return n;
  };

  const low = num('low_threshold', false, 0, 100, 'Low threshold');
  const high = num('high_threshold', false, 0, 100, 'High threshold');
  const maxRun = num('max_run_s', true, 1, 600, 'Max run');
  const dailyMax = num('daily_max_s', true, 0, Number.MAX_SAFE_INTEGER, 'Daily max');
  const minInt = num('min_interval_s', true, 0, Number.MAX_SAFE_INTEGER, 'Min interval');
  const expiry = num('command_expiry_s', true, 5, 300, 'Command expiry');
  const retries = num('command_max_retries', true, 1, 5, 'Max retries');
  const stale = num('stale_timeout_s', true, 60, 86400, 'Stale timeout');
  const jump = num('max_soil_jump_pct', false, 0, 100, 'Max soil jump');
  const dry = num('soil_dry_raw', true, 0, 4095, 'Dry raw');
  const wet = num('soil_wet_raw', true, 0, 4095, 'Wet raw');
  const retention = num('retention_days', true, 1, 3650, 'Retention days');

  if (low !== undefined && high !== undefined && !(low < high)) {
    errors.high_threshold = 'High threshold must be greater than low threshold';
  }
  if (dailyMax !== undefined && maxRun !== undefined && dailyMax < maxRun) {
    errors.daily_max_s = 'Daily max must be at least max run';
  }
  if (dry !== undefined && wet !== undefined && dry === wet) {
    errors.soil_wet_raw = 'Wet and dry raw values must differ';
  }

  const autoEnabled = draft.auto_enabled === true;
  if (Object.keys(errors).length > 0) return { errors, patch: null };

  const candidate: Settings = {
    low_threshold: low!,
    high_threshold: high!,
    max_run_s: maxRun!,
    daily_max_s: dailyMax!,
    min_interval_s: minInt!,
    command_expiry_s: expiry!,
    command_max_retries: retries!,
    stale_timeout_s: stale!,
    max_soil_jump_pct: jump!,
    auto_enabled: autoEnabled,
    soil_dry_raw: dry!,
    soil_wet_raw: wet!,
    retention_days: retention!,
  };

  const patch: Partial<Settings> = {};
  for (const k of Object.keys(candidate) as (keyof Settings)[]) {
    if (candidate[k] !== original[k]) {
      (patch as Record<string, unknown>)[k] = candidate[k];
    }
  }
  return { errors, patch };
}

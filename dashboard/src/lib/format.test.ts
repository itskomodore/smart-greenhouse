import { describe, expect, it } from 'vitest';
import {
  clamp,
  clampDuration,
  fmtAgo,
  fmtDuration,
  fmtPct,
  roundPercentText,
  soilZone,
  validateSettings,
  settingsToDraft,
} from './format.js';
import { SETTINGS } from './testFixtures.js';

describe('clamp helpers', () => {
  it('clamps numbers into range', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(Number.NaN, 1, 9)).toBe(1);
  });

  it('clamps pump duration to 1..max_run_s as integer', () => {
    expect(clampDuration(0, 60)).toBe(1);
    expect(clampDuration(-5, 60)).toBe(1);
    expect(clampDuration(30.4, 60)).toBe(30);
    expect(clampDuration(600, 60)).toBe(60);
    expect(clampDuration(45, 0)).toBe(1);
  });
});

describe('formatting', () => {
  it('formats ages', () => {
    expect(fmtAgo(0.2)).toBe('just now');
    expect(fmtAgo(42)).toBe('42s ago');
    expect(fmtAgo(125)).toBe('2m 05s ago');
    expect(fmtAgo(null)).toBe('no data');
  });

  it('formats durations', () => {
    expect(fmtDuration(59)).toBe('59s');
    expect(fmtDuration(3725)).toBe('1h 02m');
    expect(fmtDuration(90000)).toBe('1d 1h');
    expect(fmtDuration(undefined)).toBe('—');
  });

  it('rounds percent values in free text to at most 1 decimal', () => {
    expect(roundPercentText('soil 28.944444444444446% below low 30%')).toBe('soil 28.9% below low 30%');
    expect(roundPercentText('soil 61.25 % at or above high 60.0%')).toBe('soil 61.3 % at or above high 60%');
    expect(roundPercentText('x -0.04% y')).toBe('x 0% y');
    expect(roundPercentText('30% and 12.5%')).toBe('30% and 12.5%');
  });

  it('leaves non-percent decimals and plain text alone', () => {
    expect(roundPercentText('dt=3.14159s, t=21.987°C')).toBe('dt=3.14159s, t=21.987°C');
    expect(roundPercentText('no reason recorded')).toBe('no reason recorded');
  });

  it('formats percent values with fmtPct', () => {
    expect(fmtPct(28.944)).toBe('28.9%');
    expect(fmtPct(30)).toBe('30%');
    expect(fmtPct(30.04)).toBe('30%');
    expect(fmtPct(null)).toBe('—');
    expect(fmtPct(Number.NaN)).toBe('—');
  });

  it('classifies soil zones against thresholds', () => {
    expect(soilZone(10, SETTINGS)).toBe('dry');
    expect(soilZone(30, SETTINGS)).toBe('ok');
    expect(soilZone(59.9, SETTINGS)).toBe('ok');
    expect(soilZone(60, SETTINGS)).toBe('wet');
  });
});

describe('validateSettings (mirrors API.md)', () => {
  const base = () => settingsToDraft(SETTINGS);

  it('returns an empty partial patch when nothing changed', () => {
    const r = validateSettings(base(), SETTINGS);
    expect(r.errors).toEqual({});
    expect(r.patch).toEqual({});
  });

  it('builds a partial patch with typed values', () => {
    const d = base();
    d.low_threshold = '25';
    const r = validateSettings(d, SETTINGS);
    expect(r.errors).toEqual({});
    expect(r.patch).toEqual({ low_threshold: 25 });
  });

  it('requires 0 <= low < high <= 100', () => {
    const d = base();
    d.low_threshold = '70';
    expect(validateSettings(d, SETTINGS).errors.high_threshold).toBeDefined();
    d.low_threshold = '-1';
    expect(validateSettings(d, SETTINGS).errors.low_threshold).toBeDefined();
    d.low_threshold = '10';
    d.high_threshold = '101';
    expect(validateSettings(d, SETTINGS).errors.high_threshold).toBeDefined();
  });

  it('enforces max_run_s 1..600 integer and daily_max_s >= max_run_s', () => {
    const d = base();
    d.max_run_s = '601';
    expect(validateSettings(d, SETTINGS).errors.max_run_s).toBeDefined();
    d.max_run_s = '1.5';
    expect(validateSettings(d, SETTINGS).errors.max_run_s).toBeDefined();
    d.max_run_s = '120';
    d.daily_max_s = '100';
    expect(validateSettings(d, SETTINGS).errors.daily_max_s).toBeDefined();
  });

  it('enforces command and stale ranges', () => {
    const d = base();
    d.command_expiry_s = '4';
    expect(validateSettings(d, SETTINGS).errors.command_expiry_s).toBeDefined();
    d.command_expiry_s = '30';
    d.command_max_retries = '0';
    expect(validateSettings(d, SETTINGS).errors.command_max_retries).toBeDefined();
    d.command_max_retries = '3';
    d.stale_timeout_s = '59';
    expect(validateSettings(d, SETTINGS).errors.stale_timeout_s).toBeDefined();
  });

  it('rejects equal calibration raws and out-of-range 12-bit values', () => {
    const d = base();
    d.soil_dry_raw = '1200';
    d.soil_wet_raw = '1200';
    expect(validateSettings(d, SETTINGS).errors.soil_wet_raw).toBeDefined();
    d.soil_wet_raw = '4096';
    expect(validateSettings(d, SETTINGS).errors.soil_wet_raw).toBeDefined();
  });

  it('treats empty and non-numeric input as errors', () => {
    const d = base();
    d.min_interval_s = '';
    expect(validateSettings(d, SETTINGS).errors.min_interval_s).toBeDefined();
    d.min_interval_s = 'abc';
    expect(validateSettings(d, SETTINGS).errors.min_interval_s).toBeDefined();
  });
});

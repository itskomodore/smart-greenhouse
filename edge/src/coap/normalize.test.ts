import { describe, expect, it } from 'vitest';
import { CalibrationError, normalize } from './normalize.js';
import type { SensorPayload } from '../types.js';

const CAL = { soil_dry_raw: 3000, soil_wet_raw: 1200 };
const NOW = new Date('2026-11-08T12:34:56.789Z');
const base: SensorPayload = { t: 23.41, rh: 55.2, light: 812, soil: 1530 };

describe('normalize: node_id and timestamp', () => {
  it('uses payload.id when present', () => {
    const r = normalize({ ...base, id: 'node-a' }, CAL, { source: '10.0.0.9', now: NOW });
    expect(r.node_id).toBe('node-a');
  });

  it('falls back to source address when id absent', () => {
    const r = normalize(base, CAL, { source: 'fe80::1', now: NOW });
    expect(r.node_id).toBe('fe80::1');
  });

  it('ts is server receipt time as ISO UTC', () => {
    const r = normalize(base, CAL, { source: 'x', now: NOW });
    expect(r.ts).toBe('2026-11-08T12:34:56.789Z');
  });

  it('ts defaults to now when not injected', () => {
    const before = Date.now();
    const r = normalize(base, CAL, { source: 'x' });
    const after = Date.now();
    const ms = Date.parse(r.ts);
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
    expect(r.ts.endsWith('Z')).toBe(true);
  });
});

describe('normalize: field mapping', () => {
  it('copies t, rh and maps light/soil to *_raw', () => {
    const r = normalize(base, CAL, { source: 'x', now: NOW });
    expect(r.t).toBe(23.41);
    expect(r.rh).toBe(55.2);
    expect(r.light_raw).toBe(812);
    expect(r.soil_raw).toBe(1530);
  });

  it('does not emit a DB id', () => {
    const r = normalize(base, CAL, { source: 'x', now: NOW });
    expect(r).not.toHaveProperty('id');
  });
});

type PctCase = { name: string; soil: number; light: number; soil_pct: number; light_pct: number };

const pctCases: PctCase[] = [
  // soil: dry 3000 → 0 %, wet 1200 → 100 %
  { name: 'soil at dry calibration point', soil: 3000, light: 0, soil_pct: 0, light_pct: 0 },
  { name: 'soil at wet calibration point', soil: 1200, light: 4095, soil_pct: 100, light_pct: 100 },
  { name: 'soil midpoint', soil: 2100, light: 2048, soil_pct: 50, light_pct: (2048 / 4095) * 100 },
  { name: 'soil 1530 maps to 81.67 %', soil: 1530, light: 812, soil_pct: ((3000 - 1530) / 1800) * 100, light_pct: (812 / 4095) * 100 },
  // clamp: outside calibration range
  { name: 'soil drier than dry point clamps to 0', soil: 3500, light: 0, soil_pct: 0, light_pct: 0 },
  { name: 'soil wetter than wet point clamps to 100', soil: 100, light: 0, soil_pct: 100, light_pct: 0 },
  { name: 'soil 0 clamps to 100', soil: 0, light: 0, soil_pct: 100, light_pct: 0 },
  { name: 'soil 4095 clamps to 0', soil: 4095, light: 0, soil_pct: 0, light_pct: 0 },
];

describe('normalize: soil_pct and light_pct', () => {
  for (const c of pctCases) {
    it(c.name, () => {
      const r = normalize({ ...base, soil: c.soil, light: c.light }, CAL, { source: 'x', now: NOW });
      expect(r.soil_pct).toBeCloseTo(c.soil_pct, 9);
      expect(r.light_pct).toBeCloseTo(c.light_pct, 9);
      expect(r.soil_pct).toBeGreaterThanOrEqual(0);
      expect(r.soil_pct).toBeLessThanOrEqual(100);
      expect(r.light_pct).toBeGreaterThanOrEqual(0);
      expect(r.light_pct).toBeLessThanOrEqual(100);
    });
  }

  it('never yields negative zero', () => {
    const r = normalize({ ...base, soil: 3500, light: 0 }, CAL, { source: 'x', now: NOW });
    expect(Object.is(r.soil_pct, -0)).toBe(false);
    expect(Object.is(r.light_pct, -0)).toBe(false);
  });

  it('inverted calibration (dry < wet) still maps dry-end to 0 and wet-end to 100', () => {
    const inv = { soil_dry_raw: 1200, soil_wet_raw: 3000 };
    expect(normalize({ ...base, soil: 1200 }, inv, { source: 'x', now: NOW }).soil_pct).toBeCloseTo(0, 9);
    expect(normalize({ ...base, soil: 3000 }, inv, { source: 'x', now: NOW }).soil_pct).toBeCloseTo(100, 9);
  });
});

describe('normalize: dry == wet guard', () => {
  it('throws CalibrationError instead of dividing by zero', () => {
    const degenerate = { soil_dry_raw: 2000, soil_wet_raw: 2000 };
    expect(() => normalize(base, degenerate, { source: 'x', now: NOW })).toThrow(CalibrationError);
  });

  it('never returns NaN or Infinity for any valid calibration', () => {
    const cals = [CAL, { soil_dry_raw: 0, soil_wet_raw: 1 }, { soil_dry_raw: 4095, soil_wet_raw: 0 }];
    for (const cal of cals) {
      for (const soil of [0, 1, 2047, 4094, 4095]) {
        const r = normalize({ ...base, soil }, cal, { source: 'x', now: NOW });
        expect(Number.isFinite(r.soil_pct)).toBe(true);
      }
    }
  });
});

import { describe, it, expect } from 'vitest';
import { assessReading } from './assess.js';
import { SETTINGS_DEFAULTS, type Settings } from '../types.js';

const S: Settings = SETTINGS_DEFAULTS; // max_soil_jump_pct = 40
const T = 1_700_000_000_000;

interface Case {
  name: string;
  prev: { soil_pct: number; ts: number } | null;
  next: { soil_pct: number; ts: number };
  settings?: Partial<Settings>;
  accept: boolean;
}

const cases: Case[] = [
  { name: 'no previous reading: accept', prev: null, next: { soil_pct: 50, ts: T }, accept: true },
  { name: 'no previous reading, soil 0: accept', prev: null, next: { soil_pct: 0, ts: T }, accept: true },
  { name: 'no previous reading, soil 100: accept', prev: null, next: { soil_pct: 100, ts: T }, accept: true },
  { name: 'small change: accept', prev: { soil_pct: 50, ts: T }, next: { soil_pct: 55, ts: T + 1000 }, accept: true },
  { name: 'jump exactly max_soil_jump_pct up: accept', prev: { soil_pct: 20, ts: T }, next: { soil_pct: 60, ts: T + 1000 }, accept: true },
  { name: 'jump exactly max_soil_jump_pct down: accept', prev: { soil_pct: 60, ts: T }, next: { soil_pct: 20, ts: T + 1000 }, accept: true },
  { name: 'jump just over max up (40.01): reject', prev: { soil_pct: 20, ts: T }, next: { soil_pct: 60.01, ts: T + 1000 }, accept: false },
  { name: 'jump just over max down: reject', prev: { soil_pct: 60, ts: T }, next: { soil_pct: 19.9, ts: T + 1000 }, accept: false },
  { name: 'no change: accept', prev: { soil_pct: 42, ts: T }, next: { soil_pct: 42, ts: T + 1000 }, accept: true },
  { name: 'custom max jump 10: 10 accepted', prev: { soil_pct: 50, ts: T }, next: { soil_pct: 60, ts: T + 1000 }, settings: { max_soil_jump_pct: 10 }, accept: true },
  { name: 'custom max jump 10: 10.5 rejected', prev: { soil_pct: 50, ts: T }, next: { soil_pct: 60.5, ts: T + 1000 }, settings: { max_soil_jump_pct: 10 }, accept: false },
  { name: 'out of range below 0: reject', prev: null, next: { soil_pct: -0.1, ts: T }, accept: false },
  { name: 'out of range above 100: reject', prev: { soil_pct: 90, ts: T }, next: { soil_pct: 100.1, ts: T + 1000 }, accept: false },
  { name: 'NaN soil: reject', prev: null, next: { soil_pct: Number.NaN, ts: T }, accept: false },
  { name: 'Infinity soil: reject', prev: { soil_pct: 50, ts: T }, next: { soil_pct: Number.POSITIVE_INFINITY, ts: T + 1000 }, accept: false },
];

describe('assessReading: table-driven', () => {
  it.each(cases)('$name', (c) => {
    const settings: Settings = { ...S, ...c.settings };
    const r = assessReading(c.prev, c.next, settings);
    expect(r.accept).toBe(c.accept);
    if (!r.accept) {
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });
});

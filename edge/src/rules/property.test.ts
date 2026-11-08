import { describe, it, expect } from 'vitest';
import { decide } from './decide.js';
import { assessReading } from './assess.js';
import {
  SETTINGS_DEFAULTS,
  type PumpState,
  type RulesState,
  type Settings,
} from '../types.js';

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type R = () => number;
const int = (r: R, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const chance = (r: R, p: number): boolean => r() < p;
function pick<T>(r: R, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}

const N = 20_000;
const SEED = 0x5eed1234;
const MS = 1000;

function randomState(r: R): RulesState {
  const now = 1_700_000_000_000 + int(r, 0, 10_000_000);

  const settings: Settings = {
    ...SETTINGS_DEFAULTS,
    low_threshold: int(r, 0, 100),
    high_threshold: int(r, 0, 100),
    max_run_s: pick(r, [0, 1, 2, 30, 60, 90, int(r, 0, 300)]),
    daily_max_s: pick(r, [0, 1, 60, 600, int(r, 0, 3600)]),
    min_interval_s: pick(r, [0, 60, 1800, int(r, 0, 7200)]),
    stale_timeout_s: pick(r, [0, 60, 900, int(r, 0, 1800)]),
    max_soil_jump_pct: 40,
    auto_enabled: chance(r, 0.8),
  };

  const latestKind = pick(r, ['null', 'fresh', 'boundary', 'stale']);
  const latest =
    latestKind === 'null'
      ? null
      : {
          soil_pct: pick(r, [settings.low_threshold, settings.high_threshold, int(r, 0, 100), 0, 100]),
          ts:
            latestKind === 'boundary'
              ? now - settings.stale_timeout_s * MS
              : latestKind === 'stale'
                ? now - settings.stale_timeout_s * MS - int(r, 1, 100_000)
                : now - int(r, 0, 2000) * MS,
        };

  const pump: PumpState = pick(r, ['on', 'on', 'off', 'off', 'off', 'unknown']);
  const runStartedAt = chance(r, 0.9)
    ? now - pick(r, [0, settings.max_run_s * MS, settings.max_run_s * MS - 1, int(r, 0, 300_000)])
    : null;
  const lastRunEndedAt = chance(r, 0.5)
    ? now - pick(r, [settings.min_interval_s * MS, settings.min_interval_s * MS - 1, int(r, 0, 9_000_000)])
    : null;
  const dailyMs = settings.daily_max_s * MS;
  const dailyRuntimeMs = pick(r, [0, dailyMs, dailyMs - 1, dailyMs - 500, int(r, 0, dailyMs + 1000)]);

  const manualKind = pick(r, ['none', 'none', 'on', 'off']);
  const manual: RulesState['manual'] =
    manualKind === 'none'
      ? undefined
      : manualKind === 'off'
        ? { cmd: 'off' }
        : { cmd: 'on', duration_s: pick(r, [0, 0.9, 1, 1.5, 30, 60, 200, -5]) };

  return {
    now,
    settings,
    latest,
    pump,
    runStartedAt,
    lastRunEndedAt,
    dailyRuntimeMs,
    commandInFlight: chance(r, 0.2),
    ...(manual === undefined ? {} : { manual }),
  };
}

/**
 * Independently computed list of safety conditions that forbid a START.
 * Deliberately re-derived from raw inputs, not from decide()'s internals.
 */
function startSafetyViolations(s: RulesState): string[] {
  const v: string[] = [];
  const st = s.settings;
  const manualOn = s.manual !== undefined && s.manual.cmd === 'on';

  if (s.pump !== 'off') v.push('pump not off');
  if (s.commandInFlight) v.push('command in flight');
  if (s.latest === null || s.now - s.latest.ts > st.stale_timeout_s * MS) v.push('sensor stale');
  if (s.lastRunEndedAt !== null && s.now - s.lastRunEndedAt < st.min_interval_s * MS) {
    v.push('min interval');
  }
  const remainingWholeS = Math.floor((st.daily_max_s * MS - s.dailyRuntimeMs) / MS);
  if (remainingWholeS < 1) v.push('daily budget exhausted');
  if (st.max_run_s < 1) v.push('max_run_s below 1s');

  if (manualOn) {
    const d = s.manual!.cmd === 'on' ? s.manual!.duration_s : 0;
    if (d < 1) v.push('manual duration below 1s');
  } else {
    if (!st.auto_enabled) v.push('auto disabled');
    if (s.latest === null || !(s.latest.soil_pct < st.low_threshold)) v.push('soil not below low');
  }
  return v;
}

describe('property: start is never emitted when a safety condition is violated', () => {
  it(`holds over ${N} random states (seed ${SEED})`, () => {
    const r = rng(SEED);
    let starts = 0;
    let violatedCases = 0;
    const violationSeen = new Map<string, number>();

    for (let i = 0; i < N; i++) {
      const s = randomState(r);
      const before = JSON.stringify(s);
      const d = decide(s);
      expect(JSON.stringify(s)).toBe(before); // pure: no mutation

      const violations = startSafetyViolations(s);
      for (const v of violations) violationSeen.set(v, (violationSeen.get(v) ?? 0) + 1);

      if (violations.length > 0) {
        violatedCases++;
        expect(d.action, `violations=${violations.join(',')} state=${before}`).not.toBe('start');
      }

      if (d.action === 'start') {
        starts++;
        expect(violations, `start emitted with violations; state=${before}`).toEqual([]);
        expect(Number.isInteger(d.max_s)).toBe(true);
        expect(d.max_s).toBeGreaterThanOrEqual(1);
        expect(d.max_s).toBeLessThanOrEqual(s.settings.max_run_s);
        const remainingWholeS = Math.floor(
          (s.settings.daily_max_s * MS - s.dailyRuntimeMs) / MS,
        );
        expect(d.max_s).toBeLessThanOrEqual(remainingWholeS);
      }

      // Structural invariants of the priority order.
      const manualOff = s.manual?.cmd === 'off';
      if (s.pump === 'unknown' && !manualOff) {
        expect(d.action).toBe('query');
      }
      if (manualOff && s.pump === 'on') {
        expect(d.action).toBe('stop');
      }
      if (d.action === 'query') {
        expect(s.pump).toBe('unknown');
      }
    }

    // Coverage sanity: the generator must actually exercise starts and violations.
    expect(starts).toBeGreaterThan(50);
    expect(violatedCases).toBeGreaterThan(N / 2);
    for (const k of [
      'pump not off',
      'command in flight',
      'sensor stale',
      'min interval',
      'daily budget exhausted',
      'soil not below low',
      'auto disabled',
    ]) {
      expect(violationSeen.get(k) ?? 0, k).toBeGreaterThan(0);
    }
  });
});

describe('property: assessReading accepts iff in range and |jump| <= max', () => {
  it(`holds over ${N} random pairs`, () => {
    const r = rng(SEED + 1);
    for (let i = 0; i < N; i++) {
      const settings: Settings = { ...SETTINGS_DEFAULTS, max_soil_jump_pct: pick(r, [0, 10, 40, 100]) };
      const prevSoil = pick(r, [0, 100, int(r, 0, 100) + r()]);
      const nextSoil = pick(r, [0, 100, int(r, 0, 100) + r(), -r(), 100 + r()]);
      const prev = chance(r, 0.2) ? null : { soil_pct: prevSoil, ts: 0 };
      const next = { soil_pct: nextSoil, ts: 1 };
      const inRange = next.soil_pct >= 0 && next.soil_pct <= 100;
      const jumpOk = prev === null || Math.abs(next.soil_pct - prev.soil_pct) <= settings.max_soil_jump_pct;
      const expected = inRange && jumpOk;
      expect(assessReading(prev, next, settings).accept).toBe(expected);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { decide } from './decide.js';
import { SETTINGS_DEFAULTS, type AlarmCode, type RulesState, type Settings } from '../types.js';

const NOW = 1_700_000_000_000;
const MS = 1000;

function mk(over: Partial<RulesState> = {}, settings: Partial<Settings> = {}): RulesState {
  return {
    now: NOW,
    settings: { ...SETTINGS_DEFAULTS, ...settings },
    latest: { soil_pct: 50, ts: NOW - 1000 },
    pump: 'off',
    runStartedAt: null,
    lastRunEndedAt: null,
    dailyRuntimeMs: 0,
    commandInFlight: false,
    ...over,
  };
}

interface Case {
  name: string;
  s: RulesState;
  action: 'none' | 'start' | 'stop' | 'query';
  max_s?: number;
  trigger?: 'auto' | 'manual';
  alarms: AlarmCode[];
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

const cases: Case[] = [
  // ── auto start: low threshold and hysteresis band ──
  { name: 'auto: soil well below low starts with max_run_s', s: mk({ latest: { soil_pct: 10, ts: NOW } }), action: 'start', trigger: 'auto', max_s: 60, alarms: [] },
  { name: 'auto: soil 29.999 starts', s: mk({ latest: { soil_pct: 29.999, ts: NOW } }), action: 'start', trigger: 'auto', max_s: 60, alarms: [] },
  { name: 'auto: soil exactly low does NOT start', s: mk({ latest: { soil_pct: 30, ts: NOW } }), action: 'none', alarms: [] },
  { name: 'auto: soil inside band does NOT start', s: mk({ latest: { soil_pct: 45, ts: NOW } }), action: 'none', alarms: [] },
  { name: 'auto: soil just below high (inside band) does NOT start', s: mk({ latest: { soil_pct: 59.999, ts: NOW } }), action: 'none', alarms: [] },
  { name: 'auto: soil exactly high does NOT start', s: mk({ latest: { soil_pct: 60, ts: NOW } }), action: 'none', alarms: [] },
  { name: 'auto: auto_enabled=false never starts', s: mk({ latest: { soil_pct: 5, ts: NOW } }, { auto_enabled: false }), action: 'none', alarms: [] },

  // ── sensor stale (boundary = stale_timeout_s exactly is NOT stale) ──
  { name: 'stale: age exactly stale_timeout_s is fresh (start)', s: mk({ latest: { soil_pct: 10, ts: NOW - 900 * MS } }), action: 'start', trigger: 'auto', max_s: 60, alarms: [] },
  { name: 'stale: age stale_timeout_s + 1ms is stale (no start, alarm)', s: mk({ latest: { soil_pct: 10, ts: NOW - 900 * MS - 1 } }), action: 'none', alarms: ['sensor_stale'] },
  { name: 'stale: no reading at all (no start, alarm)', s: mk({ latest: null }), action: 'none', alarms: ['sensor_stale'] },
  { name: 'stale: manual on refused, alarm', s: mk({ latest: { soil_pct: 10, ts: NOW - 2000 * MS }, manual: { cmd: 'on', duration_s: 30 } }), action: 'none', alarms: ['sensor_stale'] },
  { name: 'stale: pump on, under limits -> none, alarm', s: mk({ pump: 'on', runStartedAt: NOW - 10 * MS, latest: null }), action: 'none', alarms: ['sensor_stale'] },
  { name: 'stale: pump on, soil high -> still STOP (safety)', s: mk({ pump: 'on', runStartedAt: NOW - 10 * MS, latest: { soil_pct: 80, ts: NOW - 5000 * MS } }), action: 'stop', alarms: ['sensor_stale'] },
  { name: 'stale: pump on, max runtime -> STOP', s: mk({ pump: 'on', runStartedAt: NOW - 60 * MS, latest: null }), action: 'stop', alarms: ['sensor_stale'] },
  { name: 'stale: manual off still honoured', s: mk({ pump: 'on', runStartedAt: NOW - 5 * MS, latest: null, manual: { cmd: 'off' } }), action: 'stop', alarms: ['sensor_stale'] },

  // ── min interval (boundary = min_interval_s exactly is allowed) ──
  { name: 'interval: exactly min_interval_s since last end -> start', s: mk({ latest: { soil_pct: 10, ts: NOW }, lastRunEndedAt: NOW - 1800 * MS }), action: 'start', trigger: 'auto', max_s: 60, alarms: [] },
  { name: 'interval: 1ms short -> none', s: mk({ latest: { soil_pct: 10, ts: NOW }, lastRunEndedAt: NOW - 1800 * MS + 1 }), action: 'none', alarms: [] },
  { name: 'interval: lastRunEndedAt null -> no block', s: mk({ latest: { soil_pct: 10, ts: NOW }, lastRunEndedAt: null }), action: 'start', trigger: 'auto', max_s: 60, alarms: [] },

  // ── daily cap (budget clamps max_s; exhausted => no start + alarm) ──
  { name: 'daily: 30s left clamps auto max_s to 30', s: mk({ latest: { soil_pct: 10, ts: NOW }, dailyRuntimeMs: 570 * MS }), action: 'start', trigger: 'auto', max_s: 30, alarms: [] },
  { name: 'daily: 0.5s left (no whole second) -> none, cap alarm', s: mk({ latest: { soil_pct: 10, ts: NOW }, dailyRuntimeMs: 600 * MS - 500 }), action: 'none', alarms: ['daily_cap_reached'] },
  { name: 'daily: exactly exhausted -> none, cap alarm', s: mk({ latest: { soil_pct: 10, ts: NOW }, dailyRuntimeMs: 600 * MS }), action: 'none', alarms: ['daily_cap_reached'] },
  { name: 'daily: over budget -> none, cap alarm', s: mk({ latest: { soil_pct: 10, ts: NOW }, dailyRuntimeMs: 700 * MS }), action: 'none', alarms: ['daily_cap_reached'] },
  { name: 'daily: 1s left and max_run 60 -> max_s 1', s: mk({ latest: { soil_pct: 10, ts: NOW }, dailyRuntimeMs: 599 * MS }), action: 'start', trigger: 'auto', max_s: 1, alarms: [] },

  // ── commandInFlight ──
  { name: 'in-flight: blocks auto start', s: mk({ latest: { soil_pct: 10, ts: NOW }, commandInFlight: true }), action: 'none', alarms: [] },
  { name: 'in-flight: blocks manual on', s: mk({ commandInFlight: true, manual: { cmd: 'on', duration_s: 30 } }), action: 'none', alarms: [] },
  { name: 'in-flight: pump on within limits -> none', s: mk({ pump: 'on', runStartedAt: NOW - 5 * MS, commandInFlight: true }), action: 'none', alarms: [] },
  { name: 'in-flight: pump on + high soil -> STOP wins over in-flight', s: mk({ pump: 'on', runStartedAt: NOW - 5 * MS, commandInFlight: true, latest: { soil_pct: 61, ts: NOW } }), action: 'stop', alarms: [] },

  // ── unknown pump: query first, never start ──
  { name: 'unknown: dry soil -> query, not start', s: mk({ pump: 'unknown', latest: { soil_pct: 5, ts: NOW } }), action: 'query', alarms: ['actuator_state_unknown'] },
  { name: 'unknown: manual on -> query, not start', s: mk({ pump: 'unknown', manual: { cmd: 'on', duration_s: 30 } }), action: 'query', alarms: ['actuator_state_unknown'] },
  { name: 'unknown + stale -> query with both alarms', s: mk({ pump: 'unknown', latest: null }), action: 'query', alarms: ['actuator_state_unknown', 'sensor_stale'] },
  { name: 'unknown: manual off -> STOP still', s: mk({ pump: 'unknown', manual: { cmd: 'off' } }), action: 'stop', alarms: ['actuator_state_unknown'] },
  { name: 'unknown: in-flight does not turn query into none', s: mk({ pump: 'unknown', commandInFlight: true }), action: 'query', alarms: ['actuator_state_unknown'] },

  // ── pump on: max runtime boundary and high threshold boundary ──
  { name: 'on: 59.999s elapsed -> none', s: mk({ pump: 'on', runStartedAt: NOW - 59999 }), action: 'none', alarms: [] },
  { name: 'on: exactly max_run_s elapsed -> STOP', s: mk({ pump: 'on', runStartedAt: NOW - 60 * MS }), action: 'stop', alarms: [] },
  { name: 'on: soil just below high -> none', s: mk({ pump: 'on', runStartedAt: NOW - 5 * MS, latest: { soil_pct: 59.999, ts: NOW } }), action: 'none', alarms: [] },
  { name: 'on: soil exactly high -> STOP', s: mk({ pump: 'on', runStartedAt: NOW - 5 * MS, latest: { soil_pct: 60, ts: NOW } }), action: 'stop', alarms: [] },
  { name: 'on: auto-enabled false does not stop a run that is within limits', s: mk({ pump: 'on', runStartedAt: NOW - 5 * MS }, { auto_enabled: false }), action: 'none', alarms: [] },
  { name: 'on: run start unknown -> safe STOP', s: mk({ pump: 'on', runStartedAt: null }), action: 'stop', alarms: [] },
  { name: 'on: daily budget consumed by run -> STOP', s: mk({ pump: 'on', runStartedAt: NOW - 30 * MS, dailyRuntimeMs: 580 * MS }), action: 'stop', alarms: ['daily_cap_reached'] },
  { name: 'on: manual on while running -> none (no restart)', s: mk({ pump: 'on', runStartedAt: NOW - 5 * MS, manual: { cmd: 'on', duration_s: 30 } }), action: 'none', alarms: [] },
  { name: 'on: manual on while running but soil high -> STOP', s: mk({ pump: 'on', runStartedAt: NOW - 5 * MS, latest: { soil_pct: 90, ts: NOW }, manual: { cmd: 'on', duration_s: 30 } }), action: 'stop', alarms: [] },

  // ── manual off: always honoured ──
  { name: 'manual off: pump off -> none', s: mk({ manual: { cmd: 'off' } }), action: 'none', alarms: [] },
  { name: 'manual off: pump off with command in flight -> STOP (cancel pending)', s: mk({ commandInFlight: true, manual: { cmd: 'off' } }), action: 'stop', alarms: [] },
  { name: 'manual off: pump on -> STOP', s: mk({ pump: 'on', runStartedAt: NOW - 5 * MS, manual: { cmd: 'off' } }), action: 'stop', alarms: [] },
  { name: 'manual off: pump on + in flight -> STOP', s: mk({ pump: 'on', runStartedAt: NOW - 5 * MS, commandInFlight: true, manual: { cmd: 'off' } }), action: 'stop', alarms: [] },
  { name: 'manual off: pump on + daily cap -> STOP with cap alarm', s: mk({ pump: 'on', runStartedAt: NOW - 5 * MS, dailyRuntimeMs: 600 * MS, manual: { cmd: 'off' } }), action: 'stop', alarms: ['daily_cap_reached'] },

  // ── manual on: same limits, clamped ──
  { name: 'manual on: starts with requested duration', s: mk({ manual: { cmd: 'on', duration_s: 30 } }), action: 'start', trigger: 'manual', max_s: 30, alarms: [] },
  { name: 'manual on: duration clamped to max_run_s', s: mk({ manual: { cmd: 'on', duration_s: 300 } }), action: 'start', trigger: 'manual', max_s: 60, alarms: [] },
  { name: 'manual on: duration clamped to remaining daily budget', s: mk({ dailyRuntimeMs: 580 * MS, manual: { cmd: 'on', duration_s: 60 } }), action: 'start', trigger: 'manual', max_s: 20, alarms: [] },
  { name: 'manual on: duration 0 refused', s: mk({ manual: { cmd: 'on', duration_s: 0 } }), action: 'none', alarms: [] },
  { name: 'manual on: negative duration refused', s: mk({ manual: { cmd: 'on', duration_s: -5 } }), action: 'none', alarms: [] },
  { name: 'manual on: NaN duration refused', s: mk({ manual: { cmd: 'on', duration_s: Number.NaN } }), action: 'none', alarms: [] },
  { name: 'manual on: daily cap exhausted -> refused, cap alarm', s: mk({ dailyRuntimeMs: 600 * MS, manual: { cmd: 'on', duration_s: 30 } }), action: 'none', alarms: ['daily_cap_reached'] },
  { name: 'manual on: inside min interval -> refused', s: mk({ lastRunEndedAt: NOW - 1799 * MS, manual: { cmd: 'on', duration_s: 30 } }), action: 'none', alarms: [] },
  { name: 'manual on: exactly min interval -> start', s: mk({ lastRunEndedAt: NOW - 1800 * MS, manual: { cmd: 'on', duration_s: 30 } }), action: 'start', trigger: 'manual', max_s: 30, alarms: [] },
  { name: 'manual on: ignores soil level and auto_enabled', s: mk({ latest: { soil_pct: 95, ts: NOW }, manual: { cmd: 'on', duration_s: 30 } }, { auto_enabled: false }), action: 'start', trigger: 'manual', max_s: 30, alarms: [] },
  { name: 'manual on: pump unknown -> query', s: mk({ pump: 'unknown', manual: { cmd: 'on', duration_s: 30 } }), action: 'query', alarms: ['actuator_state_unknown'] },

  // ── no request, nothing to do ──
  { name: 'idle: soil fine, pump off -> none', s: mk({ latest: { soil_pct: 80, ts: NOW } }), action: 'none', alarms: [] },
];

describe('decide: table-driven', () => {
  it.each(cases)('$name', (c) => {
    const d = decide(c.s);
    expect(d.action).toBe(c.action);
    expect(sorted(d.alarms)).toEqual(sorted(c.alarms));
    if (c.action === 'start') {
      expect(d).toMatchObject({ max_s: c.max_s, trigger: c.trigger });
    }
  });
});

describe('decide: purity', () => {
  it('same input gives same output and does not mutate state', () => {
    const s = mk({ latest: { soil_pct: 10, ts: NOW }, manual: { cmd: 'on', duration_s: 30 } });
    const before = JSON.stringify(s);
    const a = decide(s);
    const b = decide(s);
    expect(a).toEqual(b);
    expect(JSON.stringify(s)).toBe(before);
  });
});

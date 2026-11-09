import type { AlarmCode, Decision, RulesState } from '../types.js';

/**
 * Pure rules engine: RulesState in, Decision out. No I/O, no clock reads, no randomness.
 * Priority: manual off > stop conditions > unknown pump (query) > command in flight (none)
 *           > manual on (clamped) > auto start.
 */

const MS = 1000;

interface Derived {
  /** No usable reading within stale_timeout_s (or no reading at all). */
  stale: boolean;
  /** Elapsed time of the current run; 0 when pump is not known to be on. */
  runElapsedMs: number;
  /** Whole seconds of daily budget left, running portion included. Never negative. */
  budgetS: number;
}

function derive(state: RulesState): Derived {
  const { now, settings, latest, pump, runStartedAt, dailyRuntimeMs } = state;
  const stale = latest === null || now - latest.ts > settings.stale_timeout_s * MS;
  const runElapsedMs =
    pump === 'on' && runStartedAt !== null ? Math.max(0, now - runStartedAt) : 0;
  const consumedMs = dailyRuntimeMs + runElapsedMs;
  const budgetS = Math.floor((settings.daily_max_s * MS - consumedMs) / MS);
  return { stale, runElapsedMs, budgetS: Math.max(0, budgetS) };
}

function rulesAlarms(state: RulesState, d: Derived): AlarmCode[] {
  const alarms: AlarmCode[] = [];
  if (d.stale) alarms.push('sensor_stale');
  if (d.budgetS <= 0) alarms.push('daily_cap_reached');
  if (state.pump === 'unknown') alarms.push('actuator_state_unknown');
  return alarms;
}

function minIntervalBlocked(state: RulesState): boolean {
  return (
    state.lastRunEndedAt !== null &&
    state.now - state.lastRunEndedAt < state.settings.min_interval_s * MS
  );
}

/** Reason the running pump must be stopped now, or null if it may keep running. */
function stopReason(state: RulesState, d: Derived): string | null {
  const { settings, latest, runStartedAt } = state;
  if (runStartedAt === null) return 'run start time unknown; safe stop';
  if (d.runElapsedMs >= settings.max_run_s * MS) return 'max runtime reached';
  if (latest !== null && latest.soil_pct >= settings.high_threshold) return 'high threshold reached';
  if (d.budgetS <= 0) return 'daily cap reached during run';
  return null;
}

function manualOn(state: RulesState, d: Derived, alarms: AlarmCode[]): Decision {
  const manual = state.manual;
  if (manual === undefined || manual.cmd !== 'on') {
    // Unreachable by construction; keeps the function total.
    return { action: 'none', reason: 'no manual on request', alarms };
  }
  const requested = manual.duration_s;
  if (!Number.isFinite(requested) || requested <= 0) {
    return { action: 'none', reason: 'manual on refused: invalid duration', alarms };
  }
  if (d.stale) {
    return { action: 'none', reason: 'manual on refused: sensor stale', alarms };
  }
  if (minIntervalBlocked(state)) {
    return { action: 'none', reason: 'manual on refused: min interval since last run', alarms };
  }
  if (d.budgetS <= 0) {
    return { action: 'none', reason: 'manual on refused: daily cap reached', alarms };
  }
  const maxS = Math.floor(Math.min(requested, state.settings.max_run_s, d.budgetS));
  if (maxS <= 0) {
    return { action: 'none', reason: 'manual on refused: no runtime allowed by limits', alarms };
  }
  const clamped = maxS < requested;
  return {
    action: 'start',
    max_s: maxS,
    trigger: 'manual',
    reason: clamped ? `manual on, clamped to ${maxS}s` : `manual on for ${maxS}s`,
    alarms,
  };
}

function autoStart(state: RulesState, d: Derived, alarms: AlarmCode[]): Decision {
  const { settings, latest } = state;
  if (!settings.auto_enabled) {
    return { action: 'none', reason: 'auto disabled', alarms };
  }
  if (latest === null || d.stale) {
    return { action: 'none', reason: 'sensor stale; no auto start', alarms };
  }
  if (!(latest.soil_pct < settings.low_threshold)) {
    return { action: 'none', reason: 'soil not below low threshold', alarms };
  }
  if (minIntervalBlocked(state)) {
    return { action: 'none', reason: 'min interval since last run not elapsed', alarms };
  }
  if (d.budgetS <= 0) {
    return { action: 'none', reason: 'daily cap reached', alarms };
  }
  const maxS = Math.floor(Math.min(settings.max_run_s, d.budgetS));
  if (maxS <= 0) {
    return { action: 'none', reason: 'no runtime allowed by limits', alarms };
  }
  return {
    action: 'start',
    max_s: maxS,
    trigger: 'auto',
    reason: `soil ${Number(latest.soil_pct.toFixed(1))}% below low ${settings.low_threshold}%`,
    alarms,
  };
}

export function decide(state: RulesState): Decision {
  const d = derive(state);
  const alarms = rulesAlarms(state, d);
  const manual = state.manual;

  // 1. Manual off is always honoured. Stop unless the pump is known off with nothing pending.
  if (manual !== undefined && manual.cmd === 'off') {
    if (state.pump === 'off' && !state.commandInFlight) {
      return { action: 'none', reason: 'manual off: pump already off', alarms };
    }
    return { action: 'stop', reason: 'manual off', alarms };
  }

  // 2. Stop conditions apply to a running pump, regardless of sensor staleness or command in flight.
  if (state.pump === 'on') {
    const why = stopReason(state, d);
    if (why !== null) return { action: 'stop', reason: why, alarms };
    return { action: 'none', reason: 'pump running within limits', alarms };
  }

  // 3. Unknown pump state: query first. Never start on unknown.
  if (state.pump === 'unknown') {
    return { action: 'query', reason: 'pump state unknown; query before any start', alarms };
  }

  // 4. Pump is off. A command already in flight blocks any new start.
  if (state.commandInFlight) {
    return { action: 'none', reason: 'command in flight', alarms };
  }

  // 5. Manual on (same limits as auto, duration clamped).
  if (manual !== undefined && manual.cmd === 'on') {
    return manualOn(state, d, alarms);
  }

  // 6. Auto start.
  return autoStart(state, d, alarms);
}

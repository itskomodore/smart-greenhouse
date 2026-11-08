import type { CommandState, CommandType, PumpState } from '../types.js';

export type PumpCmd = 'on' | 'off';

const ACTIVE: ReadonlySet<CommandState> = new Set<CommandState>(['pending', 'sent']);

export function isActive(state: CommandState | null | undefined): boolean {
  return state !== null && state !== undefined && ACTIVE.has(state);
}

export interface PumpGateInput {
  canWrite: boolean;
  maxRunKnown: boolean;
  /** Request currently in flight from this panel, if any. */
  inflight: PumpCmd | null;
  commandType: CommandType | null | undefined;
  commandState: CommandState | null | undefined;
}

export interface PumpGate {
  onDisabled: boolean;
  offDisabled: boolean;
}

/**
 * Button enablement. Safety: OFF is never blocked by an ON (in flight or pending);
 * ON is grayed while anything is busy or an OFF is pending.
 */
export function pumpGate(i: PumpGateInput): PumpGate {
  if (!i.canWrite) return { onDisabled: true, offDisabled: true };
  const offPending = i.commandType === 'pump_off' && isActive(i.commandState);
  const onPending = i.commandType === 'pump_on' && isActive(i.commandState);
  return {
    onDisabled: !i.maxRunKnown || i.inflight !== null || offPending || onPending,
    offDisabled: i.inflight === 'off',
  };
}

export type ResultTone = 'ok' | 'pending' | 'error';

export interface PumpResult {
  tone: ResultTone;
  text: string;
}

/** Text for a settled or pending command result (acked/failed/expired/pending). */
export function commandResult(state: CommandState, lastError: string | null, pump?: PumpState): PumpResult {
  switch (state) {
    case 'acked':
      return { tone: 'ok', text: pump ? `Pump is ${pump.toUpperCase()}.` : 'Acknowledged by pump controller.' };
    case 'failed':
      return { tone: 'error', text: lastError ? `Failed: ${lastError}` : 'Command failed.' };
    case 'expired':
      return { tone: 'error', text: 'Expired before the pump responded.' };
    default:
      return { tone: 'pending', text: 'Pending…' };
  }
}

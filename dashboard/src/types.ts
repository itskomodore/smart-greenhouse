/**
 * Dashboard-local copy of the edge contracts.
 * Source: edge/src/types.ts and docs/API.md (supervisor-owned). Keep in sync by hand;
 * do NOT import across packages.
 */

export type PumpState = 'on' | 'off' | 'unknown';
export type CommandType = 'pump_on' | 'pump_off' | 'pump_query';
export type CommandState = 'pending' | 'sent' | 'acked' | 'failed' | 'expired';
export type Trigger = 'auto' | 'manual' | 'recovery';

export interface Command {
  id: string;
  ts: string;
  type: CommandType;
  state: CommandState;
  expires_at: string;
  ack_ts: string | null;
  max_s: number | null;
  attempts: number;
  trigger: Trigger;
  reason: string;
  last_error: string | null;
}

export type IrrigationResult = 'running' | 'completed' | 'stopped' | 'failed' | 'aborted';

export interface IrrigationEvent {
  id?: number;
  ts_start: string;
  ts_end: string | null;
  trigger: 'auto' | 'manual';
  reason: string;
  result: IrrigationResult;
}

export type AlarmCode =
  | 'sensor_stale'
  | 'actuator_unreachable'
  | 'pump_failed'
  | 'actuator_state_unknown'
  | 'soil_jump_ignored'
  | 'daily_cap_reached'
  | 'db_down';

export interface Alarm {
  code: AlarmCode;
  since: string;
  message: string;
  severity: 'warn' | 'critical';
}

export interface Reading {
  id?: number;
  node_id: string;
  ts: string;
  t: number;
  rh: number;
  light_raw: number;
  soil_raw: number;
  soil_pct: number;
  light_pct: number;
}

export interface Settings {
  low_threshold: number;
  high_threshold: number;
  max_run_s: number;
  daily_max_s: number;
  min_interval_s: number;
  command_expiry_s: number;
  command_max_retries: number;
  stale_timeout_s: number;
  max_soil_jump_pct: number;
  auto_enabled: boolean;
  soil_dry_raw: number;
  soil_wet_raw: number;
  retention_days: number;
}

/** GET /api/status */
export interface NodeStatus {
  last_seen: string;
  age_s: number;
  stale: boolean;
}

export interface Status {
  now: string;
  uptime_s: number;
  pump: { state: PumpState; since: string | null; command: Command | null };
  nodes: Record<string, NodeStatus>;
  alarms: Alarm[];
  db: boolean;
  auto_enabled: boolean;
  daily_runtime_s: number;
}

/** GET /api/latest */
export interface Latest {
  reading: Reading | null;
  age_s: number | null;
  nodes: Record<string, string>;
}

/** POST /api/pump: 200 when settled (pump present), 202 when still pending (pump absent). */
export interface PumpAccepted {
  command: Command;
  duplicate: boolean;
  pump?: PumpState;
}

/** POST /api/calibrate/{dry|wet} 200 */
export interface CalibrateResult {
  soil_dry_raw: number;
  soil_wet_raw: number;
  captured_raw: number;
}

/** Live events (GET /api/stream). */
export type SseEvent =
  | { type: 'reading'; data: Reading }
  | { type: 'pump'; data: { state: PumpState; command?: Command } }
  | { type: 'event'; data: IrrigationEvent }
  | { type: 'alarms'; data: Alarm[] }
  | { type: 'settings'; data: Settings };

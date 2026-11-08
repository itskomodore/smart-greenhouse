/**
 * SHARED CONTRACTS. Supervisor-owned. Agents import, never edit.
 * Time: epoch ms (number) inside pure logic; ISO-8601 UTC strings at DB/API edge.
 */

// ───────────── Readings ─────────────

/** Validated CoAP payload (what the sensor sends). */
export interface SensorPayload {
  id?: string;
  t: number;     // °C, -40..85
  rh: number;    // %RH, 0..100
  light: number; // raw ADC int 0..4095
  soil: number;  // raw ADC int 0..4095
}

export interface Reading {
  id?: number;
  node_id: string;
  ts: string;         // ISO UTC, server receipt time
  t: number;
  rh: number;
  light_raw: number;
  soil_raw: number;
  soil_pct: number;   // 0..100
  light_pct: number;  // 0..100
}

export type ValidationResult =
  | { ok: true; value: SensorPayload }
  | { ok: false; error: string };

// ───────────── Settings (DB `settings` table, key -> JSON value) ─────────────

export interface Settings {
  low_threshold: number;        // % soil; start below
  high_threshold: number;       // % soil; stop at/above
  max_run_s: number;            // per-run cap (also sent to actuator)
  daily_max_s: number;          // total pump seconds per local day
  min_interval_s: number;       // min gap between irrigation END and next auto START
  command_expiry_s: number;     // command TTL
  command_max_retries: number;  // delivery attempts before failed
  stale_timeout_s: number;      // sensor silent => alarm + no auto
  max_soil_jump_pct: number;    // |Δsoil_pct| between consecutive readings above this => ignore
  auto_enabled: boolean;
  soil_dry_raw: number;         // calibration
  soil_wet_raw: number;
  retention_days: number;
}

export const SETTINGS_DEFAULTS: Settings = {
  low_threshold: 30,
  high_threshold: 60,
  max_run_s: 60,
  daily_max_s: 600,
  min_interval_s: 1800,
  command_expiry_s: 30,
  command_max_retries: 3,
  stale_timeout_s: 900,
  max_soil_jump_pct: 40,
  auto_enabled: true,
  soil_dry_raw: 3000,
  soil_wet_raw: 1200,
  retention_days: 90,
};

// ───────────── Commands ─────────────

export type CommandType = 'pump_on' | 'pump_off' | 'pump_query';
export type CommandState = 'pending' | 'sent' | 'acked' | 'failed' | 'expired';
export type Trigger = 'auto' | 'manual' | 'recovery';

export interface Command {
  id: string;              // uuid v4; idempotency key (same id => same effect)
  ts: string;              // ISO created
  type: CommandType;
  state: CommandState;
  expires_at: string;      // ISO; never execute/send after this
  ack_ts: string | null;
  max_s: number | null;    // runtime limit sent to actuator (pump_on only)
  attempts: number;
  trigger: Trigger;
  reason: string;
  last_error: string | null;
}

export type PumpState = 'on' | 'off' | 'unknown';

// ───────────── Irrigation events ─────────────

export type IrrigationResult = 'running' | 'completed' | 'stopped' | 'failed' | 'aborted';

export interface IrrigationEvent {
  id?: number;
  ts_start: string;
  ts_end: string | null;
  trigger: 'auto' | 'manual';
  reason: string;
  result: IrrigationResult;
}

// ───────────── Alarms ─────────────

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
  since: string;          // ISO
  message: string;
  severity: 'warn' | 'critical';
}

// ───────────── Rules engine (PURE: state in, decision out) ─────────────

export interface RulesState {
  now: number;                         // epoch ms (injected clock)
  settings: Settings;
  /** last ACCEPTED reading (jump-filter applied) */
  latest: { soil_pct: number; ts: number } | null;
  pump: PumpState;                     // from last ack; 'unknown' after boot / failure
  runStartedAt: number | null;         // when current run began (ack time)
  lastRunEndedAt: number | null;
  dailyRuntimeMs: number;              // already consumed in current day (incl. running portion NOT counted)
  commandInFlight: boolean;            // pending|sent command exists
  /** operator request, if any, this tick */
  manual?: { cmd: 'on'; duration_s: number } | { cmd: 'off' };
}

export type Decision =
  | { action: 'none'; reason: string; alarms: AlarmCode[] }
  | { action: 'start'; max_s: number; trigger: 'auto' | 'manual'; reason: string; alarms: AlarmCode[] }
  | { action: 'stop'; reason: string; alarms: AlarmCode[] }
  | { action: 'query'; reason: string; alarms: AlarmCode[] }; // pump state unknown => safe-off/query first

/** `alarms` in Decision = full set of rule-derived alarms currently active (engine-level, not latched). */

export type ReadingAssessment =
  | { accept: true }
  | { accept: false; reason: string }; // implausible jump etc.

// ───────────── Ports (interfaces between modules) ─────────────

/** Actuator transport adapter. ALL path/payload shapes live in src/actuator/adapter.ts. */
export interface ActuatorAdapter {
  /** Send command; resolve with ack (state reported by actuator) or reject on timeout/error. */
  send(cmd: Command): Promise<ActuatorAck>;
  /** Query current pump state. */
  query(): Promise<ActuatorAck>;
}
export interface ActuatorAck {
  command_id: string | null;
  pump: 'on' | 'off';
  remaining_s?: number;
}

/** Repository port implemented by db-agent. */
export interface Repo {
  insertReading(r: Reading): Promise<void>;
  latestReading(node_id?: string): Promise<Reading | null>;
  readings(q: { from?: string; to?: string; limit?: number; node_id?: string }): Promise<Reading[]>;
  nodeLastSeen(): Promise<Record<string, string>>;

  getSettings(): Promise<Settings>;
  putSettings(patch: Partial<Settings>): Promise<Settings>;

  upsertCommand(c: Command): Promise<void>;           // idempotent by id
  getCommand(id: string): Promise<Command | null>;
  openCommands(): Promise<Command[]>;                  // pending|sent

  insertEvent(e: Omit<IrrigationEvent, 'id'>): Promise<number>;
  updateEvent(id: number, patch: Partial<IrrigationEvent>): Promise<void>;
  recentEvents(limit: number): Promise<IrrigationEvent[]>;
  openEvent(): Promise<(IrrigationEvent & { id: number }) | null>;
  runtimeSecondsSince(iso: string): Promise<number>;
  /** Seconds of CLOSED events (ts_end not null) clipped to [iso, now]. Excludes running rows. No row-count cap. */
  closedRuntimeSecondsSince(iso: string): Promise<number>;
  /** Latest ts_end over all closed irrigation events, or null. Used to restore min-interval after restart. */
  lastEventEnd(): Promise<string | null>;

  saveAlarm(a: Alarm | { code: AlarmCode; cleared: true }): Promise<void>;
  activeAlarms(): Promise<Alarm[]>;

  enqueueOutbox(kind: string, payload: unknown): Promise<void>;
  pendingOutbox(limit: number): Promise<OutboxRow[]>;
  markOutboxSent(ids: number[]): Promise<void>;

  purgeOlderThan(days: number): Promise<{ readings: number }>;
  ping(): Promise<boolean>;
}

export interface OutboxRow { id: number; ts: string; kind: string; payload: unknown; sent_at: string | null }

/** Cloud sync stub (future). No-op implementation ships now. */
export interface CloudGateway {
  push(rows: OutboxRow[]): Promise<{ sentIds: number[] }>;
}

/** Live events pushed over SSE (GET /api/stream). */
export type SseEvent =
  | { type: 'reading'; data: Reading }
  | { type: 'pump'; data: { state: PumpState; command?: Command } }
  | { type: 'event'; data: IrrigationEvent }
  | { type: 'alarms'; data: Alarm[] }
  | { type: 'settings'; data: Settings };

/** Process-wide event bus topics (typed EventEmitter in src/bus.ts, db/coap/rules/api all use). */
export interface BusEvents {
  reading: Reading;
  pump: { state: PumpState; command?: Command };
  event: IrrigationEvent;
  alarms: Alarm[];
  settings: Settings;
}

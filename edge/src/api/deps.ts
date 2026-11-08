/**
 * Thin ports the HTTP API depends on. The API never imports controller or command-manager
 * internals: the real Controller, BufferedRepo and process bus satisfy these structurally
 * (wired in src/main.ts). Keep this file small; widening it couples the API to internals.
 */
import type { TypedBus } from '../bus.js';
import type { Command, PumpState, Repo } from '../types.js';

/** Repository surface used by the API. BufferedRepo satisfies it (dbUp wired in main.ts). */
export type ApiRepo = Pick<
  Repo,
  'latestReading' | 'readings' | 'nodeLastSeen' | 'getSettings' | 'putSettings' | 'recentEvents' | 'activeAlarms' | 'getCommand'
> & {
  /** Edge DB health. Must not perform I/O (BufferedRepo.status().up). */
  dbUp(): boolean;
};

/** Operator pump request, already validated and clamped by the API. */
export type ManualRequest = { cmd: 'on'; duration_s: number; id?: string } | { cmd: 'off'; id?: string };

/**
 * Refusal code. Known codes: invalid_duration (400), every other refusal is 409 with error = code
 * (manual_pending, run_active, pump_on, daily_cap_reached, plus db_unavailable and superseded
 * emitted by the controller today). Typed as string so controller additions do not break the port.
 */
export type ManualResult =
  | { ok: true; command: Command; duplicate: boolean }
  | { ok: false; code: string; message: string };

/** Controller surface used by the API (Controller satisfies it structurally). */
export interface ApiController {
  /** Returns once the command is created/queued; delivery continues asynchronously. */
  requestManual(req: ManualRequest): Promise<ManualResult>;
  readonly pumpState: PumpState;
  /** ackedAt: epoch ms when the start was acknowledged, null while still queued/sent. */
  readonly activeRun: { readonly ackedAt: number | null } | null;
  /** Operator `on` request waiting for the pump (state unknown or rules pending). */
  readonly pendingManual: Command | null;
  /** Completed runtime today, seconds (running portion not included). */
  readonly dailyRuntimeSeconds: number;
}

/** Process bus subset the API needs (src/bus.ts satisfies it). */
export type ApiBus = Pick<TypedBus, 'on' | 'off' | 'emit'>;

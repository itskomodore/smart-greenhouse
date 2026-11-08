/**
 * Test doubles for the HTTP API: an in-memory repo, a scripted controller and a harness that wires
 * them to createApi(). Excluded from the production build (tsconfig.build.json).
 */
import { randomUUID } from 'node:crypto';
import { createBus, type TypedBus } from '../bus.js';
import { createLogger } from '../log.js';
import {
  SETTINGS_DEFAULTS,
  type Alarm,
  type Command,
  type IrrigationEvent,
  type PumpState,
  type Reading,
  type Settings,
} from '../types.js';
import { createApi, type Api, type ApiOptions } from './app.js';
import type { ApiController, ApiRepo, ManualRequest, ManualResult } from './deps.js';

export const TEST_TOKEN = 'test-token-0123456789abcdef';
export const T0 = Date.parse('2026-11-08T12:00:00.000Z');

export function makeReading(over: Partial<Reading> = {}): Reading {
  return {
    node_id: 'node-a',
    ts: new Date(T0 - 5_000).toISOString(),
    t: 21.5,
    rh: 55,
    light_raw: 800,
    soil_raw: 1500,
    soil_pct: 40,
    light_pct: 19.5,
    ...over,
  };
}

export function makeCommand(over: Partial<Command> = {}): Command {
  return {
    id: randomUUID(),
    ts: new Date(T0).toISOString(),
    type: 'pump_on',
    state: 'pending',
    expires_at: new Date(T0 + 30_000).toISOString(),
    ack_ts: null,
    max_s: 60,
    attempts: 0,
    trigger: 'manual',
    reason: 'operator request',
    last_error: null,
    ...over,
  };
}

export class FakeRepo implements ApiRepo {
  rows: Reading[] = [];
  settings: Settings = { ...SETTINGS_DEFAULTS };
  events: IrrigationEvent[] = [];
  alarms: Alarm[] = [];
  commands = new Map<string, Command>();
  /** When true every call rejects (DB outage). dbUp() reports false. */
  down = false;
  /** When true getSettings never settles (hung DB). */
  hangSettings = false;

  dbUp(): boolean {
    return !this.down;
  }

  private guard(): void {
    if (this.down) throw new Error('connection refused');
  }

  private select(q: { from?: string; to?: string; node_id?: string }): Reading[] {
    return this.rows
      .filter((r) => q.node_id === undefined || r.node_id === q.node_id)
      .filter((r) => q.from === undefined || Date.parse(r.ts) >= Date.parse(q.from))
      .filter((r) => q.to === undefined || Date.parse(r.ts) <= Date.parse(q.to))
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  }

  async latestReading(node_id?: string): Promise<Reading | null> {
    this.guard();
    const rows = this.rows.filter((r) => node_id === undefined || r.node_id === node_id);
    return rows.reduce<Reading | null>((best, r) => (best === null || r.ts > best.ts ? r : best), null);
  }

  /** Newest `limit` rows in range, ascending (mirrors PgRepo). */
  async readings(q: { from?: string; to?: string; limit?: number; node_id?: string }): Promise<Reading[]> {
    this.guard();
    const limit = Math.min(q.limit ?? 1000, 5000);
    return this.select(q).slice(-limit);
  }

  async nodeLastSeen(): Promise<Record<string, string>> {
    this.guard();
    const out: Record<string, string> = {};
    for (const r of this.rows) {
      const prev = out[r.node_id];
      if (prev === undefined || r.ts > prev) out[r.node_id] = r.ts;
    }
    return out;
  }

  async getSettings(): Promise<Settings> {
    if (this.hangSettings) return new Promise<Settings>(() => undefined);
    this.guard();
    return { ...this.settings };
  }

  async putSettings(patch: Partial<Settings>): Promise<Settings> {
    this.guard();
    this.settings = { ...this.settings, ...patch };
    return { ...this.settings };
  }

  async recentEvents(limit: number): Promise<IrrigationEvent[]> {
    this.guard();
    return [...this.events].sort((a, b) => b.ts_start.localeCompare(a.ts_start)).slice(0, limit);
  }

  async getCommand(id: string): Promise<Command | null> {
    this.guard();
    return this.commands.get(id) ?? null;
  }

  async activeAlarms(): Promise<Alarm[]> {
    this.guard();
    return [...this.alarms];
  }
}

export class FakeController implements ApiController {
  pumpState: PumpState = 'unknown';
  activeRun: { ackedAt: number | null } | null = null;
  pendingManual: Command | null = null;
  dailyRuntimeSeconds = 0;
  requests: ManualRequest[] = [];
  /** Scripted response. Default: accept and return a pending command. */
  respond: (req: ManualRequest) => Promise<ManualResult> = async (req) => ({
    ok: true,
    duplicate: false,
    command:
      req.cmd === 'on'
        ? makeCommand({ type: 'pump_on', max_s: req.duration_s, id: req.id ?? randomUUID() })
        : makeCommand({ type: 'pump_off', max_s: null, trigger: 'manual', reason: 'operator off', id: req.id ?? randomUUID() }),
  });

  requestManual(req: ManualRequest): Promise<ManualResult> {
    this.requests.push(req);
    return this.respond(req);
  }
}

export interface Harness {
  api: Api;
  repo: FakeRepo;
  controller: FakeController;
  bus: TypedBus;
  clock: { t: number };
}

export async function buildHarness(
  over: Partial<Pick<ApiOptions, 'apiToken' | 'dashboardDir' | 'heartbeatMs' | 'maxStreamClients' | 'pumpDeadlineMs' | 'pumpSettingsMs' | 'dbReadMs'>> = {},
): Promise<Harness> {
  const repo = new FakeRepo();
  const controller = new FakeController();
  const bus = createBus();
  const clock = { t: T0 };
  const api = await createApi({
    repo,
    controller,
    bus,
    apiToken: over.apiToken ?? TEST_TOKEN,
    dashboardDir: over.dashboardDir ?? '/nonexistent-dashboard-dir',
    log: createLogger('api-test', 'silent'),
    now: () => clock.t,
    startedAt: T0 - 60_000,
    ...(over.heartbeatMs !== undefined ? { heartbeatMs: over.heartbeatMs } : {}),
    ...(over.maxStreamClients !== undefined ? { maxStreamClients: over.maxStreamClients } : {}),
    ...(over.pumpDeadlineMs !== undefined ? { pumpDeadlineMs: over.pumpDeadlineMs } : {}),
    ...(over.pumpSettingsMs !== undefined ? { pumpSettingsMs: over.pumpSettingsMs } : {}),
    ...(over.dbReadMs !== undefined ? { dbReadMs: over.dbReadMs } : {}),
  });
  return { api, repo, controller, bus, clock };
}

export const authHeader = { authorization: `Bearer ${TEST_TOKEN}` } as const;

/**
 * Request validation for the HTTP API (docs/API.md). Pure functions, no I/O.
 */
import { z } from 'zod';
import type { Settings } from '../types.js';

/** Same rule as the sensor/actuator node ids (docs/API.md CoAP section). */
export const NODE_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** Actuator hard limit for max_s (docs/API.md: max_run_s 1..600). */
export const MAX_RUN_LIMIT_S = 600;
export const READINGS_DEFAULT_LIMIT = 1000;
export const READINGS_MAX_LIMIT = 5000;
export const EVENTS_DEFAULT_LIMIT = 10;
export const EVENTS_MAX_LIMIT = 100;
/** Default window for GET /api/readings when from is absent. */
export const READINGS_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Calibration uses only a reading younger than this (docs/API.md). */
export const CALIBRATION_MAX_AGE_MS = 60_000;

export interface Issue {
  path: string;
  message: string;
}

export function zodIssues(err: z.ZodError): Issue[] {
  const out: Issue[] = [];
  for (const i of err.issues) {
    if (i.code === 'unrecognized_keys') {
      // zod reports unknown keys at the object root; name each offending key instead.
      for (const key of i.keys) out.push({ path: key, message: 'unknown field' });
      continue;
    }
    out.push({ path: i.path.join('.') || '(root)', message: i.message });
  }
  return out;
}

// ───── PUT /api/settings ─────

/** Partial Settings. Unknown keys are rejected so typos do not pass silently. */
export const SettingsPatchSchema = z
  .object({
    low_threshold: z.number().min(0).max(100),
    high_threshold: z.number().min(0).max(100),
    max_run_s: z.number().int().min(1).max(MAX_RUN_LIMIT_S),
    daily_max_s: z.number().int().min(0),
    min_interval_s: z.number().int().min(0),
    command_expiry_s: z.number().int().min(5).max(300),
    command_max_retries: z.number().int().min(1).max(5),
    stale_timeout_s: z.number().int().min(60).max(86400),
    max_soil_jump_pct: z.number().min(0).max(100),
    auto_enabled: z.boolean(),
    soil_dry_raw: z.number().int().min(0).max(4095),
    soil_wet_raw: z.number().int().min(0).max(4095),
    retention_days: z.number().int().min(0).max(3650), // 0 = retention disabled (db/retention.ts)
  })
  .partial()
  .strict();

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/** Rules that span fields. Checked on the MERGED settings (current + patch). */
export function settingsInvariantIssues(s: Settings): Issue[] {
  const issues: Issue[] = [];
  if (!(s.low_threshold < s.high_threshold)) {
    issues.push({ path: 'low_threshold', message: 'low_threshold must be < high_threshold' });
  }
  if (s.daily_max_s < s.max_run_s) {
    issues.push({ path: 'daily_max_s', message: 'daily_max_s must be >= max_run_s' });
  }
  if (s.soil_dry_raw === s.soil_wet_raw) {
    issues.push({ path: 'soil_dry_raw', message: 'soil_dry_raw must differ from soil_wet_raw' });
  }
  return issues;
}

// ───── POST /api/pump ─────

const Uuid = z.string().uuid();

export const PumpBodySchema = z.discriminatedUnion('cmd', [
  z.object({ cmd: z.literal('on'), duration_s: z.number().finite(), id: Uuid.optional() }).strict(),
  z.object({ cmd: z.literal('off'), id: Uuid.optional() }).strict(),
]);

/** Distinct node ids remembered for last-seen (unauthenticated input; bounded). */
export const MAX_TRACKED_NODES = 256;

export type PumpBody = z.infer<typeof PumpBodySchema>;

/** Integer duration clamped to 1..maxRunS (docs/API.md: the API clamps before the controller). */
export function clampDurationS(requested: number, maxRunS: number): number {
  return Math.min(maxRunS, Math.max(1, Math.round(requested)));
}

// ───── query strings ─────

const ISO_LIKE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const IsoParam = z
  .string()
  .max(40)
  .regex(ISO_LIKE_RE, 'must be an ISO-8601 timestamp')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'must be an ISO-8601 timestamp');

export const ReadingsQuerySchema = z.object({
  from: IsoParam.optional(),
  to: IsoParam.optional(),
  limit: z.coerce.number().int().min(1).max(READINGS_MAX_LIMIT).optional(),
  node_id: z.string().regex(NODE_ID_RE, 'invalid node_id').optional(),
});

/** ?wait_ms on POST /api/pump: integer 0..5000 (string form validated by regex, then range). */
export const PumpQuerySchema = z.object({
  wait_ms: z
    .string()
    .regex(/^(0|[1-9]\d{0,3})$/, 'must be an integer 0..5000')
    .refine((v) => Number(v) <= 5000, 'must be an integer 0..5000')
    .optional(),
});

export const EventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(EVENTS_MAX_LIMIT).optional(),
});

export const CalibrateParamSchema = z.enum(['dry', 'wet']);

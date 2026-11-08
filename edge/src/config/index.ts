import { z } from 'zod';
import { EnvSchema, type Env } from './schema.js';
import { SETTINGS_DEFAULTS, type Settings } from '../types.js';

export type { Env };

/**
 * DB timeouts. Kept here (not in schema.ts, which is supervisor-owned) so a hung DB
 * rejects fast instead of stalling the rules loop or the pump OFF path.
 */
const DbTimeoutSchema = z.object({
  DB_QUERY_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).default(3000),
});

export type DbTimeouts = z.infer<typeof DbTimeoutSchema>;

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}

/**
 * Parse and validate process env using EnvSchema plus DB timeouts. Throws ConfigError listing every bad key.
 * `source` defaults to process.env; pass an object in tests.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Env & DbTimeouts {
  const r = EnvSchema.safeParse(source);
  const t = DbTimeoutSchema.safeParse(source);
  if (!r.success || !t.success) {
    throw new ConfigError([...(r.success ? [] : issuesOf(r.error)), ...(t.success ? [] : issuesOf(t.error))]);
  }
  return { ...r.data, ...t.data };
}

/**
 * DB-only subset for CLIs (e.g. migrator) that must not require API_TOKEN etc.
 */
export function loadDbConfig(
  source: NodeJS.ProcessEnv = process.env,
): Pick<Env, 'DATABASE_URL' | 'DB_POOL_MAX' | 'LOG_LEVEL'> & DbTimeouts {
  const DbOnly = EnvSchema.innerType().pick({ DATABASE_URL: true, DB_POOL_MAX: true, LOG_LEVEL: true });
  const r = DbOnly.safeParse(source);
  const t = DbTimeoutSchema.safeParse(source);
  if (!r.success || !t.success) {
    throw new ConfigError([...(r.success ? [] : issuesOf(r.error)), ...(t.success ? [] : issuesOf(t.error))]);
  }
  return { ...r.data, ...t.data };
}

/**
 * Boot defaults for runtime settings: SETTINGS_DEFAULTS overridden by the env values
 * that exist as boot-time knobs (calibration + retention). DB `settings` override these.
 */
export function bootSettingsDefaults(env: Pick<Env, 'SOIL_DRY_RAW' | 'SOIL_WET_RAW' | 'RETENTION_DAYS'>): Settings {
  return {
    ...SETTINGS_DEFAULTS,
    soil_dry_raw: env.SOIL_DRY_RAW,
    soil_wet_raw: env.SOIL_WET_RAW,
    retention_days: env.RETENTION_DAYS,
  };
}

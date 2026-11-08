import { z } from 'zod';

/**
 * Static process config (env / .env). Runtime-tunable values live in DB `settings`
 * (see types.ts SETTINGS_DEFAULTS); this file only supplies BOOT defaults + wiring.
 * Supervisor-owned contract. Loader (loadConfig, src/config/index.ts) is owned by db-agent.
 */
const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  // HTTP / dashboard. Default loopback; install script sets LAN iface IP. Never 0.0.0.0 by default.
  HTTP_HOST: z.string().default('127.0.0.1'),
  HTTP_PORT: z.coerce.number().int().default(8080),
  API_TOKEN: z.string().min(16, 'API_TOKEN must be >=16 chars'), // required, no default
  DASHBOARD_DIR: z.string().default('../dashboard/dist'),

  // CoAP server (sensor ingest)
  COAP_HOST: z.string().default('::'),
  COAP_PORT: z.coerce.number().int().default(5683),
  // OpenThread border router interface; its addresses are shown on the dashboard as the sensor target.
  THREAD_IFACE: z.string().default('wpan0'),

  // Actuator
  ACTUATOR_HOST: z.string().default('127.0.0.1'),
  ACTUATOR_PORT: z.coerce.number().int().default(5684),
  ACTUATOR_TIMEOUT_MS: z.coerce.number().int().default(3000),

  // Postgres
  DATABASE_URL: z.string().default('postgres://greenhouse@localhost:5432/greenhouse'),
  DB_POOL_MAX: z.coerce.number().int().default(4),
  DB_BUFFER_MAX: z.coerce.number().int().default(5000), // in-memory readings while DB down

  // Normalization boot defaults (DB settings override after calibration)
  SOIL_DRY_RAW: z.coerce.number().int().min(0).max(4095).default(3000),
  SOIL_WET_RAW: z.coerce.number().int().min(0).max(4095).default(1200),

  // Loop
  RULES_TICK_MS: z.coerce.number().int().default(1000),
  RETENTION_DAYS: z.coerce.number().int().default(90),
  CLOUD_ENABLED: bool.default('false'),
}).refine((e) => e.SOIL_DRY_RAW !== e.SOIL_WET_RAW, { message: 'SOIL_DRY_RAW must differ from SOIL_WET_RAW' });

export type Env = z.infer<typeof EnvSchema>;

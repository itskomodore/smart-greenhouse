import type { Settings } from '../types.js';

/** Test-only fixture mirroring SETTINGS_DEFAULTS in edge/src/types.ts. */
export const SETTINGS: Settings = {
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

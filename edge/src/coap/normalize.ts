import type { Reading, SensorPayload, Settings } from '../types.js';

export type NormalizeSettings = Pick<Settings, 'soil_dry_raw' | 'soil_wet_raw'>;

export interface NormalizeMeta {
  /** CoAP source address, used as node_id when the payload carries no `id`. */
  source: string;
  /** Server receipt time. Defaults to now. */
  now?: Date;
}

/** ADC full scale for light (12-bit). */
export const ADC_MAX = 4095;

export function clamp(x: number, lo: number, hi: number): number {
  // Math.max(lo, -0) yields +0, so the result never carries a negative zero.
  return Math.min(hi, Math.max(lo, x));
}

/** Thrown when calibration is degenerate (dry == wet). DB settings validation prevents this. */
export class CalibrationError extends RangeError {
  constructor() {
    super('soil_dry_raw must differ from soil_wet_raw');
    this.name = 'CalibrationError';
  }
}

/**
 * Convert a validated sensor payload into the Reading fields stored and published.
 *   node_id = payload.id ?? source address
 *   ts      = server receipt time (ISO-8601 UTC)
 *   soil_pct = clamp((dry - soil) / (dry - wet) * 100, 0, 100)
 *   light_pct = clamp(light / 4095 * 100, 0, 100)
 * Throws CalibrationError if dry == wet (the mapping is undefined); callers must catch.
 */
export function normalize(
  payload: SensorPayload,
  settings: NormalizeSettings,
  meta: NormalizeMeta,
): Omit<Reading, 'id'> {
  const { soil_dry_raw: dry, soil_wet_raw: wet } = settings;
  if (dry === wet) throw new CalibrationError();

  const soil_pct = clamp(((dry - payload.soil) / (dry - wet)) * 100, 0, 100);
  const light_pct = clamp((payload.light / ADC_MAX) * 100, 0, 100);

  return {
    node_id: payload.id ?? meta.source,
    ts: (meta.now ?? new Date()).toISOString(),
    t: payload.t,
    rh: payload.rh,
    light_raw: payload.light,
    soil_raw: payload.soil,
    soil_pct,
    light_pct,
  };
}

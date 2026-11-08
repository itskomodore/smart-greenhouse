import type { ReadingAssessment, Settings } from '../types.js';

/**
 * Pure reading plausibility check. `prev` is the last ACCEPTED reading (or null at boot).
 * Rejects out-of-range soil values and jumps larger than settings.max_soil_jump_pct.
 * A jump exactly equal to the limit is accepted.
 */
export function assessReading(
  prev: { soil_pct: number; ts: number } | null,
  next: { soil_pct: number; ts: number },
  settings: Settings,
): ReadingAssessment {
  if (!Number.isFinite(next.soil_pct) || next.soil_pct < 0 || next.soil_pct > 100) {
    return { accept: false, reason: `soil_pct ${String(next.soil_pct)} outside 0..100` };
  }
  if (prev === null) {
    return { accept: true };
  }
  const jump = Math.abs(next.soil_pct - prev.soil_pct);
  if (jump > settings.max_soil_jump_pct) {
    return {
      accept: false,
      reason: `implausible soil jump ${jump.toFixed(2)}pp exceeds ${settings.max_soil_jump_pct}pp`,
    };
  }
  return { accept: true };
}

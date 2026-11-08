import type { SensorPayload, ValidationResult } from '../types.js';

/** Hard cap on the raw request body (docs/API.md: payload ≤ 256 B). */
export const MAX_PAYLOAD_BYTES = 256;
/** Optional node id pattern (docs/API.md). */
export const NODE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

export const T_RANGE = { min: -40, max: 85 } as const;
export const RH_RANGE = { min: 0, max: 100 } as const;
export const ADC_RANGE = { min: 0, max: 4095 } as const;

const utf8 = new TextDecoder('utf-8', { fatal: true });

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

/**
 * Validate a raw CoAP request body (bytes or text) against the sensor payload contract.
 * Never throws: every failure is reported as `{ ok: false, error }` with a short reason
 * that is safe to echo back to the sensor (no input reflection).
 */
export function validatePayload(input: Uint8Array | string): ValidationResult {
  const size = typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input.byteLength;
  if (size === 0) return fail('empty payload');
  if (size > MAX_PAYLOAD_BYTES) return fail(`payload too large (max ${MAX_PAYLOAD_BYTES} B)`);

  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else {
    try {
      text = utf8.decode(input);
    } catch {
      return fail('payload is not valid UTF-8');
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail('malformed JSON');
  }
  return validateObject(parsed);
}

/** Validate an already-parsed JSON value. Unknown keys are ignored. */
export function validateObject(obj: unknown): ValidationResult {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return fail('payload must be a JSON object');
  }
  const o = obj as Record<string, unknown>;

  const t = checkNumber(o['t'], 't', T_RANGE.min, T_RANGE.max);
  if (typeof t !== 'number') return fail(t.error);

  const rh = checkNumber(o['rh'], 'rh', RH_RANGE.min, RH_RANGE.max);
  if (typeof rh !== 'number') return fail(rh.error);

  const light = checkInt(o['light'], 'light', ADC_RANGE.min, ADC_RANGE.max);
  if (typeof light !== 'number') return fail(light.error);

  const soil = checkInt(o['soil'], 'soil', ADC_RANGE.min, ADC_RANGE.max);
  if (typeof soil !== 'number') return fail(soil.error);

  const value: SensorPayload = { t, rh, light, soil };

  if (o['id'] !== undefined) {
    const id = o['id'];
    if (typeof id !== 'string' || !NODE_ID_PATTERN.test(id)) {
      return fail('id must match ^[A-Za-z0-9_.:-]{1,64}$');
    }
    value.id = id;
  }

  return { ok: true, value };
}

type Check = number | { error: string };

function checkNumber(v: unknown, name: string, min: number, max: number): Check {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return { error: `${name} must be a number` };
  }
  if (v < min || v > max) {
    return { error: `${name} out of range ${min}..${max}` };
  }
  return v;
}

function checkInt(v: unknown, name: string, min: number, max: number): Check {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    return { error: `${name} must be an integer` };
  }
  if (v < min || v > max) {
    return { error: `${name} out of range ${min}..${max}` };
  }
  return v;
}

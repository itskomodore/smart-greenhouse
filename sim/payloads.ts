/**
 * Pure payload generators for the sensor simulator.
 * Contract: docs/API.md "CoAP (sensor ingest)" and SensorPayload in edge/src/types.ts.
 */
import { SETTINGS_DEFAULTS, type SensorPayload } from '../edge/src/types.js';

export type SimMode = 'normal' | 'drying' | 'stuck' | 'garbage';
export const SIM_MODES: readonly SimMode[] = ['normal', 'drying', 'stuck', 'garbage'];

export const CONTENT_JSON = 'application/json';
export const CONTENT_TEXT = 'text/plain';

/** Expected server answer: accepted (2.01/2.04), 4.00 bad payload, 4.15 bad content format. */
export type ExpectedOutcome = 'accept' | '4.00' | '4.15';

export interface Outgoing {
  mode: SimMode;
  /** 'valid' for good payloads, otherwise the garbage case name. */
  kind: string;
  expect: ExpectedOutcome;
  body: string;
  contentFormat: string;
}

export type Rng = () => number;

/** Seeded PRNG (mulberry32) so garbage/normal runs are reproducible. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimState {
  tick: number;
  /** Current soil raw value (drying mode). */
  soilRaw: number;
  /** Number of simulated irrigation resets so far (drying mode). */
  resets: number;
}

export function createState(): SimState {
  return { tick: 0, soilRaw: SETTINGS_DEFAULTS.soil_wet_raw, resets: 0 };
}

/** Samples per simulated day when shaping the light curve (5 min cadence). */
const TICKS_PER_DAY = 288;
/** Stuck mode always reports exactly these values. */
const STUCK_VALUES = { t: 22.5, rh: 55.2, light: 812, soil: 1530 } as const;

const round = (n: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const between = (rng: Rng, lo: number, hi: number): number => lo + rng() * (hi - lo);

function withId<T extends object>(body: T, id: string | undefined): T & { id?: string } {
  return id === undefined ? body : { id, ...body };
}

/** Physically plausible reading for normal mode. */
function normalValues(tick: number, rng: Rng, soilRaw: number): Omit<SensorPayload, 'id'> {
  const t = 22 + 2 * Math.sin(tick / 40) + between(rng, -0.2, 0.2);
  const rh = 55 + 8 * Math.sin(tick / 57) + between(rng, -1, 1);
  const light = 2000 + 1900 * Math.sin((tick * 2 * Math.PI) / TICKS_PER_DAY);
  return {
    t: round(clamp(t, -40, 85), 2),
    rh: round(clamp(rh, 0, 100), 2),
    light: Math.round(clamp(light, 0, 4095)),
    soil: Math.round(clamp(soilRaw, 0, 4095)),
  };
}

/** Valid payload for the given mode (not used for garbage). */
export function validPayload(
  mode: Exclude<SimMode, 'garbage'>,
  state: SimState,
  rng: Rng,
  id?: string,
): SensorPayload {
  const { wet, dry } = { wet: SETTINGS_DEFAULTS.soil_wet_raw, dry: SETTINGS_DEFAULTS.soil_dry_raw };
  if (mode === 'stuck') {
    return withId({ ...STUCK_VALUES }, id);
  }
  if (mode === 'drying') {
    // Soil dries ~40 raw per tick with jitter. Once it is close to dry, the
    // simulated irrigation resets it to wet (the sim cannot observe the pump).
    state.soilRaw += 40 + between(rng, -6, 6);
    const irrigateAt = dry - 0.1 * (dry - wet);
    if (state.soilRaw >= irrigateAt) {
      state.soilRaw = wet + between(rng, 0, 30);
      state.resets += 1;
    }
  } else {
    state.soilRaw = 1900 + 60 * Math.sin(state.tick / 90) + between(rng, -15, 15);
  }
  const values = normalValues(state.tick, rng, state.soilRaw);
  return withId({ ...values }, id);
}

interface GarbageCase {
  name: string;
  expect: Exclude<ExpectedOutcome, 'accept'>;
  build: (rng: Rng, id: string | undefined) => { body: string; contentFormat: string };
}

const JSON_BODY = (obj: unknown): string => JSON.stringify(obj);
const base = (id: string | undefined): Record<string, unknown> =>
  withId<Record<string, unknown>>({ t: 22.5, rh: 55.2, light: 812, soil: 1530 }, id);
const jsonCase = (obj: unknown): { body: string; contentFormat: string } => ({
  body: JSON_BODY(obj),
  contentFormat: CONTENT_JSON,
});
const rangeInt = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));

/** Every case here must be rejected by the server (4.00 or 4.15). */
export const GARBAGE_CASES: readonly GarbageCase[] = [
  { name: 'not_json', expect: '4.00', build: () => ({ body: 'this is not json', contentFormat: CONTENT_JSON }) },
  { name: 'nan_literal', expect: '4.00', build: () => ({ body: '{"t":NaN,"rh":55,"light":812,"soil":1530}', contentFormat: CONTENT_JSON }) },
  {
    name: 'truncated_json',
    expect: '4.00',
    build: (rng, id) => {
      const full = JSON_BODY(base(id));
      const cut = rangeInt(rng, 3, full.length - 2);
      return { body: full.slice(0, cut), contentFormat: CONTENT_JSON };
    },
  },
  { name: 'empty_body', expect: '4.00', build: () => ({ body: '', contentFormat: CONTENT_JSON }) },
  { name: 'array_root', expect: '4.00', build: () => ({ body: '[22.5,55,812,1530]', contentFormat: CONTENT_JSON }) },
  { name: 'null_root', expect: '4.00', build: () => ({ body: 'null', contentFormat: CONTENT_JSON }) },
  { name: 't_above_range', expect: '4.00', build: (rng, id) => jsonCase({ ...base(id), t: 85.5 + rangeInt(rng, 0, 400) }) },
  { name: 't_below_range', expect: '4.00', build: (rng, id) => jsonCase({ ...base(id), t: -40.5 - rangeInt(rng, 0, 300) }) },
  { name: 't_as_string', expect: '4.00', build: (rng, id) => jsonCase({ ...base(id), t: '22.5' }) },
  { name: 'rh_above_range', expect: '4.00', build: (rng, id) => jsonCase({ ...base(id), rh: 100.5 + rangeInt(rng, 0, 50) }) },
  { name: 'rh_below_range', expect: '4.00', build: (rng, id) => jsonCase({ ...base(id), rh: -0.5 - rangeInt(rng, 0, 20) }) },
  { name: 'light_above_range', expect: '4.00', build: (rng, id) => jsonCase({ ...base(id), light: 4096 + rangeInt(rng, 0, 1000) }) },
  { name: 'light_negative', expect: '4.00', build: (rng, id) => jsonCase({ ...base(id), light: -1 - rangeInt(rng, 0, 100) }) },
  { name: 'soil_above_range', expect: '4.00', build: (rng, id) => jsonCase({ ...base(id), soil: 4096 + rangeInt(rng, 0, 1000) }) },
  { name: 'soil_negative', expect: '4.00', build: (rng, id) => jsonCase({ ...base(id), soil: -1 - rangeInt(rng, 0, 100) }) },
  { name: 'soil_non_integer', expect: '4.00', build: (_rng, id) => jsonCase({ ...base(id), soil: 1530.5 }) },
  { name: 'soil_null', expect: '4.00', build: (_rng, id) => jsonCase({ ...base(id), soil: null }) },
  {
    name: 'missing_t',
    expect: '4.00',
    build: (_rng, id) => {
      const obj = base(id);
      delete obj.t;
      return jsonCase(obj);
    },
  },
  { name: 'id_bad_chars', expect: '4.00', build: (_rng, id) => jsonCase({ ...base(id), id: 'bad id!/../x' }) },
  { name: 'id_too_long', expect: '4.00', build: (_rng, id) => jsonCase({ ...base(id), id: 'a'.repeat(65) }) },
  { name: 'id_not_string', expect: '4.00', build: (_rng, id) => jsonCase({ ...base(id), id: 42 }) },
  // Payload limit is 256 B; unknown keys are otherwise ignored.
  { name: 'oversized_payload', expect: '4.00', build: (_rng, id) => jsonCase({ ...base(id), pad: 'x'.repeat(300) }) },
  { name: 'wrong_content_format', expect: '4.15', build: (_rng, id) => ({ body: JSON_BODY(base(id)), contentFormat: CONTENT_TEXT }) },
];

/** Builds the next message for the given mode. Advances state.tick. */
export function nextOutgoing(mode: SimMode, state: SimState, rng: Rng, id?: string): Outgoing {
  state.tick += 1;
  if (mode === 'garbage') {
    const c = GARBAGE_CASES[Math.floor(rng() * GARBAGE_CASES.length)];
    if (c === undefined) throw new Error('GARBAGE_CASES is empty');
    const built = c.build(rng, id);
    return { mode, kind: c.name, expect: c.expect, body: built.body, contentFormat: built.contentFormat };
  }
  const payload = validPayload(mode, state, rng, id);
  return { mode, kind: 'valid', expect: 'accept', body: JSON.stringify(payload), contentFormat: CONTENT_JSON };
}

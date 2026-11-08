import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Api } from './app.js';
import { cacheControlFor } from './app.js';
import type { ManualResult } from './deps.js';
import { SETTINGS_DEFAULTS, type Alarm, type Settings } from '../types.js';
import {
  T0,
  TEST_TOKEN,
  authHeader,
  buildHarness,
  makeCommand,
  makeReading,
  type Harness,
} from './test-support.js';

let fixtureRoot: string;
let dashDir: string;
const harnesses: Harness[] = [];

beforeAll(() => {
  // fixtureRoot/secret.txt sits OUTSIDE the dashboard dir; a traversal must never serve it.
  fixtureRoot = mkdtempSync(join(tmpdir(), 'edge-api-root-'));
  writeFileSync(join(fixtureRoot, 'secret.txt'), 'TOP-SECRET-OUTSIDE');
  writeFileSync(join(fixtureRoot, 'secret'), 'TOP-SECRET-OUTSIDE');
  dashDir = join(fixtureRoot, 'dash');
  mkdirSync(dashDir);
  mkdirSync(join(dashDir, 'assets'));
  writeFileSync(join(dashDir, 'index.html'), '<!doctype html><title>dash</title>');
  writeFileSync(join(dashDir, 'assets', 'app.0a1b2c3d.js'), 'console.log(1)');
  writeFileSync(join(dashDir, 'favicon.txt'), 'icon');
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.api.close();
});

async function harness(over: Parameters<typeof buildHarness>[0] = {}): Promise<Harness> {
  const h = await buildHarness(over);
  harnesses.push(h);
  return h;
}

function api(h: Harness): Api {
  return h.api;
}

describe('health and auth', () => {
  it('GET /healthz is open and returns ok', async () => {
    const h = await harness();
    const res = await api(h).app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it.each([
    ['POST', '/api/pump', { cmd: 'off' }],
    ['PUT', '/api/settings', { low_threshold: 25 }],
    ['POST', '/api/calibrate/dry', undefined],
    ['POST', '/api/calibrate/wet', undefined],
  ] as const)('%s %s without a token is 401', async (method, url, payload) => {
    const h = await harness();
    const res = await api(h).app.inject({ method, url, payload });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthorized' });
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('a wrong token is 401 and a malformed Authorization header is 401', async () => {
    const h = await harness();
    const wrong = await api(h).app.inject({
      method: 'POST',
      url: '/api/pump',
      headers: { authorization: 'Bearer nope-nope-nope-nope' },
      payload: { cmd: 'off' },
    });
    expect(wrong.statusCode).toBe(401);
    const basic = await api(h).app.inject({
      method: 'POST',
      url: '/api/pump',
      headers: { authorization: `Basic ${TEST_TOKEN}` },
      payload: { cmd: 'off' },
    });
    expect(basic.statusCode).toBe(401);
    expect(h.controller.requests).toHaveLength(0);
  });

  it('auth runs before body validation (unauthenticated bad body is 401, not 400)', async () => {
    const h = await harness();
    const res = await api(h).app.inject({
      method: 'POST',
      url: '/api/pump',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(401);
  });

  it('write endpoints answer 503 when no API token is configured', async () => {
    const h = await harness({ apiToken: '' });
    const res = await api(h).app.inject({
      method: 'POST',
      url: '/api/pump',
      headers: { authorization: 'Bearer ' + TEST_TOKEN },
      payload: { cmd: 'off' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'auth_not_configured' });
  });

  it('read endpoints need no token', async () => {
    const h = await harness();
    const res = await api(h).app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /api/pump', () => {
  it('202 with the created command and duplicate=false', async () => {
    const h = await harness();
    const res = await api(h).app.inject({
      method: 'POST',
      url: '/api/pump',
      headers: authHeader,
      payload: { cmd: 'on', duration_s: 30 },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.duplicate).toBe(false);
    expect(body.command).toMatchObject({ type: 'pump_on', max_s: 30 });
    expect(h.controller.requests).toEqual([{ cmd: 'on', duration_s: 30 }]);
  });

  it('clamps duration_s to 1..max_run_s before calling the controller', async () => {
    const h = await harness();
    await api(h).app.inject({ method: 'POST', url: '/api/pump', headers: authHeader, payload: { cmd: 'on', duration_s: 9999 } });
    await api(h).app.inject({ method: 'POST', url: '/api/pump', headers: authHeader, payload: { cmd: 'on', duration_s: 0 } });
    await api(h).app.inject({ method: 'POST', url: '/api/pump', headers: authHeader, payload: { cmd: 'on', duration_s: 12.6 } });
    expect(h.controller.requests).toEqual([
      { cmd: 'on', duration_s: SETTINGS_DEFAULTS.max_run_s },
      { cmd: 'on', duration_s: 1 },
      { cmd: 'on', duration_s: 13 },
    ]);
  });

  it('uses the stored max_run_s for the clamp', async () => {
    const h = await harness();
    h.repo.settings.max_run_s = 45;
    h.repo.settings.daily_max_s = 600;
    await api(h).app.inject({ method: 'POST', url: '/api/pump', headers: authHeader, payload: { cmd: 'on', duration_s: 300 } });
    expect(h.controller.requests).toEqual([{ cmd: 'on', duration_s: 45 }]);
  });

  it('off is accepted without duration_s', async () => {
    const h = await harness();
    const res = await api(h).app.inject({ method: 'POST', url: '/api/pump', headers: authHeader, payload: { cmd: 'off' } });
    expect(res.statusCode).toBe(202);
    expect(h.controller.requests).toEqual([{ cmd: 'off' }]);
  });

  it('forwards a uuid idempotency key and reports duplicate=true', async () => {
    const h = await harness();
    const id = randomUUID();
    h.controller.respond = async (req) => ({
      ok: true,
      duplicate: true,
      command: makeCommand({ id: req.id ?? '', type: 'pump_on', max_s: 10 }),
    });
    const res = await api(h).app.inject({
      method: 'POST',
      url: '/api/pump',
      headers: authHeader,
      payload: { cmd: 'on', duration_s: 10, id },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().duplicate).toBe(true);
    expect(h.controller.requests[0]).toEqual({ cmd: 'on', duration_s: 10, id });
  });

  it.each([
    ['missing duration_s', { cmd: 'on' }, 'duration_s'],
    ['non-numeric duration_s', { cmd: 'on', duration_s: 'thirty' }, 'duration_s'],
    ['unknown cmd', { cmd: 'toggle' }, 'cmd'],
    ['non-uuid id', { cmd: 'off', id: 'abc' }, 'id'],
  ])('400 validation: %s', async (_name, payload, field) => {
    const h = await harness();
    const res = await api(h).app.inject({ method: 'POST', url: '/api/pump', headers: authHeader, payload });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('validation_error');
    expect(body.fields).toHaveProperty(field);
    expect(h.controller.requests).toHaveLength(0);
  });

  it('400 when the body is not JSON', async () => {
    const h = await harness();
    const res = await api(h).app.inject({
      method: 'POST',
      url: '/api/pump',
      headers: { ...authHeader, 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error');
  });

  it.each([
    ['pump_on', { error: 'pump_on', message: 'pump is already on' }],
    ['run_active', { error: 'run_active', message: 'an irrigation run is in progress' }],
    ['manual_pending', { error: 'manual_pending', message: 'a manual start is already waiting for the pump' }],
    ['daily_cap_reached', { error: 'daily_cap_reached', message: 'daily irrigation budget used up' }],
  ])('409 refusal %s carries error = code', async (code, expected) => {
    const h = await harness();
    h.controller.respond = async (): Promise<ManualResult> => ({ ok: false, code, message: expected.message });
    const res = await api(h).app.inject({ method: 'POST', url: '/api/pump', headers: authHeader, payload: { cmd: 'on', duration_s: 20 } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(expected);
  });

  it('other controller refusal codes are also 409 with error = code', async () => {
    const h = await harness();
    h.controller.respond = async (): Promise<ManualResult> => ({ ok: false, code: 'db_unavailable', message: 'db down' });
    const res = await api(h).app.inject({ method: 'POST', url: '/api/pump', headers: authHeader, payload: { cmd: 'on', duration_s: 20 } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'db_unavailable', message: 'db down' });
  });

  it('invalid_duration refusal from the controller is 400', async () => {
    const h = await harness();
    h.controller.respond = async (): Promise<ManualResult> => ({ ok: false, code: 'invalid_duration', message: 'bad' });
    const res = await api(h).app.inject({ method: 'POST', url: '/api/pump', headers: authHeader, payload: { cmd: 'on', duration_s: 20 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_duration');
  });

  it('answers within 2 s even when the settings read hangs and the controller is slow', async () => {
    const h = await harness();
    h.repo.hangSettings = true;
    h.controller.respond = () => new Promise<ManualResult>(() => undefined);
    const started = Date.now();
    const res = await api(h).app.inject({ method: 'POST', url: '/api/pump', headers: authHeader, payload: { cmd: 'on', duration_s: 20 } });
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'controller_busy' });
    expect(elapsed).toBeLessThan(2000);
  });

  it('202 even when the stored settings are hung (last-known or default max_run_s is used)', async () => {
    const h = await harness();
    h.repo.hangSettings = true;
    const started = Date.now();
    const res = await api(h).app.inject({ method: 'POST', url: '/api/pump', headers: authHeader, payload: { cmd: 'on', duration_s: 500 } });
    expect(res.statusCode).toBe(202);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(h.controller.requests[0]).toEqual({ cmd: 'on', duration_s: SETTINGS_DEFAULTS.max_run_s });
  });

  it('503 when the controller throws (for example not started)', async () => {
    const h = await harness();
    h.controller.respond = async () => {
      throw new Error('controller not started');
    };
    const res = await api(h).app.inject({ method: 'POST', url: '/api/pump', headers: authHeader, payload: { cmd: 'off' } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'controller_unavailable' });
  });
});

describe('settings', () => {
  it('GET returns the full Settings object', async () => {
    const h = await harness();
    const res = await api(h).app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(SETTINGS_DEFAULTS);
  });

  it('PUT then GET round-trips a partial patch and publishes the settings topic', async () => {
    const h = await harness();
    const seen: Settings[] = [];
    h.bus.on('settings', (s) => seen.push(s));

    const put = await api(h).app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: authHeader,
      payload: { low_threshold: 25, high_threshold: 70, auto_enabled: false },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ low_threshold: 25, high_threshold: 70, auto_enabled: false, max_run_s: 60 });

    const get = await api(h).app.inject({ method: 'GET', url: '/api/settings' });
    expect(get.json()).toEqual(put.json());
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(put.json());
  });

  it('an empty patch is a valid no-op', async () => {
    const h = await harness();
    const res = await api(h).app.inject({ method: 'PUT', url: '/api/settings', headers: authHeader, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(SETTINGS_DEFAULTS);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['low >= high (patch against stored high)', { low_threshold: 60 }, 'low_threshold'],
    ['low_threshold above 100', { low_threshold: 101 }, 'low_threshold'],
    ['max_run_s 0', { max_run_s: 0 }, 'max_run_s'],
    ['max_run_s 601', { max_run_s: 601 }, 'max_run_s'],
    ['max_run_s fractional', { max_run_s: 30.5 }, 'max_run_s'],
    ['daily_max_s below max_run_s', { daily_max_s: 30, max_run_s: 60 }, 'daily_max_s'],
    ['min_interval_s negative', { min_interval_s: -1 }, 'min_interval_s'],
    ['command_expiry_s 4', { command_expiry_s: 4 }, 'command_expiry_s'],
    ['command_expiry_s 301', { command_expiry_s: 301 }, 'command_expiry_s'],
    ['command_max_retries 0', { command_max_retries: 0 }, 'command_max_retries'],
    ['command_max_retries 6', { command_max_retries: 6 }, 'command_max_retries'],
    ['stale_timeout_s 59', { stale_timeout_s: 59 }, 'stale_timeout_s'],
    ['stale_timeout_s 86401', { stale_timeout_s: 86401 }, 'stale_timeout_s'],
    ['soil_dry_raw 4096', { soil_dry_raw: 4096 }, 'soil_dry_raw'],
    ['soil_wet_raw -1', { soil_wet_raw: -1 }, 'soil_wet_raw'],
    ['soil_dry_raw equal to soil_wet_raw', { soil_dry_raw: 1200 }, 'soil_dry_raw'],
    ['auto_enabled as string', { auto_enabled: 'yes' }, 'auto_enabled'],
    ['unknown key', { low_threshold_typo: 10 }, 'low_threshold_typo'],
  ])('400 validation: %s', async (_name, payload, field) => {
    const h = await harness();
    const res = await api(h).app.inject({ method: 'PUT', url: '/api/settings', headers: authHeader, payload });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('validation_error');
    expect(body.message).toEqual(expect.any(String));
    expect(body.fields).toHaveProperty(field);
    expect(h.repo.settings).toEqual(SETTINGS_DEFAULTS);
  });

  it('low >= high is judged against the merged values, not only the patch', async () => {
    const h = await harness();
    const res = await api(h).app.inject({ method: 'PUT', url: '/api/settings', headers: authHeader, payload: { low_threshold: 70 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toHaveProperty('low_threshold');
  });

  it('accepts the documented boundary values', async () => {
    const h = await harness();
    const res = await api(h).app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: authHeader,
      payload: {
        low_threshold: 0,
        high_threshold: 100,
        max_run_s: 600,
        daily_max_s: 600,
        min_interval_s: 0,
        command_expiry_s: 5,
        command_max_retries: 1,
        stale_timeout_s: 60,
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('a non-object body is 400', async () => {
    const h = await harness();
    const res = await api(h).app.inject({ method: 'PUT', url: '/api/settings', headers: { ...authHeader, 'content-type': 'application/json' }, payload: '[1,2]' });
    expect(res.statusCode).toBe(400);
  });

  it('PUT answers 503 when the DB is down and writes nothing', async () => {
    const h = await harness();
    h.repo.down = true;
    const res = await api(h).app.inject({ method: 'PUT', url: '/api/settings', headers: authHeader, payload: { max_run_s: 30 } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('db_unavailable');
  });
});

describe('POST /api/calibrate/{dry|wet}', () => {
  it('captures the latest raw soil reading into soil_dry_raw', async () => {
    const h = await harness();
    h.repo.rows.push(makeReading({ soil_raw: 2900, ts: new Date(T0 - 2_000).toISOString() }));
    const res = await api(h).app.inject({ method: 'POST', url: '/api/calibrate/dry', headers: authHeader });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ soil_dry_raw: 2900, soil_wet_raw: SETTINGS_DEFAULTS.soil_wet_raw, captured_raw: 2900 });
    expect(h.repo.settings.soil_dry_raw).toBe(2900);
  });

  it('captures into soil_wet_raw and publishes settings', async () => {
    const h = await harness();
    h.repo.rows.push(makeReading({ soil_raw: 1100 }));
    const seen: Settings[] = [];
    h.bus.on('settings', (s) => seen.push(s));
    const res = await api(h).app.inject({ method: 'POST', url: '/api/calibrate/wet', headers: authHeader });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ soil_dry_raw: SETTINGS_DEFAULTS.soil_dry_raw, soil_wet_raw: 1100, captured_raw: 1100 });
    expect(seen.at(-1)?.soil_wet_raw).toBe(1100);
  });

  it('409 no_recent_reading when the latest reading is 60 s or older', async () => {
    const h = await harness();
    h.repo.rows.push(makeReading({ ts: new Date(T0 - 60_000).toISOString() }));
    const res = await api(h).app.inject({ method: 'POST', url: '/api/calibrate/dry', headers: authHeader });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_recent_reading');
    expect(h.repo.settings.soil_dry_raw).toBe(SETTINGS_DEFAULTS.soil_dry_raw);
  });

  it('409 no_recent_reading when no reading exists at all', async () => {
    const h = await harness();
    const res = await api(h).app.inject({ method: 'POST', url: '/api/calibrate/wet', headers: authHeader });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_recent_reading');
  });

  it('409 dry_equals_wet when the capture would make the two equal', async () => {
    const h = await harness();
    h.repo.rows.push(makeReading({ soil_raw: SETTINGS_DEFAULTS.soil_wet_raw }));
    const res = await api(h).app.inject({ method: 'POST', url: '/api/calibrate/dry', headers: authHeader });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('dry_equals_wet');
    expect(h.repo.settings.soil_dry_raw).toBe(SETTINGS_DEFAULTS.soil_dry_raw);
  });

  it('400 for an unknown target', async () => {
    const h = await harness();
    const res = await api(h).app.inject({ method: 'POST', url: '/api/calibrate/humid', headers: authHeader });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toHaveProperty('which');
  });

  it('requires the token', async () => {
    const h = await harness();
    const res = await api(h).app.inject({ method: 'POST', url: '/api/calibrate/dry' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/latest', () => {
  it('returns the newest reading, its age and the last-seen map', async () => {
    const h = await harness();
    h.repo.rows.push(makeReading({ node_id: 'node-a', ts: new Date(T0 - 10_000).toISOString() }));
    h.repo.rows.push(makeReading({ node_id: 'node-b', ts: new Date(T0 - 3_000).toISOString(), soil_pct: 77 }));
    const res = await api(h).app.inject({ method: 'GET', url: '/api/latest' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reading).toMatchObject({ node_id: 'node-b', soil_pct: 77 });
    expect(body.age_s).toBe(3);
    expect(Object.keys(body.nodes).sort()).toEqual(['node-a', 'node-b']);
  });

  it('reading null and age_s null when nothing has been received', async () => {
    const h = await harness();
    const res = await api(h).app.inject({ method: 'GET', url: '/api/latest' });
    expect(res.json()).toEqual({ reading: null, age_s: null, nodes: {} });
  });

  it('falls back to readings seen on the bus while the DB is down', async () => {
    const h = await harness();
    h.repo.down = true;
    const r = makeReading({ node_id: 'bus-node', ts: new Date(T0 - 1_000).toISOString() });
    h.bus.emit('reading', r);
    const res = await api(h).app.inject({ method: 'GET', url: '/api/latest' });
    expect(res.statusCode).toBe(200);
    expect(res.json().reading).toMatchObject({ node_id: 'bus-node' });
    expect(res.json().nodes).toHaveProperty('bus-node');
  });
});

describe('GET /api/readings', () => {
  function seed(h: Harness, count: number, stepMs: number, node = 'node-a'): void {
    for (let i = 0; i < count; i++) {
      h.repo.rows.push(
        makeReading({
          node_id: node,
          ts: new Date(T0 - (count - i) * stepMs).toISOString(),
          soil_pct: (i % 100) + 0.5,
          soil_raw: 1200 + (i % 50),
        }),
      );
    }
  }

  it('defaults to the last 24 h, ascending', async () => {
    const h = await harness();
    h.repo.rows.push(makeReading({ ts: new Date(T0 - 2 * 86_400_000).toISOString() }));
    h.repo.rows.push(makeReading({ ts: new Date(T0 - 60_000).toISOString() }));
    h.repo.rows.push(makeReading({ ts: new Date(T0 - 120_000).toISOString() }));
    const res = await api(h).app.inject({ method: 'GET', url: '/api/readings' });
    const rows = res.json().readings as { ts: string }[];
    expect(rows).toHaveLength(2);
    expect(Date.parse(rows[0]!.ts)).toBeLessThan(Date.parse(rows[1]!.ts));
  });

  it('downsamples a long range to at most limit points', async () => {
    const h = await harness();
    seed(h, 3000, 60_000); // 50 h of minute readings
    const res = await api(h).app.inject({
      method: 'GET',
      url: `/api/readings?from=${encodeURIComponent(new Date(T0 - 3000 * 60_000).toISOString())}&to=${encodeURIComponent(new Date(T0).toISOString())}`,
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().readings as { ts: string; soil_pct: number }[];
    expect(rows.length).toBeLessThanOrEqual(1000);
    expect(rows.length).toBeGreaterThan(900);
    for (let i = 1; i < rows.length; i++) {
      expect(Date.parse(rows[i]!.ts)).toBeGreaterThanOrEqual(Date.parse(rows[i - 1]!.ts));
    }
  });

  it('honours a smaller limit', async () => {
    const h = await harness();
    seed(h, 500, 60_000);
    const res = await api(h).app.inject({ method: 'GET', url: '/api/readings?limit=50' });
    expect(res.json().readings.length).toBeLessThanOrEqual(50);
  });

  it('keeps rows as-is when they already fit', async () => {
    const h = await harness();
    seed(h, 20, 60_000);
    const res = await api(h).app.inject({ method: 'GET', url: '/api/readings?limit=100' });
    expect(res.json().readings).toHaveLength(20);
  });

  it('filters by node_id', async () => {
    const h = await harness();
    seed(h, 10, 60_000, 'node-a');
    seed(h, 10, 60_000, 'node-b');
    const res = await api(h).app.inject({ method: 'GET', url: '/api/readings?node_id=node-b' });
    const rows = res.json().readings as { node_id: string }[];
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.node_id === 'node-b')).toBe(true);
  });

  it.each([
    ['limit 0', '/api/readings?limit=0', 'limit'],
    ['limit 5001', '/api/readings?limit=5001', 'limit'],
    ['limit not a number', '/api/readings?limit=many', 'limit'],
    ['from not ISO', '/api/readings?from=yesterday', 'from'],
    ['to not ISO', '/api/readings?to=2026-13-99', 'to'],
    ['from after to', '/api/readings?from=2026-11-08T13:00:00Z&to=2026-11-08T12:00:00Z', 'from'],
    ['node_id with spaces', '/api/readings?node_id=a%20b', 'node_id'],
  ])('400 for %s', async (_name, url, field) => {
    const h = await harness();
    const res = await api(h).app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toHaveProperty(field);
  });
});

describe('GET /api/events', () => {
  it('returns events newest first and honours limit', async () => {
    const h = await harness();
    for (let i = 0; i < 3; i++) {
      h.repo.events.push({
        id: i + 1,
        ts_start: new Date(T0 - (3 - i) * 3_600_000).toISOString(),
        ts_end: null,
        trigger: 'auto',
        reason: 'soil low',
        result: 'completed',
      });
    }
    const res = await api(h).app.inject({ method: 'GET', url: '/api/events?limit=2' });
    expect(res.statusCode).toBe(200);
    const events = res.json().events as { id: number }[];
    expect(events.map((e) => e.id)).toEqual([3, 2]);
  });

  it('defaults to 10 and rejects limit > 100', async () => {
    const h = await harness();
    const ok = await api(h).app.inject({ method: 'GET', url: '/api/events' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ events: [] });
    const bad = await api(h).app.inject({ method: 'GET', url: '/api/events?limit=101' });
    expect(bad.statusCode).toBe(400);
    const zero = await api(h).app.inject({ method: 'GET', url: '/api/events?limit=0' });
    expect(zero.statusCode).toBe(400);
  });
});

describe('GET /api/status', () => {
  it('reports pump, nodes, alarms, db, auto flag and runtime', async () => {
    const h = await harness();
    h.repo.rows.push(makeReading({ node_id: 'fresh', ts: new Date(T0 - 5_000).toISOString() }));
    h.repo.rows.push(makeReading({ node_id: 'old', ts: new Date(T0 - 2_000_000).toISOString() }));
    const alarm: Alarm = { code: 'sensor_stale', since: new Date(T0).toISOString(), message: 'stale', severity: 'warn' };
    h.repo.alarms = [alarm];
    h.controller.pumpState = 'on';
    h.controller.activeRun = { ackedAt: T0 - 10_000 };
    h.controller.dailyRuntimeSeconds = 120;

    const res = await api(h).app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.now).toBe(new Date(T0).toISOString());
    expect(body.uptime_s).toBe(60);
    expect(body.pump.state).toBe('on');
    expect(body.pump.command).toBeNull();
    expect(body.nodes.fresh).toMatchObject({ age_s: 5, stale: false });
    expect(body.nodes.old).toMatchObject({ stale: true });
    expect(body.alarms).toEqual([alarm]);
    expect(body.db).toBe(true);
    expect(body.auto_enabled).toBe(true);
    expect(body.daily_runtime_s).toBe(130);
  });

  it('pump.since follows state changes and command comes from the controller queue', async () => {
    const h = await harness();
    const queued = makeCommand({ type: 'pump_on', state: 'pending', max_s: 20 });
    h.controller.pumpState = 'off';
    h.controller.pendingManual = queued;
    h.bus.emit('pump', { state: 'off' });
    h.clock.t = T0 + 5_000;
    const res = await api(h).app.inject({ method: 'GET', url: '/api/status' });
    const body = res.json();
    expect(body.pump.state).toBe('off');
    // since = when the API first observed 'off' (bus event at T0), not the later status read
    expect(body.pump.since).toBe(new Date(T0).toISOString());
    expect(body.pump.command).toMatchObject({ id: queued.id, state: 'pending' });
  });

  it('db false when the repo reports down; alarms come from the repo', async () => {
    const h = await harness();
    h.repo.down = true;
    const res = await api(h).app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json().db).toBe(false);
  });
});

describe('dashboard and fallbacks', () => {
  it('serves index.html at / with no-cache and hashed assets as immutable', async () => {
    const h = await harness({ dashboardDir: dashDir });
    const root = await api(h).app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<title>dash</title>');
    expect(root.headers['cache-control']).toBe('no-cache');

    const asset = await api(h).app.inject({ method: 'GET', url: '/assets/app.0a1b2c3d.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('SPA fallback: unknown client routes get index.html', async () => {
    const h = await harness({ dashboardDir: dashDir });
    const res = await api(h).app.inject({ method: 'GET', url: '/history/week' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toContain('<title>dash</title>');
  });

  it('unknown files with an extension stay 404 (no SPA masking)', async () => {
    const h = await harness({ dashboardDir: dashDir });
    const res = await api(h).app.inject({ method: 'GET', url: '/assets/missing.js' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  it('unknown /api routes are JSON 404 and never serve index.html', async () => {
    const h = await harness({ dashboardDir: dashDir });
    const res = await api(h).app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });

  it('with no dashboard directory the API still works and / is a JSON 404', async () => {
    const h = await harness({ dashboardDir: join(dashDir, 'does-not-exist') });
    const health = await api(h).app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    const root = await api(h).app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(404);
    expect(root.json().error).toBe('not_found');
  });

  it('cacheControlFor: html revalidates, assets are immutable, others revalidate', () => {
    expect(cacheControlFor('/srv/dash/index.html')).toBe('no-cache');
    expect(cacheControlFor('/srv/dash/assets/index-Ab12Cd34.js')).toBe('public, max-age=31536000, immutable');
    expect(cacheControlFor('/srv/dash/favicon.txt')).toBe('no-cache');
  });
});

describe('static path traversal', () => {
  const attacks = [
    '/../secret.txt',
    '/../secret',
    '/..%2fsecret.txt',
    '/%2e%2e/secret.txt',
    '/%2e%2e%2fsecret.txt',
    '/%2e%2e%2f%2e%2e%2fsecret.txt',
    '/..%5csecret.txt',
    '/assets/../../secret.txt',
    '/assets/%2e%2e/%2e%2e/secret.txt',
    '/%252e%252e/secret.txt',
    '/%2e%2e/secret',
  ];

  it.each(attacks)('%s never serves a file outside DASHBOARD_DIR', async (url) => {
    const h = await harness({ dashboardDir: dashDir });
    const res = await api(h).app.inject({ method: 'GET', url });
    expect(res.body).not.toContain('TOP-SECRET-OUTSIDE');
    // A refusal (403/404), or the SPA shell for an extensionless client route. Never a file.
    if (res.statusCode === 200) expect(res.body).toContain('<title>dash</title>');
    else expect([403, 404]).toContain(res.statusCode); // 403: encoded separator refused by @fastify/static
  });
});

describe('POST /api/pump hardening', () => {
  it('rejects unknown keys (strict body)', async () => {
    const h = await harness();
    const res = await api(h).app.inject({
      method: 'POST',
      url: '/api/pump',
      headers: authHeader,
      payload: { cmd: 'on', duration_s: 10, extra: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toHaveProperty('extra');
  });

  it('rejects a non-finite duration (1e999 parses to Infinity)', async () => {
    const h = await harness();
    const res = await api(h).app.inject({
      method: 'POST',
      url: '/api/pump',
      headers: { ...authHeader, 'content-type': 'application/json' },
      payload: '{"cmd":"on","duration_s":1e999}',
    });
    expect(res.statusCode).toBe(400);
    expect(h.controller.requests).toHaveLength(0);
  });

  it('503 db_unavailable for an on request while the DB is down, without calling the controller', async () => {
    const h = await harness();
    h.repo.down = true;
    const res = await api(h).app.inject({ method: 'POST', url: '/api/pump', headers: authHeader, payload: { cmd: 'on', duration_s: 10 } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('db_unavailable');
    expect(h.controller.requests).toHaveLength(0);
  });

  it('off is still accepted while the DB is down', async () => {
    const h = await harness();
    h.repo.down = true;
    const res = await api(h).app.inject({ method: 'POST', url: '/api/pump', headers: authHeader, payload: { cmd: 'off' } });
    expect(res.statusCode).toBe(202);
  });

  it('starts are rate limited: 5 burst, then 429 with Retry-After; off is never limited', async () => {
    const h = await harness();
    const on = () => api(h).app.inject({ method: 'POST', url: '/api/pump', headers: authHeader, payload: { cmd: 'on', duration_s: 5 } });
    for (let i = 0; i < 5; i++) expect((await on()).statusCode).toBe(202);
    const limited = await on();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);

    for (let i = 0; i < 20; i++) {
      const off = await api(h).app.inject({ method: 'POST', url: '/api/pump', headers: authHeader, payload: { cmd: 'off' } });
      expect(off.statusCode).toBe(202);
    }
  });

  it('the bucket refills: one more start after 2 s', async () => {
    const h = await harness();
    const on = () => api(h).app.inject({ method: 'POST', url: '/api/pump', headers: authHeader, payload: { cmd: 'on', duration_s: 5 } });
    for (let i = 0; i < 5; i++) await on();
    expect((await on()).statusCode).toBe(429);
    h.clock.t += 2000;
    expect((await on()).statusCode).toBe(202);
  });

  it('a rejected (invalid) request does not consume a start token', async () => {
    const h = await harness();
    for (let i = 0; i < 10; i++) {
      await api(h).app.inject({ method: 'POST', url: '/api/pump', headers: authHeader, payload: { cmd: 'on' } });
    }
    for (let i = 0; i < 5; i++) {
      const ok = await api(h).app.inject({ method: 'POST', url: '/api/pump', headers: authHeader, payload: { cmd: 'on', duration_s: 5 } });
      expect(ok.statusCode).toBe(202);
    }
  });
});

describe('per-node tracking is bounded', () => {
  it('GET /api/latest keeps at most 256 nodes while the DB is down (oldest evicted)', async () => {
    const h = await harness();
    h.repo.down = true;
    for (let i = 0; i < 300; i++) {
      h.bus.emit('reading', makeReading({ node_id: `n-${i}`, ts: new Date(T0 - (300 - i) * 1000).toISOString() }));
    }
    const res = await api(h).app.inject({ method: 'GET', url: '/api/latest' });
    const nodes = Object.keys(res.json().nodes);
    expect(nodes.length).toBeLessThanOrEqual(256);
    expect(nodes).toContain('n-299');
    expect(nodes).not.toContain('n-0');
  });
});

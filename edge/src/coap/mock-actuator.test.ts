import dgram from 'node:dgram';
import { request } from 'coap';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockActuator, optionsFromEnv, type MockActuator } from './mock-actuator.js';

const HOST = '127.0.0.1';
const silent = pino({ level: 'silent' });

function freeUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', reject);
    sock.bind(0, HOST, () => {
      const { port } = sock.address();
      sock.close(() => resolve(port));
    });
  });
}

interface Reply {
  code: string;
  body: unknown;
}

/** Returns null if no reply arrives within timeoutMs. */
function call(
  port: number,
  method: 'GET' | 'PUT',
  body?: string,
  opts: { timeoutMs?: number; confirmable?: boolean } = {},
): Promise<Reply | null> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const req = request({
      host: HOST,
      port,
      pathname: '/pump',
      method,
      agent: false,
      confirmable: opts.confirmable ?? true,
      options: body !== undefined ? { 'Content-Format': 'application/json' } : undefined,
    });
    req.on('response', (res) => {
      clearTimeout(timer);
      let parsed: unknown = res.payload.toString('utf8');
      try {
        parsed = JSON.parse(res.payload.toString('utf8'));
      } catch {
        /* keep raw text */
      }
      resolve({ code: res.code, body: parsed });
    });
    req.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

const UUID_A = '6f1c2b1e-0000-4000-8000-00000000000a';
const UUID_B = '6f1c2b1e-0000-4000-8000-00000000000b';
const FUTURE = new Date(Date.now() + 60_000).toISOString();

let actuator: MockActuator | null = null;
afterEach(async () => {
  await actuator?.close();
  actuator = null;
});

async function start(opts: Parameters<typeof createMockActuator>[0] = {}): Promise<number> {
  const port = await freeUdpPort();
  actuator = createMockActuator({ host: HOST, port, log: silent, ...opts });
  await actuator.listen();
  return port;
}

describe('mock actuator: API', () => {
  it('boots with pump off and id null', async () => {
    const port = await start();
    const r = await call(port, 'GET');
    expect(r).toEqual({ code: '2.05', body: { id: null, pump: 'off', remaining_s: 0 } });
  });

  it('PUT on → 2.04 with remaining_s = max_s; GET reflects it', async () => {
    const port = await start();
    const r = await call(port, 'PUT', JSON.stringify({ cmd: 'on', max_s: 60, id: UUID_A, exp: FUTURE }));
    expect(r).toEqual({ code: '2.04', body: { id: UUID_A, pump: 'on', remaining_s: 60 } });

    const s = await call(port, 'GET');
    expect(s?.body).toMatchObject({ id: UUID_A, pump: 'on' });
    const remaining = (s?.body as { remaining_s: number }).remaining_s;
    expect(remaining).toBeGreaterThan(55);
    expect(remaining).toBeLessThanOrEqual(60);
  });

  it('PUT off → 2.04 {id, pump:off}', async () => {
    const port = await start();
    await call(port, 'PUT', JSON.stringify({ cmd: 'on', max_s: 60, id: UUID_A }));
    const r = await call(port, 'PUT', JSON.stringify({ cmd: 'off', id: UUID_B }));
    expect(r).toEqual({ code: '2.04', body: { id: UUID_B, pump: 'off' } });
    const s = await call(port, 'GET');
    expect(s?.body).toEqual({ id: UUID_B, pump: 'off', remaining_s: 0 });
  });

  it('idempotent by id: replays previous result and does not re-run', async () => {
    const port = await start();
    const first = await call(port, 'PUT', JSON.stringify({ cmd: 'on', max_s: 60, id: UUID_A }));
    await call(port, 'PUT', JSON.stringify({ cmd: 'off', id: UUID_B }));

    // Same id as the first command, after a different command has changed state.
    const replay = await call(port, 'PUT', JSON.stringify({ cmd: 'on', max_s: 60, id: UUID_A }));
    expect(replay).toEqual(first);

    const s = await call(port, 'GET');
    expect(s?.body).toMatchObject({ id: UUID_B, pump: 'off' });
  });

  it('exp in the past → 4.08, no action', async () => {
    const port = await start();
    const past = new Date(Date.now() - 1000).toISOString();
    const r = await call(port, 'PUT', JSON.stringify({ cmd: 'on', max_s: 60, id: UUID_A, exp: past }));
    expect(r?.code).toBe('4.08');
    const s = await call(port, 'GET');
    expect(s?.body).toEqual({ id: null, pump: 'off', remaining_s: 0 });
  });

  it('expired command is not cached: a later valid retry with same id is applied', async () => {
    let clock = Date.parse('2026-11-08T12:00:00Z');
    const port = await start({ now: () => clock });
    const exp = '2026-11-08T12:00:30Z';
    clock = Date.parse('2026-11-08T12:01:00Z');
    expect((await call(port, 'PUT', JSON.stringify({ cmd: 'on', max_s: 5, id: UUID_A, exp })))?.code).toBe('4.08');
    clock = Date.parse('2026-11-08T11:59:00Z');
    expect((await call(port, 'PUT', JSON.stringify({ cmd: 'on', max_s: 5, id: UUID_A, exp })))?.code).toBe('2.04');
  });

  it('max_s is a hard local timer: pump turns off on its own', async () => {
    const port = await start();
    await call(port, 'PUT', JSON.stringify({ cmd: 'on', max_s: 1, id: UUID_A }));
    expect((await call(port, 'GET'))?.body).toMatchObject({ pump: 'on' });

    await new Promise((r) => setTimeout(r, 1200));
    expect((await call(port, 'GET'))?.body).toEqual({ id: UUID_A, pump: 'off', remaining_s: 0 });
  });

  it('a new on cancels the previous timer', async () => {
    const port = await start();
    await call(port, 'PUT', JSON.stringify({ cmd: 'on', max_s: 1, id: UUID_A }));
    await call(port, 'PUT', JSON.stringify({ cmd: 'on', max_s: 5, id: UUID_B }));
    await new Promise((r) => setTimeout(r, 1200));
    expect((await call(port, 'GET'))?.body).toMatchObject({ id: UUID_B, pump: 'on' });
  });

  it('invalid bodies → 4.00 and no state change', async () => {
    const port = await start();
    const bad = [
      '{not json',
      '[]',
      JSON.stringify({ cmd: 'on', max_s: 60 }), // no id
      JSON.stringify({ cmd: 'on', max_s: 0, id: UUID_A }),
      JSON.stringify({ cmd: 'on', max_s: 601, id: UUID_A }),
      JSON.stringify({ cmd: 'on', max_s: 1.5, id: UUID_A }),
      JSON.stringify({ cmd: 'toggle', id: UUID_A }),
      JSON.stringify({ cmd: 'on', max_s: 60, id: UUID_A, exp: 'tomorrow' }),
    ];
    for (const body of bad) {
      const r = await call(port, 'PUT', body);
      expect(r?.code, body).toBe('4.00');
    }
    expect((await call(port, 'GET'))?.body).toEqual({ id: null, pump: 'off', remaining_s: 0 });
  });
});

describe('mock actuator: adverse knobs', () => {
  it('MOCK_NEVER_ACK: PUT is applied but never answered; GET still answers', async () => {
    const port = await start({ neverAck: true });
    const r = await call(port, 'PUT', JSON.stringify({ cmd: 'on', max_s: 60, id: UUID_A }), {
      timeoutMs: 800,
      confirmable: false,
    });
    expect(r).toBeNull();
    expect((await call(port, 'GET'))?.body).toMatchObject({ id: UUID_A, pump: 'on' });
  });

  it('MOCK_DROP_RATE=1: every request is dropped without action', async () => {
    const port = await start({ dropRate: 1, random: () => 0 });
    const r = await call(port, 'PUT', JSON.stringify({ cmd: 'on', max_s: 60, id: UUID_A }), {
      timeoutMs: 800,
      confirmable: false,
    });
    expect(r).toBeNull();
    expect(actuator?.state()).toEqual({ pump: 'off', id: null, remaining_s: 0 });
  });

  it('MOCK_DROP_RATE=0 never drops', async () => {
    const port = await start({ dropRate: 0, random: () => 0 });
    expect((await call(port, 'GET'))?.code).toBe('2.05');
  });

  it('MOCK_DELAY_MS delays the reply', async () => {
    const port = await start({ delayMs: 300 });
    const t0 = Date.now();
    const r = await call(port, 'GET');
    expect(r?.code).toBe('2.05');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
  });
});

describe('mock actuator: env parsing', () => {
  it('defaults', () => {
    const o = optionsFromEnv({}, silent);
    expect(o).toMatchObject({ host: '127.0.0.1', port: 5684, dropRate: 0, neverAck: false, delayMs: 0 });
  });

  it('reads MOCK_* knobs and ACTUATOR_PORT fallback', () => {
    const o = optionsFromEnv(
      { ACTUATOR_PORT: '7000', MOCK_DROP_RATE: '0.25', MOCK_NEVER_ACK: 'true', MOCK_DELAY_MS: '50', MOCK_COAP_HOST: '0.0.0.0' },
      silent,
    );
    expect(o).toMatchObject({ host: '0.0.0.0', port: 7000, dropRate: 0.25, neverAck: true, delayMs: 50 });
  });

  it('MOCK_COAP_PORT wins over ACTUATOR_PORT', () => {
    expect(optionsFromEnv({ ACTUATOR_PORT: '7000', MOCK_COAP_PORT: '7001' }, silent).port).toBe(7001);
  });

  it('rejects out-of-range knobs', () => {
    expect(() => optionsFromEnv({ MOCK_DROP_RATE: '1.5' }, silent)).toThrow(/MOCK_DROP_RATE/);
    expect(() => optionsFromEnv({ MOCK_DROP_RATE: 'abc' }, silent)).toThrow(/MOCK_DROP_RATE/);
    expect(() => optionsFromEnv({ MOCK_DELAY_MS: '-1' }, silent)).toThrow(/MOCK_DELAY_MS/);
    expect(() => optionsFromEnv({ MOCK_COAP_PORT: '70000' }, silent)).toThrow(/MOCK_COAP_PORT/);
  });

  it('MOCK_NEVER_ACK only accepts 1/true', () => {
    expect(optionsFromEnv({ MOCK_NEVER_ACK: '0' }, silent).neverAck).toBe(false);
    expect(optionsFromEnv({ MOCK_NEVER_ACK: '1' }, silent).neverAck).toBe(true);
  });
});

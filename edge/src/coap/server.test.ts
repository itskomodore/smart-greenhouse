import dgram from 'node:dgram';
import { request } from 'coap';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_DEFAULTS } from '../types.js';
import type { Reading, Repo, Settings } from '../types.js';
import { createCoapIngestServer, type CoapIngestDeps, type CoapIngestServer } from './server.js';

const NOW = new Date('2026-11-08T12:00:00.000Z');
const silent = pino({ level: 'silent' });
const HOST = '127.0.0.1';

interface Reply {
  code: string;
  payload: string;
  contentFormat: unknown;
}

/** Send one CoAP request over UDP to the server under test. */
function sendCoap(
  port: number,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  pathname: string,
  body?: Buffer | string,
  contentFormat?: string,
  timeoutMs = 3000,
): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply to ${method} ${pathname}`)), timeoutMs);
    const req = request({
      host: HOST,
      port,
      pathname,
      method,
      agent: false,
      options: contentFormat ? { 'Content-Format': contentFormat } : undefined,
    });
    req.on('response', (res) => {
      clearTimeout(timer);
      resolve({
        code: res.code,
        payload: res.payload.toString('utf8'),
        contentFormat: res.headers['Content-Format'],
      });
    });
    req.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

/** Ask the OS for a free UDP port (small race window, acceptable for tests). */
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

function fakeRepo(overrides: Partial<Pick<Repo, 'insertReading' | 'ping'>> = {}): Pick<Repo, 'insertReading' | 'ping'> & {
  inserted: Reading[];
} {
  const inserted: Reading[] = [];
  return {
    inserted,
    insertReading: overrides.insertReading ?? (async (r: Reading) => {
      inserted.push(r);
    }),
    ping: overrides.ping ?? (async () => true),
  };
}

const SETTINGS: Settings = { ...SETTINGS_DEFAULTS };

const validBody = JSON.stringify({ t: 23.41, rh: 55.2, light: 812, soil: 1530 });

describe('CoAP ingest server', () => {
  let server: CoapIngestServer;
  let port: number;
  let repo: ReturnType<typeof fakeRepo>;
  let emit: ReturnType<typeof vi.fn>;
  let deps: CoapIngestDeps;

  beforeEach(async () => {
    port = await freeUdpPort();
    repo = fakeRepo();
    emit = vi.fn();
    deps = {
      repo,
      getSettings: async () => SETTINGS,
      bus: { emit },
      log: silent,
      now: () => NOW,
    };
    server = createCoapIngestServer(deps);
    await server.listen(port, HOST);
  });

  afterEach(async () => {
    await server.close();
  });

  describe('POST/PUT /sensor, valid input', () => {
    it('POST valid → 2.01 Created and stores a normalized reading', async () => {
      const r = await sendCoap(port, 'POST', '/sensor', validBody, 'application/json');
      expect(r.code).toBe('2.01');
      expect(repo.inserted).toHaveLength(1);
      const stored = repo.inserted[0];
      expect(stored).toMatchObject({
        t: 23.41,
        rh: 55.2,
        light_raw: 812,
        soil_raw: 1530,
        ts: '2026-11-08T12:00:00.000Z',
      });
      expect(stored?.soil_pct).toBeCloseTo(((3000 - 1530) / 1800) * 100, 6);
    });

    it('PUT valid → 2.04 Changed', async () => {
      const r = await sendCoap(port, 'PUT', '/sensor', validBody, 'application/json');
      expect(r.code).toBe('2.04');
      expect(repo.inserted).toHaveLength(1);
    });

    it('no Content-Format is accepted as JSON', async () => {
      const r = await sendCoap(port, 'POST', '/sensor', validBody);
      expect(r.code).toBe('2.01');
    });

    it('node_id is payload.id when present', async () => {
      const body = JSON.stringify({ id: 'node-a', t: 20, rh: 50, light: 1, soil: 2 });
      const r = await sendCoap(port, 'POST', '/sensor', body, 'application/json');
      expect(r.code).toBe('2.01');
      expect(repo.inserted[0]?.node_id).toBe('node-a');
    });

    it('node_id falls back to the CoAP source address when id absent', async () => {
      const r = await sendCoap(port, 'POST', '/sensor', validBody, 'application/json');
      expect(r.code).toBe('2.01');
      expect(repo.inserted[0]?.node_id).toBe(HOST);
    });

    it('publishes the stored reading on the bus', async () => {
      await sendCoap(port, 'POST', '/sensor', validBody, 'application/json');
      expect(emit).toHaveBeenCalledWith('reading', expect.objectContaining({ node_id: HOST }));
    });

    it('a throwing bus listener still yields 2.01', async () => {
      emit.mockImplementation(() => {
        throw new Error('subscriber boom');
      });
      const r = await sendCoap(port, 'POST', '/sensor', validBody, 'application/json');
      expect(r.code).toBe('2.01');
      expect(repo.inserted).toHaveLength(1);
    });
  });

  describe('POST/PUT /sensor, invalid input → 4.00', () => {
    const invalid: Array<[string, string]> = [
      ['malformed JSON', '{"t":23.4,"rh"'],
      ['empty body', ''],
      ['JSON array', '[1,2,3]'],
      ['wrong type t', '{"t":"23.4","rh":55,"light":1,"soil":1}'],
      ['t out of range', '{"t":-41,"rh":55,"light":1,"soil":1}'],
      ['rh out of range', '{"t":1,"rh":101,"light":1,"soil":1}'],
      ['light out of range', '{"t":1,"rh":1,"light":4096,"soil":1}'],
      ['soil float', '{"t":1,"rh":1,"light":1,"soil":1.5}'],
      ['bad id', '{"id":"no spaces here","t":1,"rh":1,"light":1,"soil":1}'],
    ];

    for (const [name, body] of invalid) {
      it(`${name} → 4.00, nothing stored, server keeps serving`, async () => {
        const bad = await sendCoap(port, 'POST', '/sensor', body, 'application/json');
        expect(bad.code).toBe('4.00');
        expect(bad.payload.length).toBeGreaterThan(0);
        expect(repo.inserted).toHaveLength(0);

        const good = await sendCoap(port, 'POST', '/sensor', validBody, 'application/json');
        expect(good.code).toBe('2.01');
        expect(repo.inserted).toHaveLength(1);
      });
    }

    it('oversize payload (300 B) → 4.00, then next valid request succeeds', async () => {
      const big = JSON.stringify({ ...JSON.parse(validBody), pad: 'x'.repeat(300) });
      const bad = await sendCoap(port, 'POST', '/sensor', big, 'application/json');
      expect(bad.code).toBe('4.00');
      expect(repo.inserted).toHaveLength(0);

      const good = await sendCoap(port, 'PUT', '/sensor', validBody, 'application/json');
      expect(good.code).toBe('2.04');
    });

    it('large single datagram (1100 B) → 4.00, server survives', async () => {
      // The coap client refuses messages over ~1280 B, so 1100 B is the largest single-datagram case.
      const big = JSON.stringify({ ...JSON.parse(validBody), pad: 'y'.repeat(1100) });
      const bad = await sendCoap(port, 'POST', '/sensor', big, 'application/json');
      expect(bad.code).toBe('4.00');

      const good = await sendCoap(port, 'POST', '/sensor', validBody, 'application/json');
      expect(good.code).toBe('2.01');
    });

    it('binary garbage payload → 4.00, server survives', async () => {
      const bad = await sendCoap(port, 'POST', '/sensor', Buffer.from([0xff, 0xfe, 0x00, 0x80]), 'application/json');
      expect(bad.code).toBe('4.00');
      const good = await sendCoap(port, 'POST', '/sensor', validBody, 'application/json');
      expect(good.code).toBe('2.01');
    });
  });

  describe('protocol-level rejections', () => {
    it('unsupported Content-Format → 4.15', async () => {
      const r = await sendCoap(port, 'POST', '/sensor', validBody, 'text/plain');
      expect(r.code).toBe('4.15');
      expect(repo.inserted).toHaveLength(0);
    });

    it('GET /sensor → 4.05', async () => {
      const r = await sendCoap(port, 'GET', '/sensor');
      expect(r.code).toBe('4.05');
    });

    it('unknown path → 4.04', async () => {
      const r = await sendCoap(port, 'POST', '/nope', validBody, 'application/json');
      expect(r.code).toBe('4.04');
    });
  });

  describe('storage and settings failures', () => {
    it('insertReading rejects → 5.00 and bus not emitted', async () => {
      repo = fakeRepo({ insertReading: async () => { throw new Error('db gone'); } });
      await server.close();
      server = createCoapIngestServer({ ...deps, repo });
      await server.listen(port, HOST);

      const r = await sendCoap(port, 'POST', '/sensor', validBody, 'application/json');
      expect(r.code).toBe('5.00');
      expect(emit).not.toHaveBeenCalled();
    });

    it('getSettings rejects → 5.00, server keeps serving', async () => {
      let fail = true;
      await server.close();
      server = createCoapIngestServer({
        ...deps,
        getSettings: async () => {
          if (fail) throw new Error('settings unavailable');
          return SETTINGS;
        },
      });
      await server.listen(port, HOST);

      const r1 = await sendCoap(port, 'POST', '/sensor', validBody, 'application/json');
      expect(r1.code).toBe('5.00');
      fail = false;
      const r2 = await sendCoap(port, 'POST', '/sensor', validBody, 'application/json');
      expect(r2.code).toBe('2.01');
    });

    it('degenerate calibration (dry == wet) → 5.00, nothing stored', async () => {
      await server.close();
      server = createCoapIngestServer({
        ...deps,
        getSettings: async () => ({ ...SETTINGS, soil_dry_raw: 2000, soil_wet_raw: 2000 }),
      });
      await server.listen(port, HOST);
      const r = await sendCoap(port, 'POST', '/sensor', validBody, 'application/json');
      expect(r.code).toBe('5.00');
      expect(repo.inserted).toHaveLength(0);
    });
  });

  describe('GET /health', () => {
    it('→ 2.05 JSON with db true and uptime', async () => {
      const r = await sendCoap(port, 'GET', '/health');
      expect(r.code).toBe('2.05');
      expect(r.contentFormat).toBe('application/json');
      const body = JSON.parse(r.payload) as { ok: boolean; db: boolean; uptime_s: number };
      expect(body.ok).toBe(true);
      expect(body.db).toBe(true);
      expect(Number.isInteger(body.uptime_s)).toBe(true);
      expect(body.uptime_s).toBeGreaterThanOrEqual(0);
    });

    it('db false when ping rejects', async () => {
      await server.close();
      server = createCoapIngestServer({ ...deps, repo: fakeRepo({ ping: async () => { throw new Error('down'); } }) });
      await server.listen(port, HOST);
      const body = JSON.parse((await sendCoap(port, 'GET', '/health')).payload) as { db: boolean };
      expect(body.db).toBe(false);
    });

    it('db false when ping hangs past the timeout', async () => {
      await server.close();
      server = createCoapIngestServer({ ...deps, repo: fakeRepo({ ping: () => new Promise<boolean>(() => {}) }) });
      await server.listen(port, HOST);
      const r = await sendCoap(port, 'GET', '/health', undefined, undefined, 5000);
      expect(r.code).toBe('2.05');
      expect(JSON.parse(r.payload)).toMatchObject({ db: false });
    });

    it('POST /health → 4.05', async () => {
      const r = await sendCoap(port, 'POST', '/health', 'x', 'text/plain');
      expect(r.code).toBe('4.05');
    });
  });

  describe('robustness', () => {
    it('garbage UDP datagrams do not crash the server', async () => {
      const sock = dgram.createSocket('udp4');
      const junk: Buffer[] = [
        Buffer.alloc(0),
        Buffer.from([0x00]),
        Buffer.from([0xff, 0xff, 0xff, 0xff]),
        Buffer.from([0x40, 0x01, 0x00, 0x01, 0xde, 0xad]), // truncated CoAP header
        Buffer.alloc(4000, 0x41),
      ];
      for (let i = 0; i < 50; i++) {
        junk.push(Buffer.from(Array.from({ length: (i % 37) + 1 }, () => Math.floor(Math.random() * 256))));
      }
      await new Promise<void>((resolve) => {
        let sent = 0;
        for (const j of junk) {
          sock.send(j, port, HOST, () => {
            sent++;
            if (sent === junk.length) resolve();
          });
        }
      });
      await new Promise((r) => setTimeout(r, 100));
      sock.close();

      const r = await sendCoap(port, 'POST', '/sensor', validBody, 'application/json');
      expect(r.code).toBe('2.01');
    });

    it('close() is idempotent and allows re-listen on the same port', async () => {
      await server.close();
      await server.close();
      await server.listen(port, HOST);
      const r = await sendCoap(port, 'GET', '/health');
      expect(r.code).toBe('2.05');
    });

    it('listen rejects when the port is already taken', async () => {
      const other = createCoapIngestServer(deps);
      await expect(other.listen(port, HOST)).rejects.toThrow();
      await other.close();
    });
  });
});

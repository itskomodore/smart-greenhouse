import { describe, expect, it } from 'vitest';
import { MAX_PAYLOAD_BYTES, validatePayload } from './validate.js';

const good = { t: 23.41, rh: 55.2, light: 812, soil: 1530 };
const json = (o: unknown): string => JSON.stringify(o);

type Case = { name: string; input: Uint8Array | string; ok: boolean; check?: (v: unknown) => void };

const cases: Case[] = [
  // ── accepted ──
  { name: 'minimal valid payload', input: json(good), ok: true,
    check: (v) => expect(v).toEqual({ t: 23.41, rh: 55.2, light: 812, soil: 1530 }) },
  { name: 'valid with id', input: json({ ...good, id: 'node-a' }), ok: true,
    check: (v) => expect((v as { id?: string }).id).toBe('node-a') },
  { name: 'id at max length 64', input: json({ ...good, id: 'a'.repeat(64) }), ok: true },
  { name: 'id with allowed punctuation', input: json({ ...good, id: 'Gh_1.s:2-x' }), ok: true },
  { name: 'unknown keys ignored', input: json({ ...good, fw: '1.2', extra: [1, 2] }), ok: true,
    check: (v) => expect(v).not.toHaveProperty('fw') },
  { name: 'boundary t = -40', input: json({ ...good, t: -40 }), ok: true },
  { name: 'boundary t = 85', input: json({ ...good, t: 85 }), ok: true },
  { name: 'boundary rh = 0', input: json({ ...good, rh: 0 }), ok: true },
  { name: 'boundary rh = 100', input: json({ ...good, rh: 100 }), ok: true },
  { name: 'boundary light = 0 and soil = 4095', input: json({ ...good, light: 0, soil: 4095 }), ok: true },
  { name: 'boundary light = 4095 and soil = 0', input: json({ ...good, light: 4095, soil: 0 }), ok: true },
  { name: 'Uint8Array input accepted', input: new TextEncoder().encode(json(good)), ok: true },

  // ── malformed JSON / framing ──
  { name: 'empty body', input: '', ok: false },
  { name: 'truncated JSON', input: '{"t":23.4,"rh"', ok: false },
  { name: 'garbage bytes', input: new Uint8Array([0xff, 0x00, 0x13, 0x37]), ok: false },
  { name: 'invalid UTF-8 inside a string', input: Buffer.concat([Buffer.from('{"t":1,"x":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]), ok: false },
  { name: 'JSON array', input: json([good]), ok: false },
  { name: 'JSON null', input: 'null', ok: false },
  { name: 'JSON scalar', input: '42', ok: false },
  { name: 'JSON string', input: '"hello"', ok: false },
  { name: 'infinite number via 1e400', input: '{"t":1e400,"rh":1,"light":1,"soil":1}', ok: false },

  // ── missing / wrong types ──
  { name: 'missing t', input: json({ rh: 1, light: 1, soil: 1 }), ok: false },
  { name: 'missing rh', input: json({ t: 1, light: 1, soil: 1 }), ok: false },
  { name: 'missing light', input: json({ t: 1, rh: 1, soil: 1 }), ok: false },
  { name: 'missing soil', input: json({ t: 1, rh: 1, light: 1 }), ok: false },
  { name: 't as string', input: json({ ...good, t: '23.4' }), ok: false },
  { name: 'rh as null', input: json({ ...good, rh: null }), ok: false },
  { name: 'light as boolean', input: json({ ...good, light: true }), ok: false },
  { name: 'soil as array', input: json({ ...good, soil: [1530] }), ok: false },
  { name: 'light as float', input: json({ ...good, light: 812.5 }), ok: false },
  { name: 'soil as float', input: json({ ...good, soil: 1530.1 }), ok: false },
  { name: 'id as number', input: json({ ...good, id: 7 }), ok: false },
  { name: 'id as null', input: json({ ...good, id: null }), ok: false },
  { name: 'id empty string', input: json({ ...good, id: '' }), ok: false },
  { name: 'id 65 chars', input: json({ ...good, id: 'a'.repeat(65) }), ok: false },
  { name: 'id with space', input: json({ ...good, id: 'node a' }), ok: false },
  { name: 'id with slash', input: json({ ...good, id: 'node/a' }), ok: false },
  { name: 'id with newline', input: json({ ...good, id: 'node\n' }), ok: false },

  // ── out of range ──
  { name: 't below -40', input: json({ ...good, t: -40.01 }), ok: false },
  { name: 't above 85', input: json({ ...good, t: 85.01 }), ok: false },
  { name: 'rh below 0', input: json({ ...good, rh: -0.1 }), ok: false },
  { name: 'rh above 100', input: json({ ...good, rh: 100.5 }), ok: false },
  { name: 'light below 0', input: json({ ...good, light: -1 }), ok: false },
  { name: 'light above 4095', input: json({ ...good, light: 4096 }), ok: false },
  { name: 'soil below 0', input: json({ ...good, soil: -1 }), ok: false },
  { name: 'soil above 4095', input: json({ ...good, soil: 4096 }), ok: false },

  // ── size ──
  { name: 'payload exactly at 256 B cap', input: padTo(MAX_PAYLOAD_BYTES), ok: true },
  { name: 'payload 257 B', input: padTo(MAX_PAYLOAD_BYTES + 1), ok: false },
  { name: 'oversize 4 KiB garbage', input: 'x'.repeat(4096), ok: false },
];

/** Build a valid JSON object padded with an ignored key to exactly `n` bytes. */
function padTo(n: number): string {
  const base = json({ ...good, pad: '' });
  const padLen = n - Buffer.byteLength(base, 'utf8');
  const s = json({ ...good, pad: 'p'.repeat(padLen) });
  expect(Buffer.byteLength(s, 'utf8')).toBe(n);
  return s;
}

describe('validatePayload', () => {
  for (const c of cases) {
    it(c.name, () => {
      const r = validatePayload(c.input);
      if (c.ok) {
        expect(r.ok, JSON.stringify(r)).toBe(true);
        if (r.ok && c.check) c.check(r.value);
      } else {
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.length).toBeGreaterThan(0);
          expect(r.error.length).toBeLessThan(80);
        }
      }
    });
  }

  it('never throws on arbitrary bytes', () => {
    for (let i = 0; i < 500; i++) {
      const buf = new Uint8Array(Math.floor(Math.random() * 300));
      for (let j = 0; j < buf.length; j++) buf[j] = Math.floor(Math.random() * 256);
      expect(() => validatePayload(buf)).not.toThrow();
    }
  });

  it('error text does not reflect input', () => {
    const r = validatePayload(json({ ...good, t: 'injected<script>' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain('script');
  });
});

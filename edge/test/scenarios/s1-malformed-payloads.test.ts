/**
 * S1: malformed / out-of-range / mistyped payloads over a real CoAP UDP socket.
 * Expect 4.00 (4.15 for an unsupported content format, per docs/API.md), nothing stored,
 * the server keeps answering, and the next valid reading gets 2.01 and is stored.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { closeAllRigs, coapRequest, Rig, sensorBody } from '../harness/rig.js';

afterEach(closeAllRigs);

const JSON_CT = 'application/json';

/** Payloads that must be rejected with 4.00. */
const MALFORMED: { name: string; body: string; contentFormat?: string }[] = [
  { name: 'not JSON', body: 'this is not json', contentFormat: JSON_CT },
  { name: 'empty body', body: '', contentFormat: JSON_CT },
  { name: 'NaN literal (not JSON)', body: '{"t":NaN,"rh":55,"light":812,"soil":1530}', contentFormat: JSON_CT },
  { name: 'Infinity via 1e999', body: '{"t":1e999,"rh":55,"light":812,"soil":1530}', contentFormat: JSON_CT },
  { name: 'truncated JSON', body: '{"t":22.5,"rh":55.2,"light":8', contentFormat: JSON_CT },
  { name: 't as string "22.5"', body: '{"t":"22.5","rh":55.2,"light":812,"soil":1530}', contentFormat: JSON_CT },
  { name: 'rh as string', body: '{"t":22.5,"rh":"55.2","light":812,"soil":1530}', contentFormat: JSON_CT },
  { name: 'soil as string', body: '{"t":22.5,"rh":55.2,"light":812,"soil":"1530"}', contentFormat: JSON_CT },
  { name: 't huge (1e308)', body: '{"t":1e308,"rh":55.2,"light":812,"soil":1530}', contentFormat: JSON_CT },
  { name: 't above 85', body: '{"t":85.5,"rh":55.2,"light":812,"soil":1530}', contentFormat: JSON_CT },
  { name: 't below -40', body: '{"t":-40.5,"rh":55.2,"light":812,"soil":1530}', contentFormat: JSON_CT },
  { name: 'rh above 100', body: '{"t":22.5,"rh":100.5,"light":812,"soil":1530}', contentFormat: JSON_CT },
  { name: 'light above 4095', body: '{"t":22.5,"rh":55.2,"light":4096,"soil":1530}', contentFormat: JSON_CT },
  { name: 'soil negative', body: '{"t":22.5,"rh":55.2,"light":812,"soil":-1}', contentFormat: JSON_CT },
  { name: 'soil non-integer', body: '{"t":22.5,"rh":55.2,"light":812,"soil":1530.5}', contentFormat: JSON_CT },
  { name: 'soil null', body: '{"t":22.5,"rh":55.2,"light":812,"soil":null}', contentFormat: JSON_CT },
  { name: 'missing t', body: '{"rh":55.2,"light":812,"soil":1530}', contentFormat: JSON_CT },
  { name: 'JSON array root', body: '[22.5,55.2,812,1530]', contentFormat: JSON_CT },
  { name: 'JSON null root', body: 'null', contentFormat: JSON_CT },
  { name: 'id with bad characters', body: sensorBody(20, { id: 'bad id!/../x' }), contentFormat: JSON_CT },
  { name: 'id not a string', body: sensorBody(20, { id: 42 }), contentFormat: JSON_CT },
  { name: 'oversized (> 256 B)', body: sensorBody(20, { pad: 'x'.repeat(1000) }), contentFormat: JSON_CT },
];

describe('S1 malformed payloads over UDP', () => {
  it('S1: every malformed payload gets 4.00, nothing is stored, and the next valid reading is accepted', async () => {
    const rig = await Rig.start();

    for (const c of MALFORMED) {
      const bad = await rig.post(c.body, c.contentFormat);
      expect(bad.code, `${c.name} -> 4.00`).toBe('4.00');
      expect(bad.payload.length, `${c.name} carries a short reason`).toBeGreaterThan(0);

      // Server survives: health still answers, and the next valid reading is stored.
      const health = await coapRequest(rig.port, 'GET', '/health');
      expect(health.code, `${c.name}: health after reject`).toBe('2.05');

      // Soil stays at 50 % (above low_threshold) so no irrigation is started by this test.
      const good = await rig.reading(50 + (rig.mem.rows.length % 5));
      expect(good.code, `${c.name}: next valid -> 2.01`).toBe('2.01');
    }

    expect(rig.mem.rows).toHaveLength(MALFORMED.length);
    expect(rig.readingsSeen).toHaveLength(MALFORMED.length);
    // Only validated readings reach the controller.
    for (const r of rig.readingsSeen) expect(Number.isFinite(r.soil_pct)).toBe(true);
    expect(rig.ctl.latestAccepted).not.toBeNull();
  });

  it('S1: a payload with the wrong content format gets 4.15 (not 4.00), nothing stored, server survives', async () => {
    // docs/API.md: unsupported content -> 4.15. The scenario list said 4.00; the contract wins.
    const rig = await Rig.start();

    const wrong = await rig.post(sensorBody(20), 'text/plain');
    expect(wrong.code).toBe('4.15');
    expect(rig.mem.rows).toHaveLength(0);

    const good = await rig.reading(50);
    expect(good.code).toBe('2.01');
    expect(rig.mem.rows).toHaveLength(1);
  });

  it('S1: a valid payload with no Content-Format is accepted (2.01), and PUT gets 2.04', async () => {
    const rig = await Rig.start();

    const post = await rig.post(sensorBody(50));
    expect(post.code).toBe('2.01');

    const put = await coapRequest(rig.port, 'PUT', '/sensor', sensorBody(51), JSON_CT);
    await rig.flush();
    expect(put.code).toBe('2.04');
    expect(rig.mem.rows).toHaveLength(2);
  });
});

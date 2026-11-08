/**
 * SSE needs a real socket: a stream never ends, so fastify.inject (which resolves on response end)
 * cannot observe it. Each test listens on an ephemeral loopback port and reads with fetch.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Harness } from './test-support.js';
import { buildHarness, makeCommand, makeReading, T0 } from './test-support.js';
import { SETTINGS_DEFAULTS } from '../types.js';

const open: Harness[] = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()!.api.close();
});

async function start(over: Parameters<typeof buildHarness>[0] = {}): Promise<{ h: Harness; base: string }> {
  const h = await buildHarness({ heartbeatMs: 60_000, ...over });
  open.push(h);
  const base = await h.api.app.listen({ host: '127.0.0.1', port: 0 });
  return { h, base };
}

interface Stream {
  status: number;
  contentType: string | null;
  cacheControl: string | null;
  waitFor(pred: (text: string) => boolean, ms?: number): Promise<string>;
  text(): string;
  close(): void;
}

async function connect(base: string): Promise<Stream> {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/stream`, { signal: ac.signal, headers: { accept: 'text/event-stream' } });
  const decoder = new TextDecoder();
  let buf = '';
  const reader = res.body?.getReader();
  if (!reader) throw new Error('no body');
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    cacheControl: res.headers.get('cache-control'),
    async waitFor(pred, ms = 2000) {
      const deadline = Date.now() + ms;
      while (!pred(buf)) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`timed out waiting for stream text; got: ${JSON.stringify(buf)}`);
        const next = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('read timeout')), left)),
        ]);
        if (next.done) throw new Error(`stream ended early; got: ${JSON.stringify(buf)}`);
        buf += decoder.decode(next.value, { stream: true });
      }
      return buf;
    },
    text: () => buf,
    close: () => ac.abort(),
  };
}

async function eventually(check: () => boolean, ms = 1500): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('GET /api/stream', () => {
  it('sends the snapshot (pump, then alarms) as the first events', async () => {
    const { h, base } = await start();
    h.controller.pumpState = 'off';
    const s = await connect(base);
    try {
      expect(s.status).toBe(200);
      expect(s.contentType).toContain('text/event-stream');
      expect(s.cacheControl).toContain('no-cache');
      const text = await s.waitFor((t) => t.includes('event: alarms'));
      const firstEvent = text.indexOf('event: ');
      expect(text.slice(firstEvent).startsWith('event: pump\n')).toBe(true);
      expect(text).toContain('data: {"state":"off"}');
      expect(text).toContain('event: alarms\ndata: []');
    } finally {
      s.close();
    }
  });

  it('delivers live bus events after the snapshot', async () => {
    const { h, base } = await start();
    const s = await connect(base);
    try {
      await s.waitFor((t) => t.includes('event: alarms'));

      h.bus.emit('reading', makeReading({ node_id: 'live-node', soil_pct: 42 }));
      await s.waitFor((t) => t.includes('event: reading'));
      expect(s.text()).toContain('"node_id":"live-node"');

      const cmd = makeCommand({ state: 'acked', ack_ts: new Date(T0).toISOString() });
      h.bus.emit('pump', { state: 'on', command: cmd });
      await s.waitFor((t) => t.includes('event: pump\ndata: {"state":"on"'));

      h.bus.emit('alarms', [{ code: 'sensor_stale', since: new Date(T0).toISOString(), message: 'm', severity: 'warn' }]);
      await s.waitFor((t) => t.includes('"code":"sensor_stale"'));

      h.bus.emit('settings', { ...SETTINGS_DEFAULTS, low_threshold: 22 });
      await s.waitFor((t) => t.includes('event: settings') && t.includes('"low_threshold":22'));

      h.bus.emit('event', {
        ts_start: new Date(T0).toISOString(),
        ts_end: null,
        trigger: 'auto',
        reason: 'soil low',
        result: 'running',
      });
      await s.waitFor((t) => t.includes('event: event'));
    } finally {
      s.close();
    }
  });

  it('writes a heartbeat comment on the configured period', async () => {
    const { base } = await start({ heartbeatMs: 25 });
    const s = await connect(base);
    try {
      await s.waitFor((t) => t.includes(': heartbeat'), 1500);
    } finally {
      s.close();
    }
  });

  it('refuses the client beyond the cap with 503', async () => {
    const { h, base } = await start({ maxStreamClients: 2 });
    const a = await connect(base);
    const b = await connect(base);
    try {
      await a.waitFor((t) => t.includes('event: alarms'));
      await b.waitFor((t) => t.includes('event: alarms'));
      expect(h.api.streamClients()).toBe(2);

      const res = await fetch(`${base}/api/stream`, { headers: { accept: 'text/event-stream' } });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: 'too_many_clients' });
    } finally {
      a.close();
      b.close();
    }
  });

  it('cleans up on client close and leaves no per-client bus listeners behind', async () => {
    const { h, base } = await start();
    const before = h.bus.listenerCount('reading');
    const s = await connect(base);
    await s.waitFor((t) => t.includes('event: alarms'));
    expect(h.api.streamClients()).toBe(1);
    expect(h.bus.listenerCount('reading')).toBe(before);

    s.close();
    await eventually(() => h.api.streamClients() === 0);
    expect(h.bus.listenerCount('reading')).toBe(before);

    // A later client is served normally after the earlier one left.
    const again = await connect(base);
    try {
      await again.waitFor((t) => t.includes('event: alarms'));
      expect(h.api.streamClients()).toBe(1);
    } finally {
      again.close();
    }
  });

  it('closing the API ends open streams and releases bus subscriptions', async () => {
    const { h, base } = await start();
    const s = await connect(base);
    await s.waitFor((t) => t.includes('event: alarms'));
    expect(h.bus.listenerCount('reading')).toBeGreaterThan(0);

    await h.api.close();
    expect(h.api.streamClients()).toBe(0);
    expect(h.bus.listenerCount('reading')).toBe(0);
    expect(h.bus.listenerCount('pump')).toBe(0);
    s.close();
  });
});

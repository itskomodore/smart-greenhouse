import { afterEach, describe, expect, it } from 'vitest';
import type { ManualResult } from './deps.js';
import { buildHarness, authHeader, makeCommand, type Harness } from './test-support.js';

const open: Harness[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.api.close();
});

async function harness(): Promise<Harness> {
  const h = await buildHarness({ heartbeatMs: 60_000 });
  open.push(h);
  return h;
}

/** Controller that answers with a pending command and reports `final` on the bus after `delayMs`. */
function settleLater(h: Harness, final: 'acked' | 'failed' | 'expired', delayMs: number, extra: Record<string, unknown> = {}): void {
  h.controller.respond = async (req): Promise<ManualResult> => {
    const c = makeCommand({
      type: req.cmd === 'on' ? 'pump_on' : 'pump_off',
      max_s: req.cmd === 'on' ? req.duration_s : null,
      id: req.id ?? undefined,
    });
    setTimeout(() => {
      h.bus.emit('pump', { state: final === 'acked' ? 'on' : 'unknown', command: { ...c, state: final, ...extra } });
    }, delayMs);
    return { ok: true, command: c, duplicate: false };
  };
}

const post = (h: Harness, url: string, payload: unknown) =>
  h.api.app.inject({ method: 'POST', url, headers: authHeader, payload: payload as object });

describe('POST /api/pump?wait_ms', () => {
  it('settles within the wait -> 200 with the final command and pump state', async () => {
    const h = await harness();
    settleLater(h, 'acked', 40);
    const started = Date.now();
    const res = await post(h, '/api/pump?wait_ms=2000', { cmd: 'on', duration_s: 10 });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.command.state).toBe('acked');
    expect(body.duplicate).toBe(false);
    expect(body.pump).toBe('unknown'); // controller pumpState fake is unchanged
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('settles without any bus event: the DB poll sees the terminal state', async () => {
    const h = await harness();
    h.controller.respond = async (req): Promise<ManualResult> => {
      const c = makeCommand({ type: 'pump_on', max_s: req.cmd === 'on' ? req.duration_s : null });
      h.repo.commands.set(c.id, { ...c, state: 'acked', ack_ts: new Date().toISOString() });
      return { ok: true, command: c, duplicate: false };
    };
    const res = await post(h, '/api/pump?wait_ms=2000', { cmd: 'on', duration_s: 10 });
    expect(res.statusCode).toBe(200);
    expect(res.json().command.state).toBe('acked');
  });

  it('never settles -> 202 after about wait_ms, with the latest pending command', async () => {
    const h = await harness();
    h.controller.respond = async (req): Promise<ManualResult> => ({
      ok: true,
      duplicate: false,
      command: makeCommand({ type: 'pump_on', state: 'pending', max_s: req.cmd === 'on' ? req.duration_s : null }),
    });
    const started = Date.now();
    const res = await post(h, '/api/pump?wait_ms=300', { cmd: 'on', duration_s: 10 });
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ command: expect.objectContaining({ state: 'pending' }), duplicate: false });
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(1500);
  });

  it('failed command -> 200 with state failed and last_error', async () => {
    const h = await harness();
    settleLater(h, 'failed', 30, { last_error: 'refused: sensor stale' });
    const res = await post(h, '/api/pump?wait_ms=2000', { cmd: 'on', duration_s: 10 });
    expect(res.statusCode).toBe(200);
    expect(res.json().command).toMatchObject({ state: 'failed', last_error: 'refused: sensor stale' });
  });

  it('off also waits and settles', async () => {
    const h = await harness();
    settleLater(h, 'acked', 30);
    const res = await post(h, '/api/pump?wait_ms=2000', { cmd: 'off' });
    expect(res.statusCode).toBe(200);
    expect(res.json().command.type).toBe('pump_off');
  });

  it('duplicate id that is still pending waits too and reports duplicate=true', async () => {
    const h = await harness();
    const id = '2f1d6f2e-9d8a-4a4b-8b5e-1c2d3e4f5a6b';
    h.controller.respond = async () => {
      const c = makeCommand({ id, type: 'pump_on', state: 'pending' });
      setTimeout(() => h.bus.emit('pump', { state: 'on', command: { ...c, state: 'acked' } }), 30);
      return { ok: true, command: c, duplicate: true };
    };
    const res = await post(h, '/api/pump?wait_ms=2000', { cmd: 'on', duration_s: 10, id });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ duplicate: true, command: { id, state: 'acked' } });
  });

  it('wait_ms=0 (default) keeps the immediate 202 behaviour', async () => {
    const h = await harness();
    settleLater(h, 'acked', 10);
    const res = await post(h, '/api/pump', { cmd: 'on', duration_s: 10 });
    expect(res.statusCode).toBe(202);
  });

  it.each(['-1', '5001', 'abc', '1.5', '', '99999'])('invalid wait_ms=%s -> 400 validation_error', async (v) => {
    const h = await harness();
    const res = await post(h, `/api/pump?wait_ms=${v}`, { cmd: 'on', duration_s: 10 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_error' });
    expect(res.json().fields).toHaveProperty('wait_ms');
    expect(h.controller.requests).toHaveLength(0);
  });

  it('listener cleanup: after a settled wait and after a timed-out wait the pump listener count is back to baseline', async () => {
    const h = await harness();
    const baseline = h.bus.listenerCount('pump');
    settleLater(h, 'acked', 20);
    await post(h, '/api/pump?wait_ms=2000', { cmd: 'on', duration_s: 10 });
    expect(h.bus.listenerCount('pump')).toBe(baseline);

    h.controller.respond = async (req) => ({
      ok: true,
      duplicate: false,
      command: makeCommand({ type: 'pump_on', state: 'pending', max_s: req.cmd === 'on' ? req.duration_s : null }),
    });
    await post(h, '/api/pump?wait_ms=100', { cmd: 'on', duration_s: 10 });
    expect(h.bus.listenerCount('pump')).toBe(baseline);
  });
});

describe('POST /api/pump?wait_ms client disconnect', () => {
  it('a client abort ends only the observation: listener released, command not cancelled', async () => {
    const h = await harness();
    const base = await h.api.app.listen({ host: '127.0.0.1', port: 0 });
    const baseline = h.bus.listenerCount('pump');
    h.controller.respond = async (req) => ({
      ok: true,
      duplicate: false,
      command: makeCommand({ type: 'pump_on', state: 'pending', max_s: req.cmd === 'on' ? req.duration_s : null }),
    });

    const ac = new AbortController();
    const pending = fetch(`${base}/api/pump?wait_ms=5000`, {
      method: 'POST',
      headers: { ...authHeader, 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'on', duration_s: 10 }),
      signal: ac.signal,
    }).catch(() => undefined);

    // Wait until the wait is registered, then drop the client.
    const deadline = Date.now() + 2000;
    while (h.bus.listenerCount('pump') === baseline && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(h.bus.listenerCount('pump')).toBe(baseline + 1);
    ac.abort();
    await pending;

    const cleanupDeadline = Date.now() + 2000;
    while (h.bus.listenerCount('pump') !== baseline && Date.now() < cleanupDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(h.bus.listenerCount('pump')).toBe(baseline);
    // The controller was asked exactly once and nothing was cancelled or re-sent.
    expect(h.controller.requests).toEqual([{ cmd: 'on', duration_s: 10 }]);
  });
});

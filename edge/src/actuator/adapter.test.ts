import dgram from 'node:dgram';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockActuator, type MockActuator } from '../coap/mock-actuator.js';
import type { Command } from '../types.js';
import {
  ActuatorExpiredError,
  ActuatorTimeoutError,
  buildPutPayload,
  createCoapActuatorAdapter,
  parsePutReply,
  parseStateReply,
  ActuatorProtocolError,
} from './adapter.js';

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

function cmd(over: Partial<Command> = {}): Command {
  return {
    id: '6f1c2b1e-0000-4000-8000-0000000000a1',
    ts: new Date().toISOString(),
    type: 'pump_on',
    state: 'pending',
    expires_at: new Date(Date.now() + 30_000).toISOString(),
    ack_ts: null,
    max_s: 15,
    attempts: 0,
    trigger: 'manual',
    reason: 'test',
    last_error: null,
    ...over,
  };
}

let actuator: MockActuator | null = null;
afterEach(async () => {
  await actuator?.close();
  actuator = null;
});

async function start(opts: { neverAck?: boolean } = {}): Promise<number> {
  const port = await freeUdpPort();
  actuator = createMockActuator({ host: HOST, port, log: silent, ...opts });
  await actuator.listen();
  return port;
}

describe('payload and reply shapes', () => {
  it('builds PUT bodies per docs/API.md', () => {
    const c = cmd();
    expect(buildPutPayload(c)).toEqual({ cmd: 'on', max_s: 15, id: c.id, exp: c.expires_at });
    expect(buildPutPayload({ ...c, type: 'pump_off', max_s: null })).toEqual({
      cmd: 'off',
      id: c.id,
      exp: c.expires_at,
    });
    expect(() => buildPutPayload(cmd({ max_s: 0 }))).toThrow(ActuatorProtocolError);
    expect(() => buildPutPayload(cmd({ type: 'pump_query' }))).toThrow(ActuatorProtocolError);
  });

  it('decodes PUT and GET replies, rejecting mismatched ids and bad bodies', () => {
    expect(parsePutReply('2.04', '{"id":"x","pump":"on","remaining_s":15}', 'x')).toEqual({
      command_id: 'x',
      pump: 'on',
      remaining_s: 15,
    });
    expect(() => parsePutReply('2.04', '{"id":"y","pump":"on"}', 'x')).toThrow(ActuatorProtocolError);
    expect(() => parsePutReply('2.04', 'not json', 'x')).toThrow(ActuatorProtocolError);
    expect(() => parsePutReply('4.08', '', 'x')).toThrow(ActuatorExpiredError);
    expect(parseStateReply('2.05', '{"id":null,"pump":"off","remaining_s":0}')).toEqual({
      command_id: null,
      pump: 'off',
      remaining_s: 0,
    });
  });
});

describe('CoAP adapter against the mock actuator', () => {
  it('sends pump_on and receives the ack; duplicate id replays without re-running', async () => {
    const port = await start();
    const adapter = createCoapActuatorAdapter({ host: HOST, port, timeoutMs: 2000 });
    const c = cmd();
    const first = await adapter.send(c);
    expect(first).toMatchObject({ command_id: c.id, pump: 'on' });
    const again = await adapter.send(c);
    expect(again).toMatchObject({ command_id: c.id, pump: 'on' });

    const state = await adapter.query();
    expect(state.pump).toBe('on');
  });

  it('pump_off is acked as off', async () => {
    const port = await start();
    const adapter = createCoapActuatorAdapter({ host: HOST, port, timeoutMs: 2000 });
    const ack = await adapter.send(cmd({ type: 'pump_off', max_s: null }));
    expect(ack.pump).toBe('off');
  });

  it('actuator 4.08 (command expired) maps to ActuatorExpiredError', async () => {
    const port = await start();
    // Adapter's own clock is behind the expiry (so it sends), the mock's real clock is past it (4.08).
    const adapter = createCoapActuatorAdapter({ host: HOST, port, timeoutMs: 2000, clock: { now: () => Date.now() - 10_000 } });
    const c = cmd({ expires_at: new Date(Date.now() - 5_000).toISOString() });
    await expect(adapter.send(c)).rejects.toBeInstanceOf(ActuatorExpiredError);
  });

  it('never sends an already-expired command (local check, no traffic)', async () => {
    const port = await start();
    const adapter = createCoapActuatorAdapter({ host: HOST, port, timeoutMs: 2000 });
    await expect(adapter.send(cmd({ expires_at: new Date(Date.now() - 1000).toISOString() }))).rejects.toBeInstanceOf(
      ActuatorExpiredError,
    );
  });

  it('no reply within ACTUATOR_TIMEOUT_MS maps to ActuatorTimeoutError', async () => {
    const port = await start({ neverAck: true });
    const adapter = createCoapActuatorAdapter({ host: HOST, port, timeoutMs: 300 });
    const started = Date.now();
    await expect(adapter.send(cmd())).rejects.toBeInstanceOf(ActuatorTimeoutError);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

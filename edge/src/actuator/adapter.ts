/**
 * The ONLY file that knows actuator path/payload shapes (docs/API.md "Actuator").
 *   PUT /pump {"cmd":"on","max_s":n,"id":"<uuid>","exp":"<ISO>"}  → 2.04 {"id","pump","remaining_s"}
 *   PUT /pump {"cmd":"off","id":"<uuid>","exp":"<ISO>"}           → 2.04 {"id","pump"}
 *   GET /pump                                                     → 2.05 {"id"|null,"pump","remaining_s"}
 * A PUT rejected with 4.08 means the actuator considered the command expired.
 */
import { request } from 'coap';
import { z } from 'zod';
import type { ActuatorAck, ActuatorAdapter, Command } from '../types.js';
import { systemClock, type Clock } from './clock.js';

export const PUMP_PATH = '/pump';
export const MAX_RUN_S = 600;

export class ActuatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
/** No reply within the adapter timeout (or transport error). Outcome at the actuator is unknown. */
export class ActuatorTimeoutError extends ActuatorError {}
/** Command expiry passed (checked locally, or actuator replied 4.08). Nothing was applied. */
export class ActuatorExpiredError extends ActuatorError {}
/** Actuator replied with a non-2.xx code other than 4.08. */
export class ActuatorRejectedError extends ActuatorError {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}
/** Reply body did not match the contract (or referenced another command id). */
export class ActuatorProtocolError extends ActuatorError {}

export type PutPayload =
  | { cmd: 'on'; max_s: number; id: string; exp: string }
  | { cmd: 'off'; id: string; exp: string };

/** Build the PUT body for a pump_on/pump_off command. Throws for other types. */
export function buildPutPayload(cmd: Command): PutPayload {
  if (cmd.type === 'pump_on') {
    if (cmd.max_s === null || !Number.isInteger(cmd.max_s) || cmd.max_s < 1 || cmd.max_s > MAX_RUN_S) {
      throw new ActuatorProtocolError(`pump_on needs max_s 1..${MAX_RUN_S}, got ${String(cmd.max_s)}`);
    }
    return { cmd: 'on', max_s: cmd.max_s, id: cmd.id, exp: cmd.expires_at };
  }
  if (cmd.type === 'pump_off') {
    return { cmd: 'off', id: cmd.id, exp: cmd.expires_at };
  }
  throw new ActuatorProtocolError(`${cmd.type} is not sent with PUT /pump`);
}

const PutReply = z.object({
  id: z.string(),
  pump: z.enum(['on', 'off']),
  remaining_s: z.number().optional(),
});
const StateReply = z.object({
  id: z.string().nullable(),
  pump: z.enum(['on', 'off']),
  remaining_s: z.number().optional(),
});

function withRemaining(base: { command_id: string | null; pump: 'on' | 'off' }, remaining?: number): ActuatorAck {
  return remaining === undefined ? base : { ...base, remaining_s: remaining };
}

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ActuatorProtocolError('reply body is not JSON');
  }
}

/** Decode a PUT reply. `expectId` must match the reply id. */
export function parsePutReply(code: string, body: string, expectId: string): ActuatorAck {
  if (code === '4.08') throw new ActuatorExpiredError('actuator replied 4.08 (command expired)');
  if (!code.startsWith('2.')) throw new ActuatorRejectedError(code, `actuator replied ${code}`);
  const r = PutReply.safeParse(parseBody(body));
  if (!r.success) throw new ActuatorProtocolError(`unexpected PUT reply: ${r.error.message}`);
  if (r.data.id !== expectId) throw new ActuatorProtocolError(`reply id ${r.data.id} != ${expectId}`);
  return withRemaining({ command_id: r.data.id, pump: r.data.pump }, r.data.remaining_s);
}

/** Decode a GET reply. Id is the actuator's last-known command id, not the query's. */
export function parseStateReply(code: string, body: string): ActuatorAck {
  if (!code.startsWith('2.')) throw new ActuatorRejectedError(code, `actuator replied ${code}`);
  const r = StateReply.safeParse(parseBody(body));
  if (!r.success) throw new ActuatorProtocolError(`unexpected state reply: ${r.error.message}`);
  return withRemaining({ command_id: r.data.id, pump: r.data.pump }, r.data.remaining_s);
}

export interface CoapActuatorOptions {
  host: string;
  port: number;
  /** ACTUATOR_TIMEOUT_MS: per-exchange deadline. */
  timeoutMs: number;
  /** Injected clock for the local expiry check (never Date.now directly). */
  clock?: Pick<Clock, 'now'>;
}

interface RawReply {
  code: string;
  body: string;
}

function exchange(opts: CoapActuatorOptions, method: 'GET' | 'PUT', body: string | undefined): Promise<RawReply> {
  return new Promise<RawReply>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    timer = setTimeout(() => {
      finish(() => reject(new ActuatorTimeoutError(`no reply from actuator within ${opts.timeoutMs} ms`)));
    }, opts.timeoutMs);

    const req = request({
      host: opts.host,
      port: opts.port,
      pathname: PUMP_PATH,
      method,
      confirmable: true,
      agent: false,
      options: body !== undefined ? { 'Content-Format': 'application/json' } : undefined,
    });
    // Late responses/errors after the timeout are ignored; the listeners keep the client from throwing.
    req.on('response', (res) => {
      finish(() => resolve({ code: String(res.code), body: res.payload.toString('utf8') }));
    });
    req.on('error', (err: Error) => {
      finish(() => reject(new ActuatorTimeoutError(`transport error: ${err.message}`)));
    });
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

/** CoAP implementation of the ActuatorAdapter port. */
export function createCoapActuatorAdapter(opts: CoapActuatorOptions): ActuatorAdapter {
  const clock = opts.clock ?? systemClock;
  return {
    async send(cmd: Command): Promise<ActuatorAck> {
      const payload = buildPutPayload(cmd);
      if (clock.now() >= Date.parse(cmd.expires_at)) {
        throw new ActuatorExpiredError(`${cmd.id} expired; not sent`);
      }
      const reply = await exchange(opts, 'PUT', JSON.stringify(payload));
      return parsePutReply(reply.code, reply.body, cmd.id);
    },
    async query(): Promise<ActuatorAck> {
      const reply = await exchange(opts, 'GET', undefined);
      return parseStateReply(reply.code, reply.body);
    },
  };
}

import type {
  CalibrateResult,
  IrrigationEvent,
  Latest,
  PumpAccepted,
  Reading,
  Settings,
  Status,
} from '../types.js';
import { log } from './log.js';

export class ApiError extends Error {
  readonly status: number;
  /** Machine code: 409 pump codes (manual_pending, run_active, pump_on, daily_cap_reached) or API error code. */
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const TOKEN_KEY = 'greenhouse.apiToken';

export function loadToken(): string {
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveToken(token: string): boolean {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
    return true;
  } catch {
    return false; // storage blocked (private mode / policy): token lives for this page only
  }
}

async function parseError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  let message = res.statusText || `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { code?: unknown; error?: unknown; message?: unknown };
    if (typeof body.code === 'string') code = body.code;
    else if (typeof body.error === 'string') code = body.error;
    if (typeof body.message === 'string') message = body.message;
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(res.status, code, message);
}

interface RequestOpts extends RequestInit {
  token?: string;
  /** Client-side wait limit. Aborting only stops waiting; the server action is not cancelled. */
  timeoutMs?: number;
}

async function request<T>(path: string, init: RequestOpts = {}): Promise<T> {
  const { token, timeoutMs, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (rest.body !== undefined) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const ctrl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    let res: Response;
    try {
      res = await fetch(path, { ...rest, headers, cache: 'no-store', signal: ctrl.signal });
    } catch (err) {
      if (ctrl.signal.aborted) throw new ApiError(0, 'timeout', 'No answer in time. Check status before retrying.');
      log.warn({ path, err: String(err) }, 'network error');
      throw new ApiError(0, 'network', 'Cannot reach the edge service');
    }
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (ctrl.signal.aborted) throw new ApiError(0, 'timeout', 'No answer in time. Check status before retrying.');
    throw new ApiError(0, 'network', 'Response could not be read');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const api = {
  status: () => request<Status>('/api/status'),
  latest: () => request<Latest>('/api/latest'),
  readings: (q: { from: string; to: string; limit?: number; node_id?: string }) => {
    const p = new URLSearchParams({ from: q.from, to: q.to, limit: String(q.limit ?? 1000) });
    if (q.node_id) p.set('node_id', q.node_id);
    return request<{ readings: Reading[] }>(`/api/readings?${p.toString()}`);
  },
  events: (limit = 10) => request<{ events: IrrigationEvent[] }>(`/api/events?limit=${limit}`),
  settings: () => request<Settings>('/api/settings'),
  putSettings: (token: string, patch: Partial<Settings>) =>
    request<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch), token }),
  /**
   * POST /api/pump with `?wait_ms`. 200 = settled (acked/failed/expired), 202 = still pending.
   * `id` is the idempotency key: reuse it on retry.
   */
  pump: (
    token: string,
    body: { cmd: 'on'; duration_s: number } | { cmd: 'off' },
    id: string,
    opts: { waitMs?: number; timeoutMs?: number } = {},
  ) =>
    request<PumpAccepted>(`/api/pump?wait_ms=${opts.waitMs ?? 4000}`, {
      method: 'POST',
      body: JSON.stringify({ ...body, id }),
      token,
      timeoutMs: opts.timeoutMs ?? 8000,
    }),
  calibrate: (token: string, which: 'dry' | 'wet') =>
    request<CalibrateResult>(`/api/calibrate/${which}`, { method: 'POST', body: '{}', token }),
};

/** RFC 4122 v4 id; works on non-secure LAN origins where crypto.randomUUID is missing. */
export function uuid4(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

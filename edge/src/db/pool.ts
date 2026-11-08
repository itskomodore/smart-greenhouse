import pg, { type Pool } from 'pg';
import type { Logger } from '../log.js';

export interface PoolTimeouts {
  /** Per-statement server-side limit and client-side query limit. */
  queryTimeoutMs: number;
  /** Time allowed to acquire/establish a connection. */
  connectTimeoutMs: number;
}

export const DEFAULT_TIMEOUTS: PoolTimeouts = { queryTimeoutMs: 5000, connectTimeoutMs: 3000 };

export function createPool(
  connectionString: string,
  max: number,
  log: Logger,
  timeouts: PoolTimeouts = DEFAULT_TIMEOUTS,
): Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: timeouts.connectTimeoutMs,
    query_timeout: timeouts.queryTimeoutMs,
    statement_timeout: timeouts.queryTimeoutMs,
    idleTimeoutMillis: 30_000,
  });
  // Idle client errors (server restart, network) must not crash the process.
  pool.on('error', (err) => log.error({ err }, 'postgres idle client error'));
  return pool;
}

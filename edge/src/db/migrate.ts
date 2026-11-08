import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { createLogger } from '../log.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Migrations live next to this file (src/db/migrations). Falls back to the src tree when run from dist/. */
export function defaultMigrationsDir(): string {
  const local = join(here, 'migrations');
  if (existsSync(local)) return local;
  return join(here, '..', '..', 'src', 'db', 'migrations');
}

const LOCK_KEY = 'greenhouse.schema_migrations';
const FILE_RE = /^\d+_[\w-]+\.sql$/;

export interface MigrationFile { name: string; sql: string }

export function listMigrations(dir: string = defaultMigrationsDir()): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
}

/**
 * Apply pending `NNN_name.sql` files in filename order. Each file runs in its own transaction
 * together with its schema_migrations row; a failure rolls that file back and throws.
 * A session advisory lock prevents concurrent migrators (e.g. two services booting at once).
 * Returns the names applied in this call.
 */
export async function migrate(
  pool: Pool,
  opts: { dir?: string; log?: ReturnType<typeof createLogger> } = {},
): Promise<string[]> {
  const log = opts.log ?? createLogger('db.migrate');
  const files = listMigrations(opts.dir);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const known = new Set(files.map((f) => f.name));
    for (const name of done) {
      if (!known.has(name)) log.warn({ migration: name }, 'applied migration has no file on disk');
    }
    for (const f of files) {
      if (done.has(f.name)) continue;
      await applyOne(client, f);
      applied.push(f.name);
      log.info({ migration: f.name }, 'migration applied');
    }
    if (applied.length === 0) log.info('schema up to date');
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

async function applyOne(client: PoolClient, f: MigrationFile): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(f.sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f.name]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw new Error(`migration ${f.name} failed: ${(err as Error).message}`, { cause: err });
  }
}

// CLI: `pnpm migrate`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { loadDbConfig } = await import('../config/index.js');
  const { createPool } = await import('./pool.js');
  const log = createLogger('db.migrate');
  const cfg = loadDbConfig();
  const pool = createPool(cfg.DATABASE_URL, cfg.DB_POOL_MAX, log, {
    queryTimeoutMs: cfg.DB_QUERY_TIMEOUT_MS,
    connectTimeoutMs: cfg.DB_CONNECT_TIMEOUT_MS,
  });
  try {
    await migrate(pool, { log });
  } catch (err) {
    log.error({ err }, 'migration failed');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

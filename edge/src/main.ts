/**
 * Edge entry point. Boot order:
 *   .env → config → signal handlers → db pool → migrations (bounded, retried in background) →
 *   buffered repo → HTTP API → controller (bounded start) → CoAP ingest →
 *   retention job + outbox pump + DB probe timers.
 * Shutdown (SIGTERM/SIGINT, also during boot): stop accepting → controller stop → pump OFF (best
 * effort, bounded) → CoAP close → timers off → pool close → exit. Unhandled rejections are logged
 * and never exit the process.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApi, type Api } from './api/app.js';
import { getNetworkInfo } from './api/network.js';
import { errorMessage, tryWithin } from './api/deadline.js';
import type { ApiRepo } from './api/deps.js';
import { createShutdown, pumpOffBestEffort } from './api/shutdown.js';
import { createCoapActuatorAdapter } from './actuator/adapter.js';
import { bus } from './bus.js';
import { createCloudGateway } from './cloud/gateway.js';
import { pumpOutbox } from './cloud/outbox.js';
import { ConfigError, bootSettingsDefaults, loadConfig } from './config/index.js';
import { Controller } from './controller/loop.js';
import { createCoapIngestServer, type CoapIngestServer } from './coap/server.js';
import { BufferedRepo } from './db/buffered-repo.js';
import { migrate } from './db/migrate.js';
import { PgRepo } from './db/pg-repo.js';
import { createPool } from './db/pool.js';
import { startRetentionJob, type RetentionJob } from './db/retention.js';
import { createLogger, type Logger } from './log.js';

type Config = ReturnType<typeof loadConfig>;

const MIGRATE_BOOT_WAIT_MS = 15_000;
const MIGRATE_RETRY_MS = 10_000;
const CONTROLLER_START_DEADLINE_MS = 30_000;
const DB_PROBE_MS = 5_000;
const OUTBOX_PUMP_MS = 60_000;
const PUMP_OFF_SEND_MS = 1_500;
const PUMP_OFF_WAIT_MS = 3_000;
const CLOSE_STEP_MS = 5_000;
const SHUTDOWN_HARD_LIMIT_MS = 20_000;

function loadDotEnv(): void {
  const path = resolve(process.cwd(), '.env');
  if (existsSync(path)) process.loadEnvFile(path);
}

async function main(): Promise<void> {
  let envError: unknown = null;
  try {
    loadDotEnv();
  } catch (err) {
    envError = err;
  }
  const log = createLogger('main');
  if (envError !== null) {
    log.fatal({ err: errorMessage(envError) }, 'could not load .env');
    process.exit(1);
  }

  process.on('unhandledRejection', (reason: unknown) => {
    log.error({ err: errorMessage(reason) }, 'unhandled promise rejection (process kept alive)');
  });
  process.on('uncaughtException', (err: Error) => {
    log.fatal({ err: err.message, stack: err.stack }, 'uncaught exception; exiting');
    process.exit(1);
  });

  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) log.fatal({ issues: err.issues }, 'invalid configuration');
    else log.fatal({ err: errorMessage(err) }, 'invalid configuration');
    process.exit(1);
  }

  // ───── handles shutdown releases (each may still be null if boot has not got that far) ─────
  const pool = createPool(cfg.DATABASE_URL, cfg.DB_POOL_MAX, createLogger('db.pool'), {
    queryTimeoutMs: cfg.DB_QUERY_TIMEOUT_MS,
    connectTimeoutMs: cfg.DB_CONNECT_TIMEOUT_MS,
  });
  let controller: Controller | null = null;
  let api: Api | null = null;
  let coap: CoapIngestServer | null = null;
  let retention: RetentionJob | null = null;
  let migrateRetry: NodeJS.Timeout | null = null;
  const timers: NodeJS.Timeout[] = [];
  let shuttingDown = false;

  const shutdown = createShutdown({
    log,
    exit: (code) => process.exit(code),
    stepMs: CLOSE_STEP_MS,
    hardLimitMs: SHUTDOWN_HARD_LIMIT_MS,
    steps: {
      stopBackground: () => {
        if (migrateRetry) clearInterval(migrateRetry);
        for (const t of timers) clearInterval(t);
        retention?.stop();
      },
      closeHttp: async () => {
        if (api) await api.close();
      },
      stopControl: () => controller?.stop(),
      pumpOff: async () => {
        if (controller) await pumpOffBestEffort(controller, bus, log.child({ part: 'shutdown' }), {
          sendMs: PUMP_OFF_SEND_MS,
          confirmMs: PUMP_OFF_WAIT_MS,
        });
      },
      closeIngest: async () => {
        if (coap) await coap.close();
      },
      closePool: () => pool.end(),
    },
  });
  const onSignal = (signal: string): void => {
    shuttingDown = true; // boot checks this flag after each await and stops starting components
    void shutdown(signal);
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  // ───── repo stack ─────
  const settingsDefaults = bootSettingsDefaults(cfg);
  const buffered = new BufferedRepo(new PgRepo(pool, { settingsDefaults }), {
    maxBuffer: cfg.DB_BUFFER_MAX,
    bus,
    log: createLogger('db.buffered'),
    settingsFallback: settingsDefaults,
  });

  // ───── migrations: bounded at boot, retried in the background ─────
  let migrating = false;
  const migrateOnce = async (): Promise<boolean> => {
    if (migrating) return false;
    migrating = true;
    try {
      const applied = await migrate(pool, { log: createLogger('db.migrate') });
      log.info({ applied: applied.length }, 'schema ready');
      return true;
    } catch (err) {
      log.error({ err: errorMessage(err) }, 'migration failed');
      return false;
    } finally {
      migrating = false;
    }
  };
  const firstMigrate = await tryWithin(migrateOnce(), MIGRATE_BOOT_WAIT_MS);
  if (shuttingDown) return;
  if (!(firstMigrate.ok && firstMigrate.value)) {
    log.warn('schema not confirmed at boot; continuing (readings buffer) and retrying migrations');
    migrateRetry = setInterval(() => {
      void migrateOnce().then((ok) => {
        if (ok && migrateRetry) {
          clearInterval(migrateRetry);
          migrateRetry = null;
        }
      });
    }, MIGRATE_RETRY_MS);
    migrateRetry.unref();
  }

  // ───── HTTP API (listens before the controller start so status is visible during boot) ─────
  const apiRepo: ApiRepo = {
    latestReading: (node_id) => buffered.latestReading(node_id),
    readings: (q) => buffered.readings(q),
    nodeLastSeen: () => buffered.nodeLastSeen(),
    getSettings: () => buffered.getSettings(),
    putSettings: (patch) => buffered.putSettings(patch),
    recentEvents: (limit) => buffered.recentEvents(limit),
    activeAlarms: () => buffered.activeAlarms(),
    getCommand: (id) => buffered.getCommand(id),
    dbUp: () => buffered.status().up,
  };
  controller = new Controller({
    repo: buffered,
    adapter: createCoapActuatorAdapter({
      host: cfg.ACTUATOR_HOST,
      port: cfg.ACTUATOR_PORT,
      timeoutMs: cfg.ACTUATOR_TIMEOUT_MS,
    }),
    bus,
    tickMs: cfg.RULES_TICK_MS,
    log: createLogger('controller'),
  });

  try {
    api = await createApi({
      repo: apiRepo,
      controller,
      bus,
      apiToken: cfg.API_TOKEN,
      dashboardDir: resolve(process.cwd(), cfg.DASHBOARD_DIR),
      network: () => getNetworkInfo(cfg.COAP_PORT, cfg.THREAD_IFACE),
      log: createLogger('api'),
    });
    await api.app.listen({ host: cfg.HTTP_HOST, port: cfg.HTTP_PORT });
    log.info({ host: cfg.HTTP_HOST, port: cfg.HTTP_PORT }, 'http api listening');
  } catch (err) {
    log.fatal({ err: errorMessage(err) }, 'http api failed to start');
    process.exit(1);
  }
  if (shuttingDown) return;

  // ───── sensor ingest ─────
  try {
    coap = createCoapIngestServer({
      repo: buffered,
      getSettings: () => buffered.getSettings(),
      bus,
      log: createLogger('coap'),
    });
    await coap.listen(cfg.COAP_PORT, cfg.COAP_HOST);
  } catch (err) {
    log.fatal({ err: errorMessage(err) }, 'coap ingest failed to bind');
    process.exit(1);
  }
  if (shuttingDown) return;

  // ───── control: bounded start, then the tick timer ─────
  // Sensor ingest is already listening, so boot-time readings are stored. The controller only
  // subscribes in start(): it keeps latest=null until a live reading, so it cannot act on stale data.
  // Each DB call inside start() has its own deadline, so this completes even with a dead DB.
  // The outer deadline only bounds how long boot waits; start() keeps going and arms the timer.
  const started = await tryWithin(controller.start({ autoTick: true }), CONTROLLER_START_DEADLINE_MS);
  if (started.ok) log.info({ tick_ms: cfg.RULES_TICK_MS }, 'controller running');
  else log.error({ err: errorMessage(started.error) }, 'controller start did not complete cleanly');
  if (shuttingDown) return;

  // ───── background jobs ─────
  retention = startRetentionJob({ repo: buffered, log: createLogger('db.retention') });

  const gateway = createCloudGateway(cfg.CLOUD_ENABLED, createLogger('cloud'));
  const outboxLog = createLogger('cloud.outbox');
  timers.push(
    setInterval(() => {
      pumpOutbox({ repo: buffered, gateway, log: outboxLog }).catch((err: unknown) =>
        outboxLog.error({ err: errorMessage(err) }, 'outbox pump failed'),
      );
    }, OUTBOX_PUMP_MS),
  );
  // Probe while the DB is down: recover() flushes the in-memory ring; it is a no-op when healthy.
  timers.push(
    setInterval(() => {
      buffered.recover().catch((err: unknown) => log.error({ err: errorMessage(err) }, 'db probe failed'));
    }, DB_PROBE_MS),
  );
  for (const t of timers) t.unref();

  log.info({ coap_port: cfg.COAP_PORT, http_port: cfg.HTTP_PORT }, 'edge running');
}

main().catch((err: unknown) => {
  createLogger('main').fatal({ err: errorMessage(err) }, 'startup failed');
  process.exit(1);
});

import { createLogger, type Logger } from '../log.js';
import type { Repo, Settings } from '../types.js';

export interface RetentionDeps {
  repo: Pick<Repo, 'purgeOlderThan' | 'getSettings'>;
  log?: Logger;
}

/**
 * One purge pass: deletes readings older than `settings.retention_days`.
 * Returns the number of rows removed (0 when retention_days is not a positive number).
 */
export async function runRetention({ repo, log = createLogger('db.retention') }: RetentionDeps): Promise<number> {
  const settings: Settings = await repo.getSettings();
  const days = settings.retention_days;
  if (!Number.isFinite(days) || days < 1) {
    log.warn({ retention_days: days }, 'retention disabled (retention_days < 1)');
    return 0;
  }
  const { readings } = await repo.purgeOlderThan(days);
  log.info({ retention_days: days, readings_deleted: readings }, 'retention purge done');
  return readings;
}

export interface RetentionJob {
  runNow(): Promise<number>;
  stop(): void;
}

/**
 * Periodic purge. Runs once at start (after `initialDelayMs`), then every `intervalMs`.
 * Overlapping runs are skipped. Errors are logged, never thrown into the process.
 * Timer is unref'd so it does not keep the process alive.
 */
export function startRetentionJob(
  deps: RetentionDeps,
  opts: { intervalMs?: number; initialDelayMs?: number } = {},
): RetentionJob {
  const log = deps.log ?? createLogger('db.retention');
  const intervalMs = opts.intervalMs ?? 6 * 60 * 60 * 1000;
  let running: Promise<number> | null = null;

  const runNow = (): Promise<number> => {
    if (running) return running;
    running = runRetention({ ...deps, log })
      .catch((err: unknown) => {
        log.error({ err }, 'retention purge failed');
        return 0;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };

  const first = setTimeout(() => void runNow(), opts.initialDelayMs ?? 60_000);
  const timer = setInterval(() => void runNow(), intervalMs);
  first.unref();
  timer.unref();

  return {
    runNow,
    stop: () => {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}

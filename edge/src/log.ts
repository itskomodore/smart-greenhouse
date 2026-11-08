import pino, { type Logger } from 'pino';

/**
 * Pino JSON logger factory. Never use console.* in edge code.
 * Level defaults to LOG_LEVEL env (or 'info'); callers may override.
 */
export type { Logger };

export function createLogger(component: string, level?: string): Logger {
  return pino({
    level: level ?? process.env.LOG_LEVEL ?? 'info',
    base: { component },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/**
 * Minimal structured logger: one JSON object per line, no dependency.
 * warn/error go to console.warn, info/debug to console.info (never console.log).
 */
type Fields = Record<string, unknown>;

function emit(level: 'info' | 'warn', fields: Fields, msg: string): void {
  const line = JSON.stringify({ level, time: new Date().toISOString(), app: 'greenhouse-dashboard', msg, ...fields });
  if (level === 'warn') console.warn(line);
  else console.info(line);
}

export const log = {
  info: (fields: Fields, msg: string) => emit('info', fields, msg),
  warn: (fields: Fields, msg: string) => emit('warn', fields, msg),
};

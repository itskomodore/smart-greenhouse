import type { Alarm, AlarmCode } from '../types.js';
import { useLive } from '../lib/live.js';

const TITLES: Record<AlarmCode, string> = {
  sensor_stale: 'Sensor data is stale',
  actuator_unreachable: 'Pump controller unreachable',
  pump_failed: 'Pump command failed',
  actuator_state_unknown: 'Pump state unknown',
  soil_jump_ignored: 'Implausible soil reading ignored',
  daily_cap_reached: 'Daily irrigation cap reached',
  db_down: 'Database unavailable',
};

export function alarmTitle(code: AlarmCode): string {
  return TITLES[code] ?? code;
}

export function AlarmBanner() {
  const { alarms, mode, status } = useLive();
  const items: { key: string; title: string; detail: string; critical: boolean }[] = alarms.map((a: Alarm) => ({
    key: a.code,
    title: alarmTitle(a.code),
    detail: a.message,
    critical: a.severity === 'critical',
  }));
  if (mode === 'offline') {
    items.unshift({
      key: 'dashboard_offline',
      title: 'Cannot reach the edge service',
      detail: 'Showing the last values received. Retrying.',
      critical: true,
    });
  }
  if (status && status.db === false && !items.some((i) => i.key === 'db_down')) {
    items.push({ key: 'db_down', title: alarmTitle('db_down'), detail: 'Readings are buffered in memory.', critical: true });
  }

  if (items.length === 0) return <div className="alarms" aria-live="polite" />;

  const critical = items.some((i) => i.critical);
  return (
    <section
      className={`alarms ${critical ? 'alarms-critical' : 'alarms-warn'}`}
      aria-label="Active alarms"
      aria-live={critical ? 'assertive' : 'polite'}
      role={critical ? 'alert' : 'status'}
    >
      <ul>
        {items.map((i) => (
          <li key={i.key}>
            <strong>{i.title}.</strong> <span>{i.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

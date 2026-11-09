import type { IrrigationEvent } from '../types.js';
import { fmtDuration, fmtTime, roundPercentText } from '../lib/format.js';
import { useLive, useTick } from '../lib/live.js';

const RESULT_LABEL: Record<IrrigationEvent['result'], string> = {
  running: 'running',
  completed: 'completed',
  stopped: 'stopped',
  failed: 'failed',
  aborted: 'aborted',
};

export function eventDurationS(e: IrrigationEvent, nowMs: number): number | null {
  const start = Date.parse(e.ts_start);
  if (Number.isNaN(start)) return null;
  const end = e.ts_end ? Date.parse(e.ts_end) : e.result === 'running' ? nowMs : NaN;
  if (Number.isNaN(end)) return null;
  return Math.max(0, (end - start) / 1000);
}

export function EventsList() {
  const { events, serverNow } = useLive();
  useTick(5000);
  const now = serverNow();
  return (
    <section className="card events" aria-labelledby="events-title">
      <h2 id="events-title">Last 10 irrigation events</h2>
      {events.length === 0 ? (
        <p className="hint">No irrigation events yet.</p>
      ) : (
        <ol className="event-list">
          {events.slice(0, 10).map((e, i) => (
            <li key={e.id ?? `${e.ts_start}-${i}`} className={`ev ev-${e.result}`}>
              <div className="ev-top">
                <time dateTime={e.ts_start}>{fmtTime(e.ts_start)}</time>
                <span className="badge">{e.trigger}</span>
                <span className={`badge badge-${e.result}`}>{RESULT_LABEL[e.result]}</span>
              </div>
              <div className="ev-body">
                <span>{e.reason ? roundPercentText(e.reason) : 'no reason recorded'}</span>
                <span className="muted"> · {fmtDuration(eventDurationS(e, now))}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

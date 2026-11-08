import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Command } from '../types.js';
import { api, ApiError, uuid4 } from '../lib/api.js';
import { clampDuration, fmtDuration, fmtTime } from '../lib/format.js';
import { useLive, useTick } from '../lib/live.js';
import { log } from '../lib/log.js';
import { commandResult, pumpGate } from '../lib/pumpState.js';
import type { PumpCmd, PumpResult } from '../lib/pumpState.js';

interface Props {
  token: string;
}

type PumpBody = { cmd: 'on'; duration_s: number } | { cmd: 'off' };

interface Pending {
  body: PumpBody;
  clampedTo?: number;
  id: string;
}

type Outcome =
  | { kind: 'result'; result: PumpResult; duplicate: boolean; clampedTo?: number }
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'error'; message: string };

const CMD_TEXT: Record<Command['state'], string> = {
  pending: 'Queued: waiting for the pump controller',
  sent: 'Sent to pump controller, awaiting acknowledgement',
  acked: 'Acknowledged by pump controller',
  failed: 'Failed',
  expired: 'Expired before the pump responded',
};

const REFUSAL_TEXT: Record<string, string> = {
  manual_pending: 'Another manual command is already pending.',
  run_active: 'A pump run is already active.',
  pump_on: 'Pump is already on.',
  daily_cap_reached: 'Daily irrigation limit reached.',
  db_unavailable: 'Database unavailable. The command was not stored; retry with the same request.',
  superseded: 'A newer command replaced this one.',
};

/** Codes where re-sending the same request (same idempotency id) is safe. */
const RETRYABLE = new Set(['db_unavailable', 'controller_busy']);

export function CommandView({ command }: { command: Command }) {
  const failed = command.state === 'failed' || command.state === 'expired';
  return (
    <div className={`cmd cmd-${command.state}`}>
      <p>
        <strong>{command.type === 'pump_on' ? 'ON' : command.type === 'pump_off' ? 'OFF' : 'Query'}</strong>{' '}
        <span className="badge">{command.state}</span>{' '}
        {command.max_s !== null && <span className="muted">max {command.max_s}s</span>}
      </p>
      <p className="muted">{CMD_TEXT[command.state]}</p>
      {failed && command.last_error && <p className="error">Reason: {command.last_error}</p>}
      <p className="meta">
        Sent {fmtTime(command.ts)} · attempts {command.attempts} · trigger {command.trigger}
        {command.reason ? ` · ${command.reason}` : ''}
      </p>
    </div>
  );
}

function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function PumpPanel({ token }: Props) {
  const { pump, settings, status, applyCommand } = useLive();
  useTick(1000);
  const [duration, setDuration] = useState('30');
  const [inflight, setInflight] = useState<{ cmd: PumpCmd; id: string } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const maxRun = settings?.max_run_s ?? null;
  const dailyUsed = status?.daily_runtime_s ?? null;
  const dailyMax = settings?.daily_max_s ?? null;
  const canWrite = token.length > 0;
  const stateLabel = pump.state === 'on' ? 'ON' : pump.state === 'off' ? 'OFF' : 'UNKNOWN';
  const gate = pumpGate({
    canWrite,
    maxRunKnown: maxRun !== null,
    inflight: inflight?.cmd ?? null,
    commandType: pump.command?.type,
    commandState: pump.command?.state,
  });

  /** `id` is the idempotency key; reused on retry so the server treats a re-send as the same command. */
  const send = async (body: PumpBody, clampedTo?: number, id: string = uuid4()) => {
    setInflight({ cmd: body.cmd, id });
    setOutcome(null);
    setPending(null);
    try {
      const r = await api.pump(token, body, id, { waitMs: 4000, timeoutMs: 8000 });
      applyCommand(r.command, r.pump);
      setOutcome({
        kind: 'result',
        result: commandResult(r.command.state, r.command.last_error, r.pump),
        duplicate: r.duplicate,
        clampedTo,
      });
      log.info({ cmd: body.cmd, state: r.command.state, duplicate: r.duplicate }, 'pump command answered');
    } catch (err) {
      let retry = false;
      if (err instanceof ApiError && err.code === 'timeout') {
        setOutcome({ kind: 'error', message: 'No answer in time. Check status before retrying; retry reuses the same request.' });
        retry = true;
      } else if (err instanceof ApiError && err.status === 409) {
        if (RETRYABLE.has(err.code)) {
          setOutcome({ kind: 'error', message: REFUSAL_TEXT[err.code] ?? err.message });
          retry = true;
        } else {
          setOutcome({ kind: 'refused', code: err.code, message: REFUSAL_TEXT[err.code] ?? err.message });
        }
      } else if (err instanceof ApiError && err.status === 503) {
        const why =
          err.code === 'controller_busy'
            ? 'Pump controller is busy.'
            : err.code === 'db_unavailable'
              ? 'Database unavailable.'
              : `Service unavailable (${err.code}).`;
        setOutcome({ kind: 'error', message: `${why} Retry with the same request.` });
        retry = true;
      } else if (err instanceof ApiError && err.status === 429) {
        setOutcome({ kind: 'error', message: 'Too many requests (rate limited). Wait a moment, then try again.' });
      } else if (err instanceof ApiError && err.status === 401) {
        setOutcome({ kind: 'error', message: 'Token rejected (401). Check the API token.' });
      } else if (err instanceof ApiError && err.status === 400) {
        setOutcome({ kind: 'error', message: `Invalid request: ${err.message}` });
      } else {
        setOutcome({ kind: 'error', message: err instanceof Error ? err.message : 'Request failed' });
      }
      if (retry) setPending({ body, clampedTo, id });
      log.warn({ cmd: body.cmd, err: String(err), retry }, 'pump command failed');
    } finally {
      setInflight(null);
    }
  };

  const onOn = (e: FormEvent) => {
    e.preventDefault();
    if (maxRun === null) return;
    const raw = Number(duration);
    if (duration.trim() === '' || !Number.isFinite(raw)) {
      setOutcome({ kind: 'error', message: 'Enter a duration in seconds.' });
      return;
    }
    const clamped = clampDuration(raw, maxRun);
    void send({ cmd: 'on', duration_s: clamped }, clamped !== Math.round(raw) ? clamped : undefined);
  };

  const statusText = inflight ? (inflight.cmd === 'on' ? 'Sending ON…' : 'Sending OFF…') : '';

  return (
    <section className="card pump" aria-labelledby="pump-title">
      <h2 id="pump-title">Pump</h2>
      <div className="pump-state">
        <span className={`state state-${pump.state}`} aria-label={`Pump state ${stateLabel}`}>
          {stateLabel}
        </span>
        <span className="muted">{pump.since ? `since ${fmtTime(pump.since)}` : 'since unknown'}</span>
      </div>
      <p className="meta">
        Auto {(status?.auto_enabled ?? settings?.auto_enabled) ? 'enabled' : 'disabled'}
        {dailyUsed !== null && dailyMax !== null && (
          <>
            {' · '}today {fmtDuration(dailyUsed)} of {fmtDuration(dailyMax)}
          </>
        )}
      </p>

      <form className="pump-form" onSubmit={onOn}>
        <label htmlFor="pump-duration">Run for (seconds){maxRun !== null ? ` · 1 to ${maxRun}` : ''}</label>
        <div className="row">
          <input
            id="pump-duration"
            type="number"
            inputMode="numeric"
            min={1}
            max={maxRun ?? undefined}
            step={1}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            disabled={!canWrite || inflight !== null}
          />
          <button
            type="submit"
            className="btn"
            disabled={gate.onDisabled}
            aria-busy={inflight?.cmd === 'on' ? true : undefined}
          >
            {inflight?.cmd === 'on' ? (
              <>
                <Spinner /> Sending…
              </>
            ) : (
              'Run pump (ON)'
            )}
          </button>
        </div>
      </form>

      {/* OFF is never blocked by an ON in flight or pending; the displayed state may be stale. */}
      <button
        type="button"
        className="btn danger"
        disabled={gate.offDisabled}
        aria-busy={inflight?.cmd === 'off' ? true : undefined}
        onClick={() => void send({ cmd: 'off' })}
      >
        {inflight?.cmd === 'off' ? (
          <>
            <Spinner /> Sending…
          </>
        ) : (
          'Stop pump (OFF)'
        )}
      </button>

      <p className="live-status" role="status" aria-live="polite">
        {statusText}
      </p>
      {!canWrite && <p className="hint">Enter the API token above to control the pump.</p>}

      {outcome?.kind === 'result' && (
        <p className={`result result-${outcome.result.tone}`} role="status">
          {outcome.duplicate ? 'Duplicate request. ' : ''}
          {outcome.clampedTo !== undefined && `Duration limited to ${outcome.clampedTo} s. `}
          {outcome.result.text}
          {outcome.result.tone === 'pending' && ' Result follows via status updates.'}
        </p>
      )}
      {outcome?.kind === 'refused' && (
        <p className="error" role="alert">
          Refused ({outcome.code}): {outcome.message}
        </p>
      )}
      {outcome?.kind === 'error' && (
        <p className="error" role="alert">
          {outcome.message}
        </p>
      )}
      {pending && (
        <p className="row">
          <button
            type="button"
            className="btn ghost"
            disabled={inflight !== null}
            onClick={() => void send(pending.body, pending.clampedTo, pending.id)}
          >
            Retry same request
          </button>
        </p>
      )}

      {pump.command ? (
        <div className="outcome">
          <p className="muted">Last command</p>
          <CommandView command={pump.command} />
        </div>
      ) : (
        <p className="muted">No pump command yet.</p>
      )}
    </section>
  );
}

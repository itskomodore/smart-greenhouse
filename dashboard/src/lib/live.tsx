import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Alarm, Command, IrrigationEvent, Latest, PumpState, Reading, Settings, SseEvent, Status } from '../types.js';
import { api } from './api.js';
import { log } from './log.js';

export type LinkMode = 'connecting' | 'live' | 'polling' | 'offline';

export interface PumpView {
  state: PumpState;
  since: string | null;
  command: Command | null;
}

export interface LiveState {
  mode: LinkMode;
  /** Last successful fetch/event time (epoch ms, local clock). */
  lastOkMs: number | null;
  status: Status | null;
  latest: Reading | null;
  settings: Settings | null;
  events: IrrigationEvent[];
  alarms: Alarm[];
  pump: PumpView;
  /** Server clock minus local clock, ms. Used so "age" is not skewed by device clock. */
  serverNow: () => number;
  applyCommand: (cmd: Command, state?: PumpState) => void;
  applySettings: (s: Settings) => void;
  refreshEvents: () => Promise<void>;
  refreshSettings: () => Promise<void>;
}

const LiveContext = createContext<LiveState | null>(null);

const POLL_MS = 10_000;
const BACKOFF_MAX_MS = 30_000;

const EMPTY_PUMP: PumpView = { state: 'unknown', since: null, command: null };

export function LiveProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<LinkMode>('connecting');
  const [lastOkMs, setLastOkMs] = useState<number | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [latest, setLatest] = useState<Reading | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [events, setEvents] = useState<IrrigationEvent[]>([]);
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [pump, setPump] = useState<PumpView>(EMPTY_PUMP);
  const offsetRef = useRef(0);
  const pumpStateRef = useRef<PumpState | null>(null);

  const serverNow = useCallback(() => Date.now() + offsetRef.current, []);

  const markOk = useCallback(() => setLastOkMs(Date.now()), []);

  const applyStatus = useCallback((s: Status) => {
    const t = Date.parse(s.now);
    if (!Number.isNaN(t)) offsetRef.current = t - Date.now();
    setStatus(s);
    setAlarms(s.alarms);
    pumpStateRef.current = s.pump.state;
    setPump({ state: s.pump.state, since: s.pump.since, command: s.pump.command });
    markOk();
  }, [markOk]);

  const applyLatest = useCallback((l: Latest) => {
    if (l.reading) setLatest(l.reading);
    markOk();
  }, [markOk]);

  const refreshEvents = useCallback(async () => {
    try {
      const r = await api.events(10);
      setEvents(r.events);
    } catch (err) {
      log.warn({ err: String(err) }, 'events refresh failed');
    }
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      setSettings(await api.settings());
    } catch (err) {
      log.warn({ err: String(err) }, 'settings refresh failed');
    }
  }, []);

  const applyCommand = useCallback((cmd: Command, state?: PumpState) => {
    setPump((p) => ({ ...p, command: cmd, state: state ?? p.state }));
  }, []);

  const applySettings = useCallback((s: Settings) => setSettings(s), []);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let backoff = 1000;

    const pollOnce = async () => {
      try {
        const [s, l] = await Promise.all([api.status(), api.latest()]);
        if (cancelled) return;
        applyStatus(s);
        applyLatest(l);
        setMode((m) => (m === 'live' ? m : 'polling'));
      } catch (err) {
        if (cancelled) return;
        log.warn({ err: String(err) }, 'poll failed');
        setMode((m) => (m === 'live' ? m : 'offline'));
      }
    };
    const startPoll = () => {
      if (pollTimer) return;
      void pollOnce();
      pollTimer = setInterval(() => void pollOnce(), POLL_MS);
    };
    const stopPoll = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };

    const refreshAll = () => {
      void pollOnce();
      void refreshEvents();
      void refreshSettings();
    };

    const onEvent = (ev: SseEvent) => {
      markOk();
      switch (ev.type) {
        case 'reading':
          setLatest(ev.data);
          break;
        case 'pump': {
          const changed = pumpStateRef.current !== ev.data.state;
          pumpStateRef.current = ev.data.state;
          setPump((p) => ({
            state: ev.data.state,
            since: changed ? null : p.since,
            command: ev.data.command ?? p.command,
          }));
          // State flipped: pull status for the authoritative `since` timestamp.
          if (changed) void pollOnce();
          break;
        }
        case 'event':
          void refreshEvents();
          break;
        case 'alarms':
          setAlarms(ev.data);
          break;
        case 'settings':
          setSettings(ev.data);
          break;
      }
    };

    const connect = () => {
      if (cancelled) return;
      if (typeof EventSource === 'undefined') {
        setMode('polling');
        startPoll();
        return;
      }
      const src = new EventSource('/api/stream');
      es = src;
      const types: SseEvent['type'][] = ['reading', 'pump', 'event', 'alarms', 'settings'];
      for (const type of types) {
        src.addEventListener(type, (m: MessageEvent<string>) => {
          try {
            onEvent({ type, data: JSON.parse(m.data) } as SseEvent);
          } catch (err) {
            log.warn({ type, err: String(err) }, 'bad sse payload');
          }
        });
      }
      src.onopen = () => {
        backoff = 1000;
        log.info({}, 'sse connected');
        setMode('live');
        stopPoll();
        refreshAll();
      };
      src.onerror = () => {
        src.close();
        if (es === src) es = null;
        if (cancelled) return;
        log.warn({ backoffMs: backoff }, 'sse dropped; polling fallback');
        setMode('polling');
        startPoll();
        retryTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      };
    };

    refreshAll();
    startPoll();
    connect();

    return () => {
      cancelled = true;
      es?.close();
      if (retryTimer) clearTimeout(retryTimer);
      stopPoll();
    };
  }, [applyStatus, applyLatest, markOk, refreshEvents, refreshSettings]);

  const value = useMemo<LiveState>(
    () => ({
      mode,
      lastOkMs,
      status,
      latest,
      settings,
      events,
      alarms,
      pump,
      serverNow,
      applyCommand,
      applySettings,
      refreshEvents,
      refreshSettings,
    }),
    [mode, lastOkMs, status, latest, settings, events, alarms, pump, serverNow, applyCommand, applySettings, refreshEvents, refreshSettings],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveState {
  const v = useContext(LiveContext);
  if (!v) throw new Error('useLive outside LiveProvider');
  return v;
}

/** Re-renders the caller every `ms` so relative ages stay current. */
export function useTick(ms = 1000): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return n;
}

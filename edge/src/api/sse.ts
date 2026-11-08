import type { ServerResponse } from 'node:http';
import type { Logger } from '../log.js';
import type { BusEvents, SseEvent } from '../types.js';
import type { ApiBus } from './deps.js';

export const SSE_TOPICS = ['reading', 'pump', 'event', 'alarms', 'settings'] as const;
/** Writes queued behind a client this far behind are dropped and the client is disconnected. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

export interface SseHubOptions {
  bus: ApiBus;
  /** Sent to each client on connect, before any live event. */
  snapshot: () => Promise<SseEvent[]>;
  maxClients: number;
  heartbeatMs: number;
  log: Logger;
}

export interface SseHub {
  /** False when the client cap is reached (caller answers 503). */
  hasCapacity(): boolean;
  /** Takes over a raw response: writes headers, the snapshot, then live events. */
  attach(raw: ServerResponse): void;
  size(): number;
  /** Ends every stream and unsubscribes from the bus. */
  close(): void;
}

interface Client {
  raw: ServerResponse;
  /** False until the snapshot is written; live events queue up meanwhile to keep ordering. */
  ready: boolean;
  queue: SseEvent[];
  heartbeat: NodeJS.Timeout;
}

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

export function formatSse(ev: SseEvent): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`;
}

export function createSseHub(opts: SseHubOptions): SseHub {
  const clients = new Set<Client>();
  const unsubscribers: Array<() => void> = [];

  const subscribe = <K extends (typeof SSE_TOPICS)[number]>(topic: K): void => {
    const listener = (data: BusEvents[K]): void => {
      const ev = { type: topic, data } as SseEvent;
      for (const c of clients) deliver(c, ev);
    };
    opts.bus.on(topic, listener);
    unsubscribers.push(() => opts.bus.off(topic, listener));
  };
  for (const t of SSE_TOPICS) subscribe(t);

  function write(c: Client, chunk: string): void {
    if (c.raw.destroyed || c.raw.writableEnded) {
      drop(c);
      return;
    }
    try {
      c.raw.write(chunk);
    } catch {
      drop(c);
      return;
    }
    if (c.raw.writableLength > MAX_BUFFERED_BYTES) {
      opts.log.warn({ buffered: c.raw.writableLength }, 'sse client too slow; disconnecting');
      drop(c);
    }
  }

  function deliver(c: Client, ev: SseEvent): void {
    if (!c.ready) c.queue.push(ev);
    else write(c, formatSse(ev));
  }

  function drop(c: Client): void {
    if (!clients.delete(c)) return;
    clearInterval(c.heartbeat);
    c.queue = [];
    if (!c.raw.writableEnded) {
      try {
        c.raw.end();
      } catch {
        // already torn down
      }
    }
  }

  return {
    hasCapacity: () => clients.size < opts.maxClients,

    size: () => clients.size,

    attach(raw: ServerResponse): void {
      raw.writeHead(200, { ...SSE_HEADERS });
      const client: Client = {
        raw,
        ready: false,
        queue: [],
        heartbeat: setInterval(() => write(client, ': heartbeat\n\n'), opts.heartbeatMs),
      };
      client.heartbeat.unref();
      clients.add(client);
      raw.on('close', () => drop(client));
      raw.on('error', () => drop(client));
      opts.log.info({ clients: clients.size }, 'sse client connected');

      // Flush headers so the browser sees the stream open before the snapshot is ready.
      write(client, ': connected\n\n');

      opts
        .snapshot()
        .catch((err: unknown) => {
          opts.log.error({ err: err instanceof Error ? err.message : String(err) }, 'sse snapshot failed');
          return [] as SseEvent[];
        })
        .then((events) => {
          if (!clients.has(client)) return;
          for (const ev of events) write(client, formatSse(ev));
          client.ready = true;
          const queued = client.queue;
          client.queue = [];
          for (const ev of queued) write(client, formatSse(ev));
        })
        .catch((err: unknown) => {
          opts.log.error({ err: err instanceof Error ? err.message : String(err) }, 'sse write failed');
        });
    },

    close(): void {
      for (const c of [...clients]) drop(c);
      while (unsubscribers.length > 0) unsubscribers.pop()?.();
    },
  };
}

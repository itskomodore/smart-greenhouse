import { EventEmitter } from 'node:events';
import type { BusEvents } from './types.js';

/**
 * Process-wide typed event bus. Topics come from the shared `BusEvents` contract.
 * `db` is an edge-local health topic (not part of the SSE contract): emitted by BufferedRepo.
 */
export interface DbHealth {
  up: boolean;
  buffered: number;   // readings waiting in the in-memory ring
  dropped: number;    // readings dropped (ring overflow) since process start
  since: string | null;
}

export interface BusTopics extends BusEvents {
  db: DbHealth;
}

export type BusTopic = keyof BusTopics;

export interface TypedBus {
  emit<K extends BusTopic>(topic: K, payload: BusTopics[K]): boolean;
  on<K extends BusTopic>(topic: K, listener: (payload: BusTopics[K]) => void): TypedBus;
  off<K extends BusTopic>(topic: K, listener: (payload: BusTopics[K]) => void): TypedBus;
  once<K extends BusTopic>(topic: K, listener: (payload: BusTopics[K]) => void): TypedBus;
  listenerCount(topic: BusTopic): number;
}

export function createBus(): TypedBus {
  const ee = new EventEmitter();
  ee.setMaxListeners(50);
  const bus: TypedBus = {
    emit: (topic, payload) => ee.emit(topic, payload),
    on: (topic, listener) => {
      ee.on(topic, listener as (p: unknown) => void);
      return bus;
    },
    off: (topic, listener) => {
      ee.off(topic, listener as (p: unknown) => void);
      return bus;
    },
    once: (topic, listener) => {
      ee.once(topic, listener as (p: unknown) => void);
      return bus;
    },
    listenerCount: (topic) => ee.listenerCount(topic),
  };
  return bus;
}

/** Process singleton. Tests should prefer createBus(). */
export const bus: TypedBus = createBus();

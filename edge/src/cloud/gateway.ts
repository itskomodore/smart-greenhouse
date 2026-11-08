import { createLogger, type Logger } from '../log.js';
import type { CloudGateway, OutboxRow } from '../types.js';

/** Placeholder until a cloud transport exists. Accepts nothing, so the outbox keeps everything. */
export class NoopCloudGateway implements CloudGateway {
  async push(_rows: OutboxRow[]): Promise<{ sentIds: number[] }> {
    return { sentIds: [] };
  }
}

/** Factory keyed on CLOUD_ENABLED. Until a real gateway exists, every flag value gets the no-op. */
export function createCloudGateway(enabled: boolean, log: Logger = createLogger('cloud')): CloudGateway {
  if (enabled) log.warn('CLOUD_ENABLED=true but no cloud transport is implemented; using no-op gateway');
  return new NoopCloudGateway();
}

import { createLogger, type Logger } from '../log.js';
import type { CloudGateway, OutboxRow, Repo } from '../types.js';

export interface OutboxPumpDeps {
  repo: Pick<Repo, 'pendingOutbox' | 'markOutboxSent'>;
  gateway: CloudGateway;
  batch?: number;
  log?: Logger;
}

/**
 * Drains unsent outbox rows through the gateway, oldest first. Only ids the gateway
 * reports as sent (and that were actually in the batch) are marked sent.
 * Stops when a batch yields no progress, so a no-op gateway cannot spin.
 * Returns the number of rows marked sent.
 */
export async function pumpOutbox({ repo, gateway, batch = 100, log = createLogger('cloud.outbox') }: OutboxPumpDeps): Promise<number> {
  let total = 0;
  for (;;) {
    const rows: OutboxRow[] = await repo.pendingOutbox(batch);
    if (rows.length === 0) break;
    const { sentIds } = await gateway.push(rows);
    const batchIds = new Set(rows.map((r) => r.id));
    const ids = [...new Set(sentIds)].filter((id) => batchIds.has(id));
    if (ids.length === 0) break;
    await repo.markOutboxSent(ids);
    total += ids.length;
  }
  if (total > 0) log.info({ sent: total }, 'outbox pumped');
  return total;
}

# ADR 004: Transactional outbox for future cloud sync

Status: Accepted (design). Producer not yet wired; cloud gateway not implemented; `CLOUD_ENABLED=false`.

## Context
The edge must keep running without internet, and a future cloud service must receive events
exactly once in the normal case and at least once otherwise. Calling the cloud inline from the
controller would tie the pump to the network.

## Decision
Outward-facing facts (for example, an irrigation event) are to be written to an `outbox` table in
the same transaction as the state change. The repo API already exists (`enqueueOutbox`,
`pendingOutbox`, `markOutboxSent`). `pumpOutbox` in `edge/src/cloud/outbox.ts` runs every 60 s, reads
pending rows, hands them to a gateway, and marks them sent only after the gateway accepts them. When
`CLOUD_ENABLED=false` the gateway is a no-op.

## Consequences
- Delivery is at-least-once. The cloud side must deduplicate on the row's key.
- Nothing in the control path waits on the network.
- Current gap: the controller does not yet call `enqueueOutbox`, so the table stays empty. Wiring
  the producer is a prerequisite for cloud sync.
- The outbox is unbounded until the cloud gateway exists and a retention or cap policy is set.

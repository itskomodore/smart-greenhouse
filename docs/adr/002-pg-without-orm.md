# ADR 002: PostgreSQL with hand-written SQL, no ORM

Status: Accepted

## Context
The schema is small (readings, irrigation events, commands, alarms, settings, outbox), and the
hot queries are time-bucketed aggregates and "open row" lookups. The Pi 4 has 2 GiB of RAM and a
single operator. An ORM adds a runtime, a generated-code step and a second model of the data.

## Decision
Use the `pg` driver with explicit SQL in `edge/src/db/pg-repo.ts`. Schema changes are numbered
`NNN_name.sql` files applied by `edge/src/db/migrate.ts`. Each file runs in one transaction with its
`schema_migrations` row, under an advisory lock. Every query runs with a deadline
(`DB_QUERY_TIMEOUT_MS`).

## Consequences
- The SQL is visible and reviewable, and `EXPLAIN` works directly on it.
- Migrations are plain files that can be read and backed up with the database.
- There is no model layer to keep in sync, so the types in `edge/src/types.ts` are the contract.
- We write more mapping code by hand. Acceptable at this size.
- A failed migration rolls back its own file and stops the migrator. The service keeps running
  and retries in the background (see `main.ts`).

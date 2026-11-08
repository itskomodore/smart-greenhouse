# Development guide

For engineers working on the edge service, dashboard or simulator. Read the [root README](../README.md) first for what the system does; this guide covers how the code is organised and how to change it safely. Deployment and ops are in [README.md](README.md); the HTTP/CoAP contract is in [API.md](API.md).

## 1. Setup

Requirements: Node 20+ (CI target: current LTS), pnpm, Postgres 14+.

```bash
createdb greenhouse
cd edge && pnpm install
cp .env.example .env          # set API_TOKEN (>= 16 chars) and DATABASE_URL
pnpm dev                      # tsx watch; CoAP :5683, HTTP :8080; migrations run at boot
```

The default `DATABASE_URL` uses role `greenhouse`, which only exists on a Pi after `install.sh`. On a dev machine point it at your own role, for example `postgres://you@localhost:5432/greenhouse`. If the DB is unreachable the service still runs and buffers readings in memory (see 5.4).

| Task | Command |
|---|---|
| Typecheck | `cd edge && pnpm typecheck` |
| All edge tests | `cd edge && pnpm test` |
| One file or pattern | `pnpm exec vitest run test/scenarios/s3` |
| Postgres integration tests | `DATABASE_URL_TEST=postgres://... pnpm test` (skipped otherwise) |
| Build | `cd edge && pnpm build` (output `dist/`; `.sql` files are **not** copied by `tsc`, `install.sh` copies them) |
| Mock actuator | `cd edge && pnpm mock-actuator` |
| Dashboard dev | `cd dashboard && pnpm dev` (Vite, proxies `/api` to `:8080`) |
| Dashboard checks | `cd dashboard && pnpm typecheck && pnpm test && pnpm build` |
| Sensor simulator | `cd sim && pnpm tsx sensor-sim.ts --mode drying --interval 5` |

## 2. Repository map

```
edge/src/
  types.ts            shared contracts (Reading, Settings, Command, Decision, Repo, ports, bus events)
  main.ts             boot, wiring, graceful shutdown
  config/             schema.ts (zod env schema), index.ts (loader)
  coap/               validate.ts, normalize.ts, server.ts, mock-actuator.ts, transport.ts
  db/                 migrate.ts, pg-repo.ts, buffered-repo.ts, pool.ts, retention.ts, migrations/
  rules/              decide.ts, assess.ts, index.ts   (PURE: no I/O, no clock)
  actuator/           adapter.ts, commands.ts, clock.ts, bounded.ts
  controller/         loop.ts (tick loop), alarms.ts
  api/                app.ts, sse.ts, auth.ts, validation.ts, network.ts, ...
  cloud/              gateway.ts (no-op stub), outbox.ts
  bus.ts, log.ts      typed event bus, pino logger
edge/test/            scenarios/ (end-to-end adverse tests), harness/rig.ts
dashboard/src/        components/, lib/ (api, live SSE state, format, pumpState)
sim/                  sensor-sim.ts, payloads.ts
deploy/               systemd units, install.sh, journald drop-in
```

Files named `test-support.ts` are test helpers that live next to the code they fake. They are excluded from the production build in `tsconfig.build.json`.

## 3. Data flow

```
sensor ──CoAP POST /sensor──▶ coap/server ── validate ─▶ normalize ─▶ BufferedRepo.insertReading ─▶ Postgres
                                   │                                         │
                                   └──────── bus 'reading' ───────┬──────────┘
                                                                  ▼
                              controller/loop  (tick every RULES_TICK_MS)
                                  │  assessReading (jump filter)   decide(RulesState) ─▶ Decision
                                  ▼
                              CommandManager ──adapter.ts──CoAP PUT /pump──▶ actuator
                                  │ persist, retry, expiry, ack
                                  ▼
                           bus 'pump' / 'event' / 'alarms' ──▶ api/sse ──▶ dashboard
```

- **Bus topics** (`src/bus.ts`): `reading`, `pump`, `event`, `alarms`, `settings`, `db`. The `alarms` topic always carries the **full** active set, not a delta. Anything that publishes alarms must merge in `BufferedRepo.activeAlarms()` or `db_down` is lost.
- **Time** is injected (`Clock` in `actuator/clock.ts`, `RulesState.now`). Never call `Date.now()` in `rules/`.
- **IDs and idempotency:** every command has a uuid. Submitting the same id twice returns the existing command and sends nothing.

## 4. Module responsibilities

| Module | Owns | Does not do |
|---|---|---|
| `coap/validate.ts` | Strict payload checks (types, ranges, size ≤ 256 B). Error text never echoes input. | Normalization. |
| `coap/normalize.ts` | `soil_pct`, `light_pct`, node id, server timestamp. Throws `CalibrationError` when dry equals wet. | Storage. |
| `rules/decide.ts` | `decide(state) → Decision`. All start/stop/query logic. | I/O, clocks, logging. |
| `rules/assess.ts` | Jump filter: `assessReading(prev, next, settings)`. | State. |
| `actuator/adapter.ts` | **The only file with actuator paths and payload shapes.** | Retry logic. |
| `actuator/commands.ts` | Persist-before-send, retries (`command_max_retries` total sends), expiry, idempotency, `pump_failed` latch. | Deciding when to irrigate. |
| `controller/loop.ts` | Tick, builds `RulesState`, executes `Decision`, irrigation events, daily accounting, restart recovery, max-runtime guard. | Rule logic (calls `decide`). |
| `db/buffered-repo.ts` | Wraps `PgRepo`. Bounded in-memory ring while DB is down, ordered flush, cached settings and alarms. | SQL. |
| `api/app.ts` | Routes, auth, validation, SSE, static dashboard. | Controller internals (uses ports in `api/deps.ts`). |

## 5. Safety design (read before changing the controller)

Irrigation is the only action with real-world consequences. These invariants are enforced by code and tests; a change that weakens one needs a matching ADR (see [adr/005](adr/005-edge-side-safety-limits.md) and [adr/006](adr/006-actuator-side-safety-limits.md)).

1. **Never start when the pump state is unknown.** After boot or any failed command the state is `unknown`; the controller queries or turns the pump off first.
2. **Every ON carries `max_s`** (min of requested, `max_run_s`, remaining daily budget) and the edge also stops the run itself. The actuator's timer is a backstop, not the only limit.
3. **Commands expire.** A command is never sent at or after `expires_at`, including during retry backoff and after a restart. An ON that timed out and then expired is treated as possibly applied: pump `unknown`, safe OFF.
4. **Retries are bounded** (default 3 total sends), then the command is `failed` and `pump_failed`/`actuator_unreachable` is raised. `pump_failed` latches until a successful ON ack (or 15 min plus a later ack).
5. **OFF never depends on the DB.** The guard and manual OFF run before any DB read in a tick, OFF persistence is detached, and settings come from a cache. New starts are refused while the DB is down.
6. **A stop beats an in-progress start.** `requestOff` bumps a stop epoch; every start re-checks it after each `await` and never dispatches if it changed.
7. **Stale sensor blocks starts.** It does not stop a running pump; the run is bounded by `max_run_s`.
8. **Restart recovery:** pump set to `unknown`, any open irrigation event is closed `aborted` after an OFF, and `min_interval` is restored from the last event end.
9. **Daily cap** is counted in memory as well as from the DB so a DB outage cannot hide runtime.

Known open issues (from the final audit, not yet fixed; resolve before connecting a real pump):

- **F3:** OFF can be sent while an ON PUT is still retrying; UDP reordering could land the ON after it. The actuator's `max_s` timer is the backstop.
- **F5:** run charge and max-run stop are timed from the ack, not from the send.
- **F6:** the guard and charge use the wall clock; a backward NTP step could delay a forced OFF. A monotonic clock is needed.
- **F7:** `BufferedRepo` has no `isDown()`, so the controller's DB-health gate is dead code. DB-down protection currently works because a query throws.

## 6. Testing

- **Unit tests** sit beside the code (`*.test.ts`). `rules/` has table-driven, boundary and 20k-case property tests.
- **Scenario tests** in `edge/test/scenarios/` wire the real CoAP server, validator, rules, controller and command manager against a fake clock, `FakeActuator` and `MemRepo` (`edge/src/actuator/test-support.ts`). One file per adverse scenario: malformed payloads (S1), stale sensor (S2), actuator never acks (S3), expired command (S4), max runtime and daily cap (S5), restart mid-irrigation (S6), duplicate id (S7), DB outage (S8), soil jump (S9), OFF during start (S10), DB down after a run (S11).
- **Rig:** `edge/test/harness/rig.ts` builds the whole stack. New scenarios should use it, advance time with `FakeClock`, and avoid real sleeps.
- **Fault injection:** `MemRepo` supports throw and hang modes per call; `FakeActuator` scripts replies, delays and drops.
- **Postgres tests** (`db/pg-repo.integration.test.ts`) create their own schema per run and drop it. They are skipped unless `DATABASE_URL_TEST` is set.
- When you fix a safety bug, add a scenario that fails first.

## 7. Common changes

**Add or change a setting.** Add the field and default in `types.ts` (`Settings`, `SETTINGS_DEFAULTS`); add range validation in `api/validation.ts` and the matching client check in `dashboard/src/lib/format.ts`; show it in `SettingsForm.tsx`; document it in `API.md`.

**Add an environment variable.** Add it to `config/schema.ts` (or `config/index.ts` for non-contract keys), then to `edge/.env.example`. Every key must appear in `.env.example`:

```bash
cd edge && for k in $(grep -hoE "^ +[A-Z][A-Z0-9_]+: " src/config/schema.ts src/config/index.ts | tr -d " :" | sort -u); do grep -qE "^#? ?$k=" .env.example || echo MISSING $k; done
```

**Add a migration.** Add `edge/src/db/migrations/00N_name.sql` (plain SQL, applied in order inside a transaction, recorded in `schema_migrations`). Never edit an applied migration. If you add a `Repo` method, implement it in `PgRepo` and `BufferedRepo` and `MemRepo` (`actuator/test-support.ts`).

**Add an API endpoint.** Add the route in `api/app.ts`, a zod schema in `api/validation.ts`, write endpoints behind the bearer check, errors as `{error, message}`, and a test with `fastify.inject`. Update `API.md` and `dashboard/src/types.ts`.

**Change the actuator protocol.** Edit `actuator/adapter.ts` only; update the mock in `coap/mock-actuator.ts` and the actuator section of `API.md`. Nothing else should know the path or payload.

**Change rules.** Edit `rules/decide.ts`, add table cases including the exact boundary, and keep the property test green. Do not add I/O or clock reads.

## 8. Conventions

- TypeScript strict, ESM with NodeNext: import with `.js` extensions.
- Log with pino (`createLogger('name')`), JSON, never `console.log`. Do not log tokens or the database URL.
- Every background promise needs a `.catch`; every timer needs a clear path and should be `unref`'d if it must not block exit.
- Anything per-node or per-id that grows with untrusted input must be bounded (LRU or ring).
- Dashboard: no external fonts, scripts or CDNs (it must work offline); render server text as text, never as HTML; keep the JS bundle under about 120 KB gzipped (currently about 83 KB).
- Public contracts (`types.ts`, `config/schema.ts`, `001_init.sql`, `API.md`) change deliberately: update the code on both sides in the same change.

## 9. Debugging

```bash
curl localhost:8080/healthz
curl localhost:8080/api/status | jq
journalctl -u greenhouse-edge -o json -f | jq -r '[.PRIORITY,.MESSAGE]|@tsv'     # on the Pi
LOG_LEVEL=debug pnpm dev
MOCK_NEVER_ACK=1 pnpm mock-actuator                                                # actuator that never replies
pnpm tsx sensor-sim.ts --mode garbage --count 20                                   # expect 4.00 / 4.15 on every message
```

| Symptom | Likely cause |
|---|---|
| "Database unreachable; readings are buffered in memory" | Wrong role or URL in `edge/.env`, or Postgres is not running. Readings flush in order once it recovers. |
| Dashboard shows "stale" | No reading within `stale_timeout_s`; check the simulator or sensor target. |
| Pump never starts | Pump state `unknown` (actuator unreachable), sensor stale, inside `min_interval_s`, daily cap hit, or DB down. The decision reason is logged. |
| Sensor target shows "interface not found" | No `wpan0` on this machine; set `THREAD_IFACE` or run the OTBR. |
| `401` on writes | Token in the dashboard does not match `API_TOKEN`. |
| `503 auth_not_configured` | `API_TOKEN` empty in the environment. |

# Smart greenhouse: operator and developer guide

A small, offline-first irrigation controller. Soil and climate sensors on a Thread mesh report to a
Raspberry Pi 4 (2 GiB). The Pi decides when to run a pump, keeps the history, and serves a LAN
dashboard. Read this file first. Contracts live in `docs/API.md` (supervisor-owned); design
decisions live in `docs/adr/`.

Contents: architecture · offline-first · quickstart (dev) · install and deploy · ops runbook ·
calibration · safety model · swapping the actuator adapter · limitations · ADR index.

---

## 1. Architecture

```
  Sensor nodes (ESP32-C6, Thread, sleepy)              Raspberry Pi 4, 2 GiB, Raspberry Pi OS
 ┌────────────────────┐                     ┌──────────────────────────────────────────────────┐
 │ t, rh, light, soil │  CoAP UDP :5683     │  OTBR (Thread border router, already installed)  │
 │ POST /sensor (JSON)│ ───────────────────▶│     │ IPv6 to the Thread mesh (wpan0)            │
 └────────────────────┘                     │     ▼                                            │
                                            │  ┌──────────── greenhouse-edge (systemd) ───────┐ │
  Browser on LAN ── HTTP :8080 ────────────▶│  │ CoAP ingest ─▶ validate, normalise ─┐        │ │
   (dashboard SPA, REST, SSE /api/stream)   │  │ HTTP API + SSE + static dashboard   │        │ │
   ◀──── live readings, pump state, alarms ─│  │                                     ▼        │ │
                                            │  │ controller ─▶ rules engine decide() (pure)   │ │
                                            │  │   │  command lifecycle: persist, send, retry  │ │
                                            │  │   │  (3 tries, expiry, idempotent id)        │ │
                                            │  │   ├─▶ buffered repo ─▶ pg (bounded queries)  │ │
                                            │  │   │      └ in-memory ring when DB is down    │ │
                                            │  │   └─▶ actuator adapter ─ CoAP PUT /pump ──┐  │ │
                                            │  └──────────────────────────────────────────┼──┘ │
                                            │  PostgreSQL (local)                          │    │
                                            └──────────────────────────────────────────────┼────┘
                                                                                           ▼
                                                              Pump actuator (separate device, assumed API)
                                                              own max_s timer, idempotent ids, boots OFF
```

Data path: reading → `soil_pct` (calibrated) → `reading` SSE + DB → rules tick (1 s) → decision →
command (persisted first) → actuator. Every decision carries a human-readable reason and lands in
`irrigation_events` and the event feed.

Process and memory: one Node process (`dist/main.js`), `--max-old-space-size=160`, systemd
`MemoryMax=300M`. Steady RSS target is under 200 MB. No Docker. Everything runs under systemd.

Code map (`edge/src`): `main.ts` (boot and shutdown), `coap/` (ingest and mock actuator),
`actuator/` (adapter and command lifecycle), `rules/` (pure decision), `controller/` (the loop),
`db/` (pg repo, buffered repo, migrations, retention), `api/` (HTTP, SSE), `cloud/` (outbox,
gateway stub), `config/` (env schema). `dashboard/` is a Vite React app. `sim/` is a fake sensor.
`deploy/` holds the installer, units and journald drop-in.

---

## 2. Offline-first

The greenhouse must keep watering safely with no internet, and it must keep running with the
database down for a while. Concretely:

- **No cloud dependency in the control path.** Rules, actuation, dashboard and history are all
  local. `CLOUD_ENABLED=false` is the default, and the outbox only accumulates rows (ADR 004).
- **Database down:** readings go to a bounded in-memory ring (`DB_BUFFER_MAX`, oldest dropped with a
  warning) and are flushed in order on recovery. New irrigation starts are refused. Pump OFF still
  works (manual, shutdown, recovery). The DB is probed every 5 s.
- **Restart mid-run:** on boot the pump state is UNKNOWN. The service sends a safe OFF if it finds an
  open irrigation event, a pump-on record, or an unreadable DB, and then closes the open event.
- **Actuator unreachable:** commands retry (3 attempts with backoff), then fail visibly. The
  actuator's own `max_s` timer is the last line.

Plan on the Pi running with no internet. Nothing in `deploy/install.sh` needs a live internet
connection after the first install, except the apt and NodeSource steps (run them once, online).

---

## 3. Quickstart (development)

Requirements: Node 20 or newer (LTS recommended), pnpm via corepack (`corepack enable pnpm`),
PostgreSQL 14 or newer on localhost. `jq` is used for pretty-printing in the runbook (optional).

### 3.1 PostgreSQL

```sh
sudo apt install -y postgresql
sudo -u postgres psql -c "CREATE ROLE greenhouse LOGIN PASSWORD 'devpass'"
sudo -u postgres createdb -O greenhouse greenhouse
```

Use a real password in anything you share. The integration test reads `DATABASE_URL_TEST` if set.

### 3.2 Edge service

```sh
cd edge
pnpm install
cp .env.example .env            # then set API_TOKEN (>= 16 chars) and DATABASE_URL
pnpm migrate                    # applies src/db/migrations/*.sql, idempotent
pnpm test                       # vitest, unit tests (no hardware, no DB)
```

Generate a token with `openssl rand -hex 32`. The `.env` file is gitignored.

Run the edge in watch mode (`pnpm dev`, `tsx watch src/main.ts`) or the built output (`pnpm build`
then `pnpm start`). The migrator finds its SQL under `src/` when run from `dist/`, so `pnpm start`
works from a checkout.

### 3.3 Mock actuator

The real pump driver is not needed for development. The mock speaks the assumed CoAP API and
keeps the same rules (same id returns the same reply, `exp` in the past is rejected, `max_s` is a
hard timer).

```sh
cd edge
pnpm mock-actuator              # binds MOCK_COAP_HOST:MOCK_COAP_PORT (127.0.0.1:5684 by default)
```

Adverse knobs for testing retries and idempotency: `MOCK_DROP_RATE=0.3`, `MOCK_NEVER_ACK=1`,
`MOCK_DELAY_MS=2000`. Set them on the mock's environment, not the edge's.

### 3.4 Sensor simulator

```sh
cd sim
pnpm install
pnpm sim -- --help
pnpm sim -- --id node-a --interval 5                       # plausible values, every 5 s
pnpm sim -- --mode drying --interval 1 --count 200         # soil dries, then "irrigated" reset
pnpm sim -- --mode stuck --interval 5                      # identical values, stale check
pnpm sim -- --mode garbage --count 50 --interval 0.2 --seed 42   # malformed traffic
pnpm sim -- --rate 50 --count 500                          # 50 msg/s burst
```

The sim targets `127.0.0.1:5683` by default (`--host`, `--port` to change). Expected replies are
`2.04`/`2.01` for valid data and `4.00`/`4.15` for garbage.

### 3.5 Dashboard

```sh
cd dashboard
pnpm install
pnpm dev                        # Vite on http://localhost:5173, proxies /api and /healthz
```

The proxy target defaults to `http://localhost:8080`. Override with
`DASHBOARD_PROXY_TARGET=http://<pi>:8080` to watch a real edge. For a production-style build,
run `pnpm build`. The edge then serves `dashboard/dist` at `/` when `DASHBOARD_DIR` points at it.
Without a build the API still runs, and the edge logs `dashboard directory missing; serving API only`.

---

## 4. Install and deploy (Raspberry Pi OS)

Prerequisites: Raspberry Pi 4 with 2 GiB, Raspberry Pi OS (64-bit, Bookworm or later), systemd,
internet for the first install, OTBR already working, and the repo checked out on the Pi.

```sh
git clone <repo> ~/smart-greenhouse && cd ~/smart-greenhouse
sudo ./deploy/install.sh --http-host 192.168.1.50 --actuator-host 192.168.1.60
```

- `--http-host`: the Pi's LAN IPv4. If omitted, the installer detects it from the default route.
  The API never binds `0.0.0.0` unless you pass that value explicitly.
- `--actuator-host`: the pump driver's address. Without it, `ACTUATOR_HOST` stays `127.0.0.1`,
  where nothing listens, so pump commands fail safely.
- `--with-mock-actuator`: installs and starts a FAKE pump on loopback. Never use it with a real
  pump. Use it only for a bench test.

What the installer does, in order: apt packages, NodeSource Node LTS (`NODE_MAJOR`, default 24),
pnpm via corepack, the `greenhouse` system user, `/etc/greenhouse/edge.env` (0600, root), the
`greenhouse` PostgreSQL role and database with a generated password, a build of `edge` and
`dashboard` from this checkout, a runtime tree in `/opt/greenhouse` (dist, migrations, production
dependencies, dashboard build), migrations, the systemd units, the journald drop-in, then enable,
start and a `/healthz` check.

It is idempotent. Re-run it after `git pull` to upgrade. It refuses to run as a non-root user. It
never prints a secret. The API token and DB password appear only in `/etc/greenhouse/edge.env`.
Existing values are kept, and only missing keys are added.

### 4.1 Layout on the Pi

| Path | Owner | Mode | Contents |
|---|---|---|---|
| `/opt/greenhouse/edge` | root | 0755 | `dist/`, `node_modules/` (prod), `package.json`, lockfile |
| `/opt/greenhouse/dashboard/dist` | root | 0755 | dashboard build |
| `/etc/greenhouse/edge.env` | root | 0600 | every edge setting, `API_TOKEN`, `DATABASE_URL` (secrets) |
| `/etc/systemd/system/greenhouse-edge.service` | root | 0644 | the unit |
| `/etc/systemd/journald.conf.d/greenhouse.conf` | root | 0644 | journal caps |

### 4.2 Timezone (matters for the daily cap)

The daily irrigation cap (`daily_max_s`) counts runtime since **local midnight** of the server.
The edge uses the OS timezone. The unit does not set `TZ`. Check and set it on the Pi:

```sh
timedatectl                                    # shows "Time zone"
sudo timedatectl set-timezone Europe/Berlin    # use your Area/City
sudo systemctl restart greenhouse-edge         # Node reads the zone at start
```

A wrong timezone shifts the daily budget reset. It does not weaken the limit itself. The installer
prints the current zone at the end.

### 4.3 Firewall (examples only, not applied)

The installer does not touch firewall rules. Ports to allow:

- TCP `HTTP_PORT` (8080) from the LAN only: dashboard, REST, SSE.
- UDP `COAP_PORT` (5683) from the Thread side only: sensor ingest.
- Nothing else inbound. The actuator link is outbound.

```sh
sudo apt install -y ufw
# verify SSH access before enabling, or you will lock yourself out
sudo ufw allow OpenSSH
sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp     # LAN only
sudo ufw allow in on wpan0 to any port 5683 proto udp              # Thread side only
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw enable
```

Check the interface name first (`ip -br link`). `wpan0` is the usual OTBR Thread interface. The
Thread side may route its traffic through a different interface. Confirm by sending a test packet
from a sensor (`sim` from a Thread node) and watching `ufw` logs. Also make sure `ufw` IPv6 is on
in `/etc/default/ufw` (`IPV6=yes`), or the CoAP rule will not match.

### 4.4 Units

- `greenhouse-edge.service`: runs as `greenhouse`, `Restart=always`, `RestartSec=2`,
  `After=network-online.target postgresql.service`. `TimeoutStopSec=25` leaves room for the app's
  20 s shutdown limit (pump OFF). `MemoryMax=300M`, `NODE_OPTIONS=--max-old-space-size=160`.
  Hardened: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, no
  capabilities, and an address-family allow-list. `MemoryDenyWriteExecute` is off on purpose
  because V8's JIT needs it.
- `greenhouse-mock-actuator.service`: optional, disabled by default, loopback only.
- Journald drop-in: `SystemMaxUse=200M`, `MaxRetentionSec=30day`. This keeps the SD card from
  filling with logs.

---

## 5. Ops runbook

Replace `pi` with the Pi's address. `TOKEN` is needed for writes only; never paste it into shared
logs or chat.

### 5.1 Status

```sh
systemctl status greenhouse-edge postgresql --no-pager
curl -s http://pi:8080/healthz                          # {"ok":true}
curl -s http://pi:8080/api/status | jq .                # pump, nodes (stale?), alarms, db, daily_runtime_s
curl -s http://pi:8080/api/latest | jq .                # newest reading and age
curl -s 'http://pi:8080/api/events?limit=10' | jq .     # recent irrigation decisions with reasons
```

Health signals to watch: `db: false` in `/api/status` (DB down, starts refused); `nodes.*.stale: true`
(sensor silent past `stale_timeout_s`); any alarm in `alarms`.

### 5.2 Logs

Logs are pino JSON. journald stores each line in its `MESSAGE` field.

```sh
journalctl -u greenhouse-edge -n 200 -o cat              # the JSON lines, readable
journalctl -u greenhouse-edge -o json -n 50              # journald records; MESSAGE holds the pino line
journalctl -u greenhouse-edge -o json | grep -F '"level":50' | tail     # errors (pino level 50 = error)
journalctl -u greenhouse-edge -f                         # follow
journalctl -u greenhouse-edge --since "1 hour ago"
journalctl --disk-usage                                  # should stay under 200M
```

pino levels: 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal. Change verbosity with
`LOG_LEVEL` in `/etc/greenhouse/edge.env`, then restart. The shutdown path logs
`pump OFF settled at shutdown`. Grep for it after a restart.

### 5.3 Restart, stop, and pump state

```sh
sudo systemctl restart greenhouse-edge     # SIGTERM: pump OFF (<= 20 s), then start
sudo systemctl stop greenhouse-edge        # same OFF on the way down
```

After a restart the pump is UNKNOWN until the controller queries it. Confirm with
`curl -s http://pi:8080/api/status`. The pump state should move to `off`.

### 5.4 Backup and restore

```sh
# backup (run as the postgres superuser, custom format, compressed)
sudo -u postgres pg_dump -Fc greenhouse | sudo tee /var/backups/greenhouse-$(date +%F).dump >/dev/null
sudo chmod 0600 /var/backups/greenhouse-*.dump
```

Copy the dump off the Pi. It contains the full history, and it contains no secrets.

```sh
# restore (destructive; stop the edge first)
sudo systemctl stop greenhouse-edge
sudo -u postgres dropdb greenhouse
sudo -u postgres createdb -O greenhouse greenhouse
sudo -u postgres pg_restore -d greenhouse --no-owner --role=greenhouse /var/backups/greenhouse-YYYY-MM-DD.dump
sudo systemctl start greenhouse-edge
```

`install.sh` does not back up. Schedule the dump yourself, for example with a root cron entry.

### 5.5 Retention

- `RETENTION_DAYS` (env, default 90) seeds the DB setting `retention_days`. Change it at runtime
  through `PUT /api/settings`. The DB value wins.
- A daily job deletes **readings** older than that. It does not touch events, commands, alarms or
  the outbox, so irrigation history is kept.
- `0` or a negative value disables the purge (logged as a warning).
- Growth: about one row per node per reporting interval. At a 5 s interval, a single node
  produces roughly 17,000 rows a day. Plan the DB disk accordingly, and check
  `SELECT pg_size_pretty(pg_database_size('greenhouse'));`.

### 5.6 Token rotation

`API_TOKEN` is the only credential for writes. Rotate it when a device is lost or shared. The
dashboard keeps the token in `localStorage`, so each browser must re-enter it.

```sh
NEW="$(openssl rand -hex 32)"
sudo sed -i "s/^API_TOKEN=.*/API_TOKEN=${NEW}/" /etc/greenhouse/edge.env
unset NEW
sudo systemctl restart greenhouse-edge     # pump goes OFF on the way down
```

The old token is rejected immediately after the restart. Re-enter the new one in each dashboard
session. Confirm with `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://pi:8080/api/pump`
(expect `401` without a token).

### 5.7 Upgrade and rollback

```sh
cd ~/smart-greenhouse && git pull
sudo ./deploy/install.sh               # re-applies everything; keeps the same secrets
```

The installer stops the service (pump OFF) before it swaps files, runs pending migrations, then
restarts and checks `/healthz`. Migrations are forward-only. To roll back the code, check out the
old commit and re-run the installer. To roll back the schema, restore the pre-upgrade dump (section
5.4). Take a dump before any upgrade that includes a new migration.

### 5.8 Common failures

| Symptom | Likely cause | Action |
|---|---|---|
| `invalid configuration` in the log | a bad or missing env key | the log lists every bad key; fix `/etc/greenhouse/edge.env` |
| `schema not confirmed at boot` | DB down or migration failed | `journalctl` for the migration error; the migrator retries every 10 s |
| `db: false`, starts refused | DB unreachable | `systemctl status postgresql`; the edge resumes on its own |
| pump `unknown` for long | actuator unreachable or unconfirmed OFF | check the actuator; the OFF is re-sent with backoff up to 60 s |
| commands `failed` `refused: sensor stale` | no reading within `stale_timeout_s` | check sensor power and Thread route |
| `409 daily_cap_reached` on a manual start | daily budget used, or DB down (see limitations) | check `daily_runtime_s` in `/api/status` |
| dashboard reachable but writes give `401` | token mismatch | re-enter token; confirm `API_TOKEN` in the env file |

---

## 6. Calibration

Soil readings are raw ADC counts, 0..4095. Wetter soil reads LOWER. Two points set the scale:
`soil_dry_raw` (in air) and `soil_wet_raw` (in water). `soil_pct` is linear between them, clamped
to 0..100. The defaults (3000 dry, 1200 wet) are placeholders and must be replaced.

Procedure:

1. Open the dashboard, Calibrate tab. Confirm the raw soil value updates live.
2. **Dry point.** Hold the probe in free air at room temperature, dry, for about 30 s until the
   raw value is stable. Press the **DRY** capture button. The reading must be less than 60 s old. Otherwise the
   API returns `409 no_recent_reading`.
3. **Wet point.** Put the probe in tap water up to the sensor's marked line (never past the
   electronics). Wait about 30 s until stable. Press the **WET** capture button.
4. Check the result. The probe in air should show `soil_pct` near 0, and in water near 100. Check
   the saved values with `curl -s http://pi:8080/api/settings | jq '{soil_dry_raw,soil_wet_raw}'`.
5. Put the probe in its final position in the bed and confirm `soil_pct` is plausible.

Equivalent API calls (bearer token required):

```sh
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://pi:8080/api/calibrate/dry
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://pi:8080/api/calibrate/wet
```

Errors: `409 dry_equals_wet` if the two captures give the same raw value (repeat with a clearer
difference). `409 no_recent_reading` if the last reading is over 60 s old.

Calibration changes the normalisation for future readings only. Past readings keep the `soil_pct`
they were stored with. Calibrate again after any probe swap or replacement.

---

## 7. Safety model

The pump can flood or dry out a bed. The system is built so that no single failure starts it
unsafely, and a stop always wins. Two layers apply: the edge (this service) decides, and the
actuator (separate device, firmware owned by another team) enforces its own limits as a backstop.

### 7.1 Edge-side limits

Defaults from `SETTINGS_DEFAULTS` (`edge/src/types.ts`). Runtime values live in the DB `settings`
table and can be changed through `PUT /api/settings` within the API's validation ranges.

| Rule | Where | Default | Behaviour |
|---|---|---|---|
| Max run | `rules/decide.ts` (start clamp, stop) | `max_run_s` 60 (1..600) | a start is clamped to this; a running pump stops when it elapses |
| Daily budget | rules + controller | `daily_max_s` 600 | runtime on the server's LOCAL day, counted from DB events; no start when used up; a run that hits the cap stops |
| Min interval | rules | `min_interval_s` 1800 | a start is refused until this long after the last run ended; applies to manual starts too |
| Low / high thresholds | rules | `low_threshold` 30, `high_threshold` 60 | auto starts only below low; a running pump stops at or above high |
| Auto on/off | rules | `auto_enabled` true | global switch for automatic starts; manual still works |
| Stale sensor | rules | `stale_timeout_s` 900 (60..86400) | no start (auto or manual) without a reading in this window; alarm `sensor_stale`. A running pump is **not** stopped by staleness: it is bounded by max run and the actuator timer |
| Implausible jump | `rules/assess.ts` | `max_soil_jump_pct` 40 | a soil change over 40 points is ignored (alarm `soil_jump_ignored`). Three agreeing readings over a minimum span re-baseline the filter |
| Raw range | CoAP validation | `t` −40..85, `rh` 0..100, `light`/`soil` 0..4095 | out-of-range or malformed payloads get `4.00` and are not stored |
| Unknown pump | controller + rules | — | never starts from unknown. Queries first. An unconfirmed OFF stays "unknown" and is re-sent with backoff 5 s to 60 s |
| Command expiry | `actuator/commands.ts` | `command_expiry_s` 30 (5..300) | each command carries `exp`; it is not sent after expiry and ends `expired` |
| Retries | `actuator/commands.ts` | `command_max_retries` 3 (1..5) | at most N sends, backoff 500 ms, 1 s, 2 s, capped at 4 s, never after expiry |
| Manual OFF | rules (priority 1) | always | honoured before anything else; coalesced if one is already in flight |
| Manual ON | API + rules | `duration_s` 1..`max_run_s` | non-numeric `400`; a number is clamped to 1..`max_run_s`, then to the remaining daily budget |
| Restart recovery | controller boot | — | pump starts UNKNOWN. A safe OFF is sent if an open event, a pump-on record, or an unreadable DB state is found. Open events are closed as `aborted` |
| Shutdown | `main.ts` | 20 s hard limit | no new starts; pump OFF sent (1.5 s send, 3 s wait for confirmation); pool closed |
| DB down | buffered repo + controller | `DB_QUERY_TIMEOUT_MS` 5000 | new starts refused (`db_unavailable`); readings buffered in RAM; pump OFF path does not depend on the DB |

Shutdown and DB-down details:

- **Pump OFF does not wait on the database.** An OFF without an `id` (shutdown, recovery, plain
  manual OFF) is sent first and persisted in the background. An OFF that carries an `id` does a
  duplicate lookup in the DB before it is sent, so prefer omitting `id` for emergency OFF.
- **New starts are refused while the DB is down.** Each DB call has a deadline, so a hung DB
  cannot stall the rules loop.
- **Known oddity:** the API reports this refusal as `409 daily_cap_reached`, because the public
  error list does not include a DB code. Check `/api/status` `db` to tell them apart.

### 7.2 Actuator-side limits (assumed; the firmware must confirm)

The actuator is a separate device, and the API in `docs/API.md` is an assumption until the firmware
owner confirms it. The safety requirements on it are:

| Rule | Requirement |
|---|---|
| Hard max run | `max_s` starts a local timer. The pump turns OFF when it elapses, with or without network |
| Expiry | a command whose `exp` is in the past gets `4.08`, and nothing happens |
| Idempotency | the same `id` returns the previous reply and never runs twice |
| Boot state | OFF |
| Fail-off hardware | recommended: a relay or driver that de-energises the pump on watchdog or power loss |

The edge and the actuator fail independently. If the edge dies mid-run, the actuator's `max_s`
timer is the stop. That is why `max_s` must be a local timer and not a request the edge has to
repeat.

### 7.3 What the system will not do

- Start on unknown pump state.
- Start on stale or missing sensor data.
- Start while the DB is down.
- Start past the daily budget or the min interval.
- Run longer than `max_run_s` per run, or past the high threshold.
- Send a command after its expiry.
- Accept a soil value that jumped more than the filter allows without re-confirmation.

---

## 8. Swapping the actuator adapter

Only `edge/src/actuator/adapter.ts` knows the wire format. The rest of the edge speaks the
`Actuator` interface from `edge/src/types.ts`. To replace the CoAP driver (different protocol, a
GPIO relay, an MQTT bridge):

1. Implement `ActuatorAdapter` in a new file, or edit `adapter.ts`, keeping the exported
   `createCoapActuatorAdapter` signature.
2. Keep the semantics of `ActuatorAdapter` (`edge/src/types.ts`): `send(cmd)` resolves with an
   `ActuatorAck` or rejects, and `query()` returns the current pump state. Sends must be idempotent
   per command `id` and must honour `exp` and `ACTUATOR_TIMEOUT_MS`. A timeout is a failure, not a
   success. The errors in `adapter.ts` (`ActuatorTimeoutError`, `ActuatorRejectedError`, and so on)
   are how the command layer tells the cases apart.
3. Wire it in `main.ts` where `createCoapActuatorAdapter` is called. Nothing else changes.
4. Run `pnpm test` in `edge/`. The actuator suite (`actuator/adapter.test.ts`,
   `commands.test.ts`) runs against the contract.
5. Bench test with `pnpm mock-actuator` first. Then test an adverse run: `MOCK_NEVER_ACK=1` (the
   edge must retry idempotently) and `MOCK_DROP_RATE=0.5`.
6. Before the first real run, verify with the firmware owner that the actuator enforces the
   limits in section 7.2. Test by pulling power mid-run with the pump connected to a dummy load.

The edge does not care what the actuator is, only that it answers with the contract.

---

## 9. Known limitations and assumptions

- **Soil sensor direction.** Raw soil values fall as the soil gets wetter. The normalisation
  assumes this.
- **Placeholder calibration.** `SOIL_DRY_RAW` 3000 and `SOIL_WET_RAW` 1200 are placeholders until
  calibrated (section 6).
- **Node identity fallback.** A node's id is the `id` field in its payload if present. Otherwise it
  is the CoAP source address, which changes if the node's Thread address changes.
- **No CoAP authentication or DTLS on sensor ingest.** Anyone on the Thread network can post a
  reading. The mitigation is Thread network security (commissioning credentials). Do not expose
  `COAP_PORT` to anything else.
- **Outbox is unbounded.** Nothing consumes it yet (`CLOUD_ENABLED=false`), and the producer is not
  wired. Rows accumulate. Add a cap or retention before enabling the cloud.
- **API error mapping.** A DB-down start refusal is reported as `409 daily_cap_reached` (section 7.1).
- **Actuator API is assumed.** Confirm it with the firmware owner before a real run.
- **Single pump, single probe.** There is no per-zone logic. One sensor drives one pump.
- **ACTUATOR_HOST defaults to loopback.** Nothing listens there in production unless the mock is
  enabled. Set it explicitly when the driver is installed.
- **Time-zone dependence.** The daily budget uses the OS zone, and a wrong zone moves the reset
  (section 4.2).
- **Board-level watchdog.** The Pi itself has no watchdog configured by this repo. A hung Pi needs
  a hardware or systemd watchdog. Not in scope here.

---

## 10. Architecture decision records

| ADR | Decision |
|---|---|
| [001](adr/001-sse-over-websocket.md) | Server-Sent Events over WebSocket for live updates |
| [002](adr/002-pg-without-orm.md) | PostgreSQL with hand-written SQL, no ORM |
| [003](adr/003-pure-rules-engine.md) | Rules engine as a pure function |
| [004](adr/004-outbox.md) | Transactional outbox for future cloud sync |
| [005](adr/005-edge-side-safety-limits.md) | Safety limits enforced on the edge |
| [006](adr/006-actuator-side-safety-limits.md) | Independent safety limits on the actuator |

Contracts: `docs/API.md`. Env reference: `edge/.env.example`. Sensor simulator: `sim/README.md`.

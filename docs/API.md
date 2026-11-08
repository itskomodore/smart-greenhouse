# Edge API contract

Supervisor-owned. Source of truth for api-agent, ui-agent, test-agent, sim.

## Auth
- Read endpoints: open on LAN (bind via `HTTP_HOST`).
- Write endpoints (`POST/PUT`): `Authorization: Bearer <API_TOKEN>`. Compare constant-time. Missing/bad → `401`.
- Token from env only. Dashboard asks user for token once, stores in `localStorage`.
- Errors: ALWAYS `{ "error": "<code>", "message": "<human>" }` (`409` pump refusals use `error` = refusal code, e.g. `daily_cap_reached`; `400` validation adds `"fields": { "<setting>": "<msg>" }`). Calibrate `409` codes: `no_recent_reading` (latest raw older than 60 s), `dry_equals_wet`.
- Other codes: `400 validation_error`, `401 unauthorized`, `503` with `error` in `db_unavailable | controller_busy | controller_unavailable | too_many_clients | auth_not_configured`. HTTP liveness: `GET /healthz`. `/api/readings` buckets (per-node avg) to ≤ ~1000 points over the newest 5000 rows.
- `/api/status` carries no reading values; clients take values from `/api/latest` and SSE `reading`.

## CoAP (sensor ingest) — UDP `COAP_PORT`
| Method/Path | Behaviour |
|---|---|
| `POST` or `PUT /sensor` | JSON `{"t":23.41,"rh":55.20,"light":812,"soil":1530}` (+ optional `"id":"node-a"`). Valid → store, reply `2.04 Changed` (PUT) / `2.01 Created` (POST). Invalid → `4.00` + short text. Unsupported content → `4.15`. Never throws. |
| `GET /health` | `2.05` JSON `{"ok":true,"db":bool,"uptime_s":n}` |

Validation: object; `t` number −40..85; `rh` number 0..100; `light`,`soil` integer 0..4095; `id` optional string `^[A-Za-z0-9_.:-]{1,64}$`; unknown keys ignored; payload ≤ 256 B.
`node_id = id ?? CoAP source address`. `ts` = server receipt time (ISO UTC).
`soil_pct = clamp((dry−soil)/(dry−wet)·100, 0, 100)`, `light_pct = light/4095·100`. Dry/wet from settings.

## Actuator (outbound CoAP, adapter in `src/actuator/adapter.ts` ONLY)
Assumed API — firmware person edits adapter only.
```
PUT /pump   {"cmd":"on","max_s":60,"id":"<uuid>","exp":"<ISO>"}   → 2.04 {"id":"<uuid>","pump":"on","remaining_s":60}
PUT /pump   {"cmd":"off","id":"<uuid>","exp":"<ISO>"}              → 2.04 {"id":"<uuid>","pump":"off"}
GET /pump                                                          → 2.05 {"id":null|"<uuid>","pump":"on|off","remaining_s":n}
```
Actuator rules (assumed): same `id` seen twice → return previous result, no re-run; `exp` in past → `4.08` reject, no action; `max_s` is a hard local timer; unknown state at boot = off.

## HTTP

### GET /api/latest
`{ "reading": Reading|null, "age_s": number|null, "nodes": { "<node_id>": "<iso last seen>" } }`

### GET /api/readings?from=<iso>&to=<iso>&limit=<n>&node_id=
Default last 24 h, `limit` default 1000, max 5000. Ascending `ts`. Server downsamples (time-bucket avg) when range yields > limit rows. → `{ "readings": Reading[] }`

### GET /api/events?limit=10
→ `{ "events": IrrigationEvent[] }` newest first (max 100).

### GET /api/status
```
{ "now": iso, "uptime_s": n,
  "pump": { "state": "on|off|unknown", "since": iso|null, "command": Command|null },
  "nodes": { "<id>": { "last_seen": iso, "age_s": n, "stale": bool } },
  "alarms": Alarm[],
  "db": bool, "auto_enabled": bool,
  "daily_runtime_s": n,
  "network": { "coap_port": n, "thread_iface": "wpan0", "thread_iface_present": bool,
               "thread": [{ "address": str, "kind": "ula|global|link-local", "coap_url": str }],
               "lan": [{ "address": str, "kind": "ipv4", "coap_url": str }] } | null }
```

### POST /api/pump 🔒
Body `{ "cmd":"on", "duration_s": 30 }` or `{ "cmd":"off" }`.
API clamps `duration_s` to integer 1..`max_run_s` before calling the controller (`400` if not a number). Controller refuses with `409 { error: <code>, message }` (codes: `manual_pending`, `run_active`, `pump_on`, `daily_cap_reached`). `off` always allowed.
Pump state unknown: `on` is QUEUED (still `202`, Command `pending`) until the controller has queried the pump; it ends `failed` with `last_error: "refused: <reason>"` if rules refuse (e.g. sensor stale, min interval) or `expired` if the pump state is not resolved in time. Optional `id` (uuid) body field = idempotency key; same id returns the same Command, no resend.
Body is strict (unknown keys → `400`; `duration_s` finite number). `cmd:on` only: `429 {error:'rate_limited'}` + `Retry-After` beyond a 5-request burst (refill 1 per 2 s); `503 {error:'db_unavailable'}` while the DB is down. `off` is never rate-limited or refused for DB state.
Optional query `?wait_ms=N` (integer 0..5000, default 0). The API waits up to N ms for the command to settle (acked/failed/expired) and returns `200 { "command": Command, "duplicate": bool, "pump": PumpState }` with the final state; if it has not settled in time it returns `202` as below. Only the HTTP request waits: controller, retries and safety limits are unaffected, and a client disconnect cancels nothing. Invalid `wait_ms` → `400`.
→ `202 { "command": Command, "duplicate": bool }` within 2 s (when `wait_ms` is 0 or on timeout); state via `/api/status` and SSE.

### GET /api/settings → `Settings`
### PUT /api/settings 🔒
Partial `Settings`. Validate: `0≤low<high≤100`, `max_run_s 1..600`, `daily_max_s ≥ max_run_s`, `min_interval_s ≥ 0`, `command_expiry_s 5..300`, `command_max_retries 1..5`, `stale_timeout_s 60..86400`, `soil_dry_raw != soil_wet_raw`, ints in 0..4095. → `200 Settings`. Publishes SSE `settings`.

### POST /api/calibrate/{dry|wet} 🔒
Captures latest raw soil reading (must be < 60 s old, else `409`) into `soil_dry_raw` / `soil_wet_raw`. Rejects if result makes dry==wet. → `200 { "soil_dry_raw":n, "soil_wet_raw":n, "captured_raw":n }`.

### GET /api/stream (SSE)
`text/event-stream`, heartbeat comment every 15 s. Events (`event: <type>`, `data: <json>`): `reading`, `pump`, `event`, `alarms`, `settings` (shapes in `src/types.ts` `SseEvent`). Sends snapshot (`pump`, `alarms`) on connect. Max 20 clients.

### GET /healthz
`200 {"ok":true}` for systemd/monitoring (no auth).

### Static
`/` serves `DASHBOARD_DIR` (SPA fallback to `index.html`). Hashed assets cached; `index.html` no-cache.

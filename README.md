# Smart Greenhouse

Offline-first IoT greenhouse monitor and auto-irrigation (course IT4735E).

A battery-powered ESP32-C6 sensor node reports over Thread every 5 minutes. An **edge service** on a Raspberry Pi 4 stores the readings, serves a dashboard, and decides when to run the pump. An always-powered ESP32 actuator switches the pump on command. Monitoring and irrigation work with no Internet.

```
 ESP32-C6 sensor ──CoAP/Thread──▶ OTBR (Pi) ──▶ ┌─────────── edge (Node.js) ───────────┐
 {"t","rh","light","soil"}                      │ CoAP ingest → Postgres               │
                                                │ rules engine → command manager ──────┼─CoAP─▶ ESP32 actuator ─▶ pump
 Browser (LAN) ◀── HTTP + SSE ──────────────────┤ Fastify API + dashboard (static)     │
                                                └──────────────────────────────────────┘
```

## Repository layout

| Path | What |
|---|---|
| [edge/](edge/) | Edge service: CoAP ingest, Postgres, rules engine, actuator client, HTTP API |
| [dashboard/](dashboard/) | React + Vite + uPlot dashboard, built to static files, no CDN |
| [sim/](sim/) | Sensor simulator (normal, drying, stuck, garbage) |
| [deploy/](deploy/) | systemd units, `install.sh` for Raspberry Pi OS, journald config |
| [docs/](docs/) | [README](docs/README.md) (full guide and runbook), [API.md](docs/API.md), [ADRs](docs/adr/) |
| [firmware/](firmware/) | Node firmware (sensor, Thread border router) |

The Thread border router (OTBR) and the cloud sync are out of scope for the edge app. The database has an `outbox` table and a stub gateway so a cloud sync can be added later.

## Quick start (development)

Needs Node 20+, pnpm, and a local Postgres.

```bash
createdb greenhouse

# edge/.env
#   API_TOKEN=dev-token-at-least-16-chars
#   DATABASE_URL=postgres://localhost:5432/greenhouse

cd edge && pnpm install && pnpm dev            # CoAP :5683, HTTP :8080, migrations run at boot
cd edge && pnpm mock-actuator                  # fake pump on :5684 (MOCK_NEVER_ACK=1 to test failures)
cd dashboard && pnpm install && pnpm dev       # http://localhost:5173, proxies /api to :8080
cd sim && pnpm install && pnpm tsx sensor-sim.ts --host 127.0.0.1 --port 5683 --mode drying --interval 5
```

Paste the same `API_TOKEN` into the dashboard's token bar to enable the pump and settings controls.

## Tests

```bash
cd edge && pnpm typecheck && pnpm test          # unit + end-to-end adverse scenarios
DATABASE_URL_TEST=postgres://... pnpm test      # also runs the Postgres integration tests
cd dashboard && pnpm typecheck && pnpm test && pnpm build
```

The scenarios in `edge/test/scenarios/` cover: malformed or out-of-range payloads, sensor silent past the stale timeout, actuator that never acknowledges, command expired before delivery, max runtime and daily cap, restart mid-irrigation, duplicate command id, DB outage, implausible soil jumps, and a manual OFF during an in-progress start.

## Deploy to a Raspberry Pi

```bash
sudo ./deploy/install.sh --http-host <pi-lan-ip> --actuator-host <actuator-ip>
```

Installs Node, pnpm and Postgres, creates the database and a generated `API_TOKEN` in `/etc/greenhouse/edge.env`, builds and stages the app under `/opt/greenhouse`, and starts the `greenhouse-edge` systemd service. It is safe to re-run to upgrade. The firewall and timezone are not changed; the script prints examples. Details, runbook, backup and rollback are in [docs/README.md](docs/README.md).

## How it behaves

- **Input:** sensor sends CoAP `POST` or `PUT` to `/sensor` with `{"t":23.41,"rh":55.2,"light":812,"soil":1530}`. Invalid payloads get `4.00` and never crash the server. The server timestamps each reading.
- **Normalization:** `soil_pct` is computed from raw ADC using dry/wet calibration (set on the dashboard); `light_pct = light / 4095 * 100`. Raw values are stored too.
- **Auto irrigation:** start below the low threshold (default 30 %), stop at the high threshold (60 %) or the max runtime, with hysteresis and a minimum interval between runs.
- **Safety limits**, enforced on the edge and sent to the actuator as a runtime limit:
  - max runtime per run and a daily total;
  - commands expire (default 30 s) and need an acknowledgement, with at most 3 attempts;
  - no auto start when the sensor has been silent for 15 minutes, and an alarm is raised;
  - no start when the pump state is unknown, for example after a restart (the edge queries or turns the pump off first);
  - implausible soil jumps are ignored and logged;
  - the pump-off path does not depend on the database.
- **Dashboard:** live cards, 1 h / 24 h / 7 d charts, pump panel with ON (duration) and OFF, last 10 irrigation events, settings, calibration, and an alarm banner. Dark mode and mobile-friendly.
- **API:** Fastify with Server-Sent Events. Writes need `Authorization: Bearer <API_TOKEN>`. It binds to `127.0.0.1` unless configured, and `install.sh` sets the LAN address. See [docs/API.md](docs/API.md).

## Assumptions and known limitations

- The capacitive soil sensor reads **lower when wetter**. The default calibration (dry 3000, wet 1200) is a placeholder; calibrate on the dashboard.
- The actuator API (`PUT /pump` with `cmd`, `max_s`, `id`, `exp`) is **assumed**. All paths and payload shapes live in [edge/src/actuator/adapter.ts](edge/src/actuator/adapter.ts) so the firmware owner can change one file.
- A sensor without an `id` field is identified by its CoAP source address.
- Sensor ingest has no CoAP-level authentication; it relies on Thread network security.
- The daily cap uses the Pi's local day, so set the timezone on purpose.
- The cloud outbox has no producer yet, and retention purges readings only.
- Known open controller issues (OFF sent while an ON is still retrying, run timed from ack not send, wall-clock based guard) are tracked in the project notes. Resolve them before wiring a real pump.
- Not yet run on real hardware: the systemd units, `install.sh`, the real actuator, and the dashboard in a real browser.

## Further reading

[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the developer guide (code map, data flow, safety invariants, testing, how to make common changes); [docs/README.md](docs/README.md) for the architecture, ops runbook, calibration procedure and safety model; [docs/API.md](docs/API.md) for the HTTP and CoAP contract; [docs/adr/](docs/adr/) for design decisions.

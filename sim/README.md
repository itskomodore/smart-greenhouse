# Sensor simulator

Fake sensor node that sends CoAP `POST /sensor` messages to the edge, per `docs/API.md`
(payload shape from `SensorPayload` in `edge/src/types.ts`). Used for manual demos, load
bursts, and (later) edge test scenarios.

## Setup

```sh
cd sim
pnpm install
pnpm typecheck      # tsc --noEmit
```

Runs with `tsx`; no build step.

## Usage

```sh
pnpm sim -- --help
pnpm sim -- --host 192.168.1.20 --port 5683 --interval 5 --id node-a
```

Or directly: `pnpm exec tsx sensor-sim.ts [options]`.

| Flag | Default | Meaning |
|---|---|---|
| `--host <host>` | `127.0.0.1` | Edge host |
| `--port <port>` | `5683` | Edge CoAP UDP port (`COAP_PORT`) |
| `--interval <sec>` | `5` | Seconds between messages (0.05..3600) |
| `--id <id>` | none | Optional node id, `^[A-Za-z0-9_.:-]{1,64}$`. Omit to let the edge use the source address |
| `--mode <mode>` | `normal` | `normal`, `drying`, `stuck`, `garbage` (see below) |
| `--count <n>` | `0` | Messages to send, `0` = run until Ctrl-C |
| `--rate <n>` | unset | Load burst: `n` messages per second (1..1000). Overrides `--interval` |
| `--seed <n>` | `1` | PRNG seed, makes runs reproducible |

Exit codes: `0` normal end or Ctrl-C, `2` bad flags.

## Modes

- **normal**: plausible values. Temperature and humidity drift slowly, light follows a day cycle, soil stays around a moist level.
- **drying**: soil raw rises about 40 counts per message from wet toward dry. When it gets near dry, the sim resets it to wet, as if the edge had irrigated. The sim cannot see the pump, so this is an approximation.
- **stuck**: identical values every message (`t 22.5, rh 55.2, light 812, soil 1530`). Useful for stale-detection checks.
- **garbage**: every message is malformed or out of range, chosen at random from a fixed list (not JSON, truncated, NaN, out-of-range `t/rh/light/soil`, non-integer soil, bad or long `id`, missing field, oversized payload, `text/plain` content format). The expected answer is `4.00` or `4.15`.

## Output

One JSON log line per message on stdout (pino). Each line has `event`, the response `code`, and
`latency_ms`. A response that does not match the expectation is logged as `unexpected_response` at warn level.
A final `done` line summarises `sent`, `accepted`, `rejected`, `timeouts`, `unexpected`.

Set `LOG_LEVEL=warn` to log only mismatches (the final `done` line is info and is hidden).

## Examples

```sh
# one plausible node, every 5 s, forever
pnpm sim -- --id node-a

# dry-out cycle, 200 messages at 1 s
pnpm sim -- --mode drying --interval 1 --count 200

# 50 msg/s burst for 10 s
pnpm sim -- --rate 50 --count 500

# malformed traffic, reproducible
pnpm sim -- --mode garbage --count 50 --interval 0.2 --seed 42
```

## Notes

- The `coap` version matches `edge/package.json` (`^1.4.0`).
- Contract types are imported from `../edge/src/types.ts`, so there is no copy to drift.
- The sim only sends. Nothing here reads the pump state or the edge DB.

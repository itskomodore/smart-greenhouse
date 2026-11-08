# ADR 006: Independent safety limits on the actuator

Status: Accepted (requirement on the firmware; the mock actuator follows it)

## Context
If the edge crashes, loses power, or loses its network, nothing on the edge can stop the pump. The
pump must stop on its own, and a repeated or late command must not start a second run.

## Decision
The actuator enforces these limits itself, independent of the edge:
- `max_s` is a hard local timer. The pump turns OFF when it elapses, even with no network.
- A command whose `exp` is already past is rejected (`4.08`) and does nothing.
- The same command `id` returns the previous result and does not run twice.
- State at boot is OFF.
The edge treats an unconfirmed OFF as "unknown" and re-sends it, and it never starts a pump from an
unknown state.

## Consequences
- A dead edge still gets the pump switched off within `max_s` of the last start.
- Idempotent IDs make retries safe over lossy UDP.
- The API is assumed, not verified. Firmware owners must confirm each rule before the first real
  run. The mock in `edge/src/coap/mock-actuator.ts` encodes the same rules for tests.
- Recommendation: put a hardware watchdog or a relay with a time limit in the driver as well.
  Software in the actuator is not a substitute for a fail-off electrical design.

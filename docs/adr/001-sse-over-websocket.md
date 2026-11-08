# ADR 001: Server-Sent Events over WebSocket for live updates

Status: Accepted

## Context
The dashboard needs a one-way live feed: readings, pump state, irrigation events, alarms and
settings. Commands go the other way, but they are plain HTTP `POST`/`PUT` calls with a bearer token.

## Decision
Use `GET /api/stream` (SSE, `text/event-stream`) for server-to-client events, with a 15 s heartbeat
and a snapshot of pump and alarms sent on connect. Use ordinary HTTP for everything the client sends.

## Consequences
- Works through plain HTTP on the LAN with no upgrade handshake, no extra library on either end, and
  automatic reconnect in the browser (`EventSource`).
- Auth stays identical to the REST endpoints, and the token is not needed for reads.
- Only one direction is streamed. A future bidirectional need would reopen this decision.
- Capped at 20 clients, so a runaway tab cannot exhaust the Pi.

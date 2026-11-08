# ADR 005: Safety limits enforced on the edge

Status: Accepted

## Context
The pump is the only actuator and can flood a bed or run dry. The actuator firmware is an assumed
API that another team owns, so the edge cannot rely on it alone to refuse nonsense.

## Decision
The edge enforces, before it sends any command: a maximum run (`max_run_s`), a daily budget
(`daily_max_s`) on the server's LOCAL day, a minimum interval between runs (`min_interval_s`), a
stale-sensor block on starts, a high soil threshold that stops a run, an implausible-jump filter on
soil readings, a refusal to start while the pump state is unknown, and a per-command expiry
(`command_expiry_s`) with at most `command_max_retries` sends. Manual OFF is always honoured. The
DB-down rule refuses new starts. Full table: `docs/README.md`, "Safety model".

## Consequences
- The edge is conservative by default. When in doubt it does nothing.
- Limits are runtime settings in the DB, so they can be tuned in the field. Hard upper bounds in
  the API validation stop an operator from setting nonsense.
- The edge cannot prove the pump actually stopped. It relies on the actuator's acknowledgement and
  on ADR 006.

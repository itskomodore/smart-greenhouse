# ADR 003: Rules engine as a pure function

Status: Accepted

## Context
Irrigation decisions must be testable without hardware, clocks or a database, and must be
explainable after the fact. Mixing decisions with I/O is how a pump ends up running on stale data.

## Decision
`edge/src/rules/decide.ts` takes a `RulesState` snapshot and returns a `Decision` (`start`, `stop`,
`query`, or `none`, with a reason and alarms). It performs no I/O, reads no clock (`now` is in the
state), and uses no randomness. The controller (`edge/src/controller/loop.ts`) gathers the state,
calls `decide()`, and carries out the decision through the command lifecycle. Priority order is
fixed: manual OFF, then stop conditions, then unknown-pump query, then in-flight check, then manual
ON, then auto start.

## Consequences
- Every safety rule is a unit test over plain objects, and property tests cover many
  generated states.
- The reason string is stored with each decision, so the event log says why the pump did or did not
  run.
- The controller stays responsible for ordering, persistence and retries. Rules cannot bypass them.
- Adding a rule means editing the pure function and its tests, not wiring I/O.

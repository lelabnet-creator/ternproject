# CONTEXT

## Current Task

All six milestones are implemented. J6 closes with CI and documentation in
place; the remaining work is the deferred scope recorded in BACKLOG.md.

## Key Decisions

- The probe spec is implemented twice (TypeScript and Rust) and both replay
  `schemas/conformance/` — that suite is the contract, not either codebase.
- Simulation rows are flagged `synthetic` and filtered out of the continuous
  aggregates, so demo data can never become a published uptime figure.
- Status colours were re-stepped against a computed validator after it found
  two states sitting ΔE 4.1 apart in normal vision.

## Next Steps

- Admin screens still to build: incidents, maintenances, subscribers,
  receivers, viewer access, agents, audit, settings. The APIs behind them all
  exist and are tested.
- Resolve the `List-Unsubscribe` header defect recorded in BACKLOG.md before
  sending real volume.
- `agent run` (the scheduled loop) and config-file persistence; `pair` currently
  prints the key rather than writing it.

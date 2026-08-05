# CONTEXT

## Current Task

Milestone J1 (foundation + data layer) is complete; J2 (API, auth/MFA, RBAC, ingestion, probes,
PIN pairing) is next.

## Key Decisions

- TimescaleDB `-ha` image for `timescaledb_toolkit`: `percentile_agg` rolls up, so p95 over a year
  comes from 1-minute sketches instead of raw scans.
- Incident impact is stored per control (`incident_impacts`), not as one severity per incident.
- Host ports moved to 5433 (database) and 3011 (API) — the defaults were taken on this machine.

## Next Steps

- `packages/shared`: probe spec + JSON Schema export + conformance fixtures.
- `apps/api`: Fastify with auth/rbac/tenant plugins, TOTP MFA, sessions, API keys, ingestion, SSE.
- Sweeper, probe evaluator and per-tenant retention jobs.

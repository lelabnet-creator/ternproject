# CONTEXT

## Current Task

Milestones J1 (foundation) and J2 (API, auth, ingestion, pairing) are complete. J3 is next:
design system, TERN SVG assets, PWA shell, i18n, and the public status page with its D3 charts.

## Key Decisions

- Rate limits are configurable per surface (`AUTH_RATE_LIMIT_MAX`, `PAIR_RATE_LIMIT_MAX`), raised
  for the test suite and verified by dedicated tests that lower them again.
- Ingestion accepts API keys only, never a browser session — a cookie writing measurements would
  make CSRF a data-integrity problem.
- Probe semantics live in `packages/shared` with JSON Schema + conformance fixtures under
  `schemas/`, so the Rust agent can be held to the same behaviour.

## Next Steps

- Design tokens (light/dark), TERN logo/wordmark/favicon SVGs, `BRANDING.md`.
- Vite + React shell, PWA manifest, i18n (fr/en), timezone rendering.
- Public status page `/s/:slug` and the six D3 charts + `charts/registry.ts`.

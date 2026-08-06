# Contributing to TERN

Thank you for looking. This file covers what you need to run the project and
what the review will actually check.

## Getting it running

```bash
corepack enable
pnpm install
cp .env.example .env          # then: openssl rand -hex 32  → APP_SECRET
docker compose up -d          # PostgreSQL + TimescaleDB, MailHog
pnpm db:migrate && pnpm db:seed
pnpm dev                      # API :3011, web :5173
```

The seed creates a demo tenant at <http://localhost:5173/s/acme> with 90 days of
history, and prints an admin login and an ingest key.

Ports are 5433 and 3011 rather than the defaults: a developer machine very often
already has something on 5432, and connecting to the wrong PostgreSQL is a
miserable thing to debug.

## The gate

Everything below must pass. CI runs the same commands.

```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test
cd clients/agent && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

## What review looks for

**Verify by running, not by reasoning.** A green test suite is not evidence that
a feature works. This project has already shipped a generated script that passed
191 assertions and did not parse, and a status endpoint whose query was correct
while the data behind it was not. Run the thing. Look at the page. Read the
email in MailHog.

**Say why, not what.** The code says what it does. A comment earns its place by
recording the decision behind it — what would go wrong otherwise, what was tried,
what constraint forced the shape. `// increment counter` is noise; `// unknown,
never down: silence means we stopped hearing, not that the service broke` is the
reason someone will need in a year.

**Do not weaken a test to make it pass.** If an assertion fails, the first
question is whether the assertion is right. Several of this project's better
decisions came from fixing the code a test was complaining about.

**Colour is computed, not chosen.** Status colours are validated for contrast and
colour-vision separation. If you change one, re-run the check — an earlier pair
sat ΔE 4.1 apart in _normal_ vision and nobody saw it by eye.

**Status is never colour alone.** Every state renders an icon and a text label.

## Probe semantics are a two-language contract

The probe engine exists twice: TypeScript in `packages/shared`, Rust in
`clients/agent`. Neither can import the other, so both replay the fixtures in
`schemas/conformance/`.

If you change what a probe _means_, add a fixture first. That is how the decision
reaches the other implementation, and how the next person learns it was
deliberate.

## Commits

Conventional Commits, with a body explaining the decision. The subject says what
changed; the body says why it had to.

## Security

Report vulnerabilities privately — see [SECURITY.md](./SECURITY.md). Please do
not open a public issue for them.

## Licence

AGPL-3.0-or-later. By contributing you agree your work is licensed under it.

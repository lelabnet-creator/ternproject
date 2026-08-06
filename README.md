<div align="center">

# TERN

**Multi-tenant IT service status pages — live or historized, self-hosted, open source.**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)

</div>

---

TERN publishes the health of your IT services on a status page that is public or private, per
tenant. Data comes in through an ingestion API — from the Rust agent, from your existing monitoring
via webhooks, or from a three-line script in whatever language you already use.

Named after the tern, the seabird with the longest migration of any animal: it watches, and it keeps
going.

## Why another status page

- **Multi-tenant from the schema up.** One client = one tenant, with its own components, members,
  branding, retention and domain. Not a single-team tool retrofitted.
- **Live _or_ historized.** A tenant either streams current state with a short raw window, or keeps
  a configurable history (7 days → 2 years) backed by continuous aggregates. The page adapts.
- **Visualizations that show the shape of an outage**, not a row of green dots — built on D3.
- **Push or pull.** Declarative probes (ping, TCP, HTTP with JSONPath assertions) run either
  server-side or from an agent behind your firewall, from the same specification.
- **No copy-pasting secrets.** Agents pair with a short-lived PIN code; read-only mobile access is
  granted by QR code.

## Status

Early development — the initial implementation is in progress. See
[`CONTEXT.md`](./CONTEXT.md) for where things stand and [`BACKLOG.md`](./BACKLOG.md) for what is
deliberately out of scope for now.

## Quick start

```bash
corepack enable
pnpm install
cp .env.example .env          # then set APP_SECRET: openssl rand -hex 32
docker compose up -d          # PostgreSQL + TimescaleDB, MailHog
pnpm db:migrate && pnpm db:seed
pnpm dev                      # API on :3001, web on :5173
```

The seed creates a demo tenant with 90 days of synthetic data at
<http://localhost:5173/s/acme>.

## Architecture

| Layer   | Choice                                                        |
| ------- | ------------------------------------------------------------- |
| Web     | Vite + React 19, TanStack Router/Query, Tailwind, D3          |
| API     | Fastify 5 + Zod                                               |
| Storage | PostgreSQL + TimescaleDB (hypertable + continuous aggregates) |
| ORM     | Drizzle                                                       |
| Agent   | Rust — single static binary for Linux, macOS, Windows         |

```
apps/api      Fastify API: auth, RBAC, ingestion, probes, notifications
apps/web      Vite SPA + PWA: public status page, admin, mobile viewer
packages/db   Drizzle schema, migrations, seed
packages/shared  Zod contracts, probe spec, mock data generator
clients/agent    Rust agent
schemas/      probe.schema.json + cross-language conformance fixtures
```

## The agent

One binary, three commands. It pairs with a PIN generated in the admin, writes its own config with
owner-only permissions, and runs the probes in it on a schedule.

```sh
tern-agent pair --server https://status.example.com --pin 4K7Q-92XB   # writes agent.toml (0600)
tern-agent run  --config agent.toml --once                            # every probe once, then exit
tern-agent run  --config agent.toml                                   # the scheduled loop
```

Probes are declarative — `http`, `tcp`, `ping`, `dns`, `cert` — and are evaluated by the same
assertion engine the server uses, held to the shared fixtures in `schemas/conformance/`. Two things
it does that the server cannot: real ICMP where the host permits it (falling back to a TCP connect,
and saying so, where it does not), and a bounded queue on disk so an unreachable server delays
history rather than losing it.

## Security

Local login with Argon2id, TOTP MFA (mandatory for admins), opaque session cookies, per-tenant API
keys, PIN-based agent pairing, read-only QR viewer sessions, optional IP allowlists, and an audit
trail. Found something? See [`SECURITY.md`](./SECURITY.md).

## License

[GNU AGPL-3.0-or-later](./LICENSE). Running a modified TERN as a network service means publishing
your modifications.

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

## Documentation

[`docs/`](./docs/) — [architecture](./docs/architecture.md), the
[data model](./docs/data-model.md), [data exchange](./docs/data-exchange.md), the
[probe specification](./docs/probes.md), [operations](./docs/operations.md) and the
[security model](./docs/security.md). Written for a developer changing TERN and a systems
administrator running it.

[`BACKLOG.md`](./BACKLOG.md) records what is deliberately out of scope, and the open defects, with
reasoning.

## Quick start

Linux and macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/tern-status/tern/main/scripts/quickstart.sh | sh
```

Windows, in PowerShell 7 or later:

```powershell
irm https://raw.githubusercontent.com/tern-status/tern/main/scripts/quickstart.ps1 | iex
```

Clone, secret, database, migrations, demo tenant, dev server. It checks git,
Docker and Node 22+ before doing anything and reports everything missing at
once, waits for PostgreSQL to actually accept connections rather than for the
container to start, and is safe to re-run — an existing `.env` and its secret
are left alone.

Piping a script into a shell is a trust decision, and not one you owe anybody.
Read it first if you would rather:

```bash
curl -fsSL https://raw.githubusercontent.com/tern-status/tern/main/scripts/quickstart.sh -o quickstart.sh
less quickstart.sh
sh quickstart.sh
```

Or do it by hand — the script does nothing these six lines do not:

```bash
corepack enable
pnpm install
cp .env.example .env          # then set APP_SECRET: openssl rand -hex 32
docker compose up -d --wait   # PostgreSQL + TimescaleDB, MailHog
pnpm db:migrate && pnpm db:seed
pnpm dev                      # API on :3011, web on :5173
```

The seed creates a demo tenant with 90 days of synthetic data.

| What        | Where                            |
| ----------- | -------------------------------- |
| Public page | <http://localhost:5173/s/acme>   |
| Admin       | <http://localhost:5173/app/acme> |
| Caught mail | <http://localhost:8025>          |

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
tern-agent doctor                                                     # why is it not reporting?
tern-agent status                                                     # probes, interval, queue depth
tern-agent queue-clear                                                # discard what is buffered
```

Pairing hands the agent its probes: the server knows what the tenant monitors, so there is no
config to copy onto the host. It asks again on every start, so a control added in the admin is
picked up after a restart — while a probe you added to the file by hand is left alone.

`--log-level`, `--log-json` and `--log-file` apply to every command (also as `TERN_LOG`,
`TERN_LOG_JSON`, `TERN_LOG_FILE`). `doctor` exits non-zero when something is actually broken, so it
drops into a post-install step or a monitoring check unchanged.

Probes are declarative — `http`, `tcp`, `ping`, `dns`, `cert` — and are evaluated by the same
assertion engine the server uses, held to the shared fixtures in `schemas/conformance/`. Two things
it does that the server cannot: real ICMP where the host permits it (falling back to a TCP connect,
and saying so, where it does not), and a bounded queue on disk so an unreachable server delays
history rather than losing it.

## Isolated networks

`tern-proxy` relays for a zone with no route to the internet. It **speaks the same API as TERN**,
so an agent pointed at a proxy is an ordinary agent — it pairs, asks for its jobs and pushes
points, and nothing in its config says which end it is talking to.

```sh
# On the one host with egress:
tern-proxy init --server https://status.example.com --pin 4K7Q-92XB --listen 0.0.0.0:8787
tern-proxy run
tern-proxy pin                    # mint a PIN for one agent in the zone

# On an agent that can only reach the proxy:
tern-agent pair --server http://proxy.internal:8787 --pin 72U1-3UK4
```

The upstream credential never enters the isolated zone: the proxy issues its own keys, so a
compromised host in there cannot reach TERN directly, and revoking the proxy revokes the zone. It
caches the assignment, so agents restarting during an upstream outage still get their jobs, and it
buffers their points on disk and replays them when the link returns.

## Security

Local login with Argon2id, TOTP MFA (mandatory for admins), opaque session cookies, per-tenant API
keys, PIN-based agent pairing, read-only QR viewer sessions, optional IP allowlists, and an audit
trail. Found something? See [`SECURITY.md`](./SECURITY.md).

## License

[GNU AGPL-3.0-or-later](./LICENSE). Running a modified TERN as a network service means publishing
your modifications.

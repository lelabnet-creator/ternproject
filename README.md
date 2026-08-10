<div align="center">

# TERN

**IT service status pages — live or historized, self-hosted, open source.**

[![CI](https://github.com/lelabnet-creator/ternproject/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/lelabnet-creator/ternproject/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/lelabnet-creator/ternproject?sort=semver)](https://github.com/lelabnet-creator/ternproject/releases)
[![Image](https://img.shields.io/badge/ghcr.io-ternproject-blue?logo=docker&logoColor=white)](https://github.com/lelabnet-creator/ternproject/pkgs/container/ternproject)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)

</div>

---

TERN publishes the health of your IT services on a status page. Data comes
in through an ingestion API — from the Rust agent, from your existing monitoring via webhooks, or
from a three-line script in whatever language you already use.

**One instance serves one status page.** Nothing in the API creates a tenant: the page is created
once at install and that is the one the instance serves. The schema underneath is tenant-scoped
throughout — every table carries `tenant_id` and isolation is enforced in one place — so hosting
several later is a feature to build, not a migration to survive. It is not a feature today, and this
is not a product for hosting other people's status pages.

Named after the tern, the seabird with the longest migration of any animal: it watches, and it keeps
going.

## Why another status page

- **Tenant-scoped from the schema up.** Components, members, branding, retention and domain hang off
  a tenant rather than off globals. Not a single-team tool retrofitted — but one tenant is what an
  instance runs today.
- **Live _or_ historized.** The page either streams current state with a short raw window, or keeps
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

## Running an instance

One command, in an empty directory, and it asks what it needs to know: the name
of the status page, the administrator's account, and the SMTP server used for
double opt-in, incident notifications and password recovery.

```bash
curl -fsSL -o setup.sh https://raw.githubusercontent.com/lelabnet-creator/ternproject/main/scripts/setup.sh && sh setup.sh
```

No clone. The script fetches `docker-compose.prod.yml`, the only other file an
installation reads, and pulls a published multi-architecture image (amd64 and
arm64) — finding no sources beside it, there is nothing it could build.

It is downloaded rather than piped into `sh` because it asks questions, and a
pipe leaves it no terminal to ask on; it refuses in that case rather than
writing an instance full of blank answers. Landing the file first also means
you can read it before running it.

From a checkout, the same script builds from your working tree instead — which
is what you want if you have changed anything, and slower:

```bash
./scripts/setup.sh
```

Set `TERN_IMAGE` there to pull a published image rather than build.

Either way it writes `.env` (mode 600), starts the stack, runs the migrations,
creates the tenant and waits for the instance to answer — so when it returns,
the page is up. Re-running it keeps the previous answers as defaults, and never
regenerates `APP_SECRET`.

Afterwards the stack is ordinary Compose:

```bash
docker compose -f docker-compose.prod.yml up -d      # start
docker compose -f docker-compose.prod.yml logs -f app
docker compose -f docker-compose.prod.yml down       # stop, data kept
```

One container serves both the API and the web app on the same origin, so there
is no CORS to configure and no second service to place. Behind a reverse proxy,
set `PUBLIC_BASE_URL` to the external URL and `TRUSTED_PROXIES` to the proxy's
CIDR — rate limits and the audit log both key on the client address.

Back up two things: the database, and the `tern-data` volume. That volume holds
`APP_SECRET`, and without it the TOTP secrets, probe credentials and subscriber
addresses in the dump cannot be decrypted.

Upgrading is a pull and a recreate — the entrypoint migrates before the server
binds, and pinning a version is what stops an unattended restart from moving you
onto a release you have not read:

```bash
TERN_IMAGE=ghcr.io/lelabnet-creator/ternproject:1.0.0
docker compose -f docker-compose.prod.yml pull app
docker compose -f docker-compose.prod.yml up -d
```

## Quick start (development)

Clones the repository and runs the app from source with demo data — not an
installation. For an instance to actually use, see above.

Linux and macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/lelabnet-creator/ternproject/main/scripts/quickstart.sh | sh
```

Windows, in PowerShell 7 or later:

```powershell
irm https://raw.githubusercontent.com/lelabnet-creator/ternproject/main/scripts/quickstart.ps1 | iex
```

Clone, secret, database, migrations, demo tenant, dev server. It checks git,
Docker and Node 22+ before doing anything and reports everything missing at
once, waits for PostgreSQL to actually accept connections rather than for the
container to start, and is safe to re-run — an existing `.env` and its secret
are left alone.

Piping a script into a shell is a trust decision, and not one you owe anybody.
Read it first if you would rather:

```bash
curl -fsSL https://raw.githubusercontent.com/lelabnet-creator/ternproject/main/scripts/quickstart.sh -o quickstart.sh
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

Binaries for Linux (x86_64 and arm64, musl), macOS (Apple silicon and Intel) and Windows are built
on every push to `main` and attached to each `v*` tag, with a single `SHA256SUMS` beside them.

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
keys, PIN-based agent pairing, read-only QR viewer sessions, and an audit trail. Found something? See [`SECURITY.md`](./SECURITY.md).

## Supporting TERN

This repository is not a trial. What you clone is the product — multi-tenancy, probes, the agent,
notifications, history — under AGPL, with no cap on components or tenants and nothing to unlock.

A hosted version with some premium features is planned; it is not available yet. Until then the
project moves at the speed the people using it can fund.
[GitHub Sponsors](https://github.com/sponsors/lelabnet-creator) pays for the code signing certificates
that would stop the macOS and Windows builds tripping security warnings, for the time it takes to
track advisories and keep dependencies current, and for outside review of code that authenticates
everybody and sees everything.

No budget is fine. A precise bug report, a translation or a fix is worth a great deal and costs less
— see [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

[GNU AGPL-3.0-or-later](./LICENSE). Running a modified TERN as a network service means publishing
your modifications.

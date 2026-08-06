# Operations

For whoever has to keep this running.

## Installing

```bash
./scripts/setup.sh
```

Asks for the tenant, the administrator and the SMTP server, writes `.env`,
builds the image and starts `docker-compose.prod.yml`. The container's
entrypoint settles `APP_SECRET`, applies the migrations and creates the tenant
before the server binds — all three idempotent, so a restart repeats none of
them.

`APP_SECRET` is the one value that must survive. Supplied in the environment it
is used as given; left empty it is generated once into `/var/lib/tern` on the
`tern-data` volume and reused on every later boot. It encrypts TOTP secrets,
probe auth headers and subscriber addresses — a fresh one does not fail, it
silently makes all of them unreadable. Back that volume up with the database.

The production stack runs under its own compose project name (`tern-prod`),
because `docker-compose.yml` already claims `tern` — two files sharing a
project name means the second one recreates the first one's containers.

Its database publishes no host port. That is both one less exposure and one
less collision on a machine that already runs PostgreSQL.

### From source, for development

```bash
corepack enable
pnpm install
cp .env.example .env          # then: openssl rand -hex 32  → APP_SECRET
docker compose up -d          # PostgreSQL + TimescaleDB, MailHog
pnpm db:migrate && pnpm db:seed
pnpm dev
```

The compose file pins **`timescaledb-ha`**, not the plain `timescaledb` image.
The aggregates use `percentile_agg` from `timescaledb_toolkit`, which the plain
image does not carry — the failure is a migration that stops on an unknown
function.

The seed creates a demo tenant with 90 days of synthetic data at
`/s/acme`, admin `admin@acme.example` / `tern-demo-password`. Seeding takes
about two minutes.

## Configuration

Everything is environment variables, validated at boot by
`apps/api/src/config.ts` — the process refuses to start on a bad value rather
than failing later on a request.

| Variable                                          | Default        | What it decides                                                                                                                           |
| ------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_SECRET`                                      | —              | Signs sessions and encrypts stored secrets. **Rotating it invalidates every session and makes encrypted subscriber addresses unreadable** |
| `DATABASE_URL`                                    | —              | PostgreSQL                                                                                                                                |
| `PUBLIC_BASE_URL`                                 | —              | Appears in generated scripts, pairing commands and email links                                                                            |
| `DB_POOL_MAX`                                     | 10             | Connections per API instance. Each is a backend process                                                                                   |
| `INGEST_RATE_LIMIT_MAX`                           | 600            | Ingest requests per minute per API key                                                                                                    |
| `AUTH_RATE_LIMIT_MAX`                             | 10             | Sign-in attempts per minute per IP                                                                                                        |
| `PAIR_RATE_LIMIT_MAX`                             | 10             | Pairing attempts per minute per IP                                                                                                        |
| `SUBSCRIBE_RATE_LIMIT_MAX`                        | 5              | Subscription attempts per minute per IP                                                                                                   |
| `SMTP_HOST`/`_PORT`/`_USER`/`_PASSWORD`/`_SECURE` | localhost:1025 | Mail. Shared by every tenant                                                                                                              |
| `MAIL_FROM`                                       | —              | Envelope sender                                                                                                                           |
| `LOG_LEVEL`                                       | info           |                                                                                                                                           |

### Sizing

The admin's **Capacity** screen computes what the deployment needs from what it
measures — agents, controls, retention — and marks where the current value is
below it. The arithmetic is in `packages/shared/src/sizing.ts`; the two facts
worth internalising:

- **One ingest request per agent per run**, not per point: an agent batches its
  probes. Sizing on points over-provisions by the probe count.
- **The connection pool is the scarce resource.** Past about 40 the answer is a
  pooler, not a bigger number — the recommendation caps there and says so.

Rough storage: 160 bytes per raw point before compression. 100 agents × 10
probes × one minute × 90 days ≈ 13 M points ≈ 2 GB, compressed after a day.

## Running

The API serves the built web app and the API. `/health` answers
`{"status":"ok"}` and is the thing to watch — **nothing inside TERN watches
TERN**. If the API is down, the staleness sweep does not run, so a status page
left up by a dead API shows the last state it knew rather than going unknown.

Behind a reverse proxy, forward the real client IP: rate limits and the audit
log both key on it.

The API serves more than `/api`. Route these to it too, or the SPA's catch-all
will answer them with HTML — and `curl … /install.sh | sh` then pipes a web page
into a shell, which fails with a syntax error that says nothing about why:

```
/api/    /install.sh    /install.ps1    /badge/    /health
```

## Backups

One database. `pg_dump` is enough for everything except the hypertable's size at
scale:

```bash
docker compose exec db pg_dump -U tern -Fc tern > tern-$(date +%F).dump
```

Restoring needs the TimescaleDB extension present before the restore, and
`timescaledb_pre_restore()` / `timescaledb_post_restore()` around it. Test a
restore before needing one.

What is **not** in the database: `APP_SECRET`. A restore without it gives you
rows whose encrypted columns cannot be read and sessions that cannot be
validated. Back it up separately, and not beside the dump.

## Upgrading

```bash
git pull && pnpm install
pnpm --filter @tern/db migrate     # idempotent, and applies the Timescale SQL too
pnpm build && restart the API
```

Migrations are forward-only. There is no down migration, deliberately: a
rehearsed restore is a better answer than a reverse migration nobody has run.

## The agents

They are independent of the server's lifecycle: an agent whose server is
unreachable keeps measuring and buffers to disk (5 000 points, oldest dropped
first). Nothing needs restarting after a server upgrade.

To diagnose one:

```sh
tern-agent doctor          # config, permissions, queue, server, key, DNS, clock, ICMP
tern-agent status          # what it runs, and how much is waiting
tern-agent run --once      # every probe once, then exit
```

`doctor` exits non-zero on a real failure, so it drops into a post-install step
or a monitoring check unchanged.

Two of its checks catch silent failures worth knowing about:

- **The clock.** The server clamps timestamps it cannot believe, so a host years
  out produces no error — it produces measurements that never appear.
- **The config permissions.** `agent.toml` holds a live ingest key. 0644 in a
  directory somebody later archives is how it leaks.

## What breaks first

In roughly the order it happens as an installation grows:

1. **The ingest rate limit**, when a fleet grows or intervals shorten. Symptom:
   429s in agent logs, gaps on the page. The Capacity screen predicts it.
2. **The connection pool**, when agents and viewers arrive together. Symptom:
   slow requests everywhere, not just ingest.
3. **Aggregate refresh lag**, when raw volume outgrows the refresh window.
   Symptom: the public page trails the admin by minutes. Lengthen the probe
   interval before raising retention.
4. **Disk**, from raw points. Compression after a day helps; retention is the
   real lever.

None of these is a code change. All four are visible on the Capacity screen
before they bite.

## Known limitations

Recorded in `BACKLOG.md` with reasoning. The two that affect operations:

- **`List-Unsubscribe` is not sent.** The header does not reach the wire in this
  setup and the cause is not yet found. Bulk senders increasingly require it, so
  resolve it before sending real volume. The in-body unsubscribe link works.
- **Named metrics are not on the public page.** They are ingested, stored and
  drawn in the admin, but the public page reads the daily rollups and the
  aggregates do not roll up a JSONB map.

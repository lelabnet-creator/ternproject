# Administrator guide

For whoever installs a TERN instance and keeps it alive afterwards.

It assumes you have a machine, a shell and Docker, and that you are not going to
change TERN's code. It is the order things happen in — install, configure, back
up, upgrade, watch, repair — rather than a reference. Where a reference already
exists this page links to it instead of restating it:
[operations](./operations.md) for sizing and what breaks first,
[security](./security.md) for the threat model,
[data exchange](./data-exchange.md) for every endpoint,
[architecture](./architecture.md) for why the pieces are where they are.

The screens themselves — writing an incident, arranging components, inviting
members — are somebody else's guide. This one stops at the login page.

## What an instance is

One instance serves **one status page**. Nothing in the API creates a second
one. The page is made once, at install, and that is the page this instance
serves for the rest of its life.

Three containers, two volumes, one file:

| Piece              | What it is                                                                             |
| ------------------ | -------------------------------------------------------------------------------------- |
| `app`              | One Node process serving both the API and the built web app on the same origin         |
| `db`               | PostgreSQL 16 with TimescaleDB (`timescale/timescaledb-ha:pg16`)                       |
| `agent`            | The same image as `app`, running the Rust agent binary — see [the agents](#the-agents) |
| volume `db-data`   | The database cluster                                                                   |
| volume `tern-data` | `APP_SECRET`, the local agent's `agent.toml` and its offline queue                     |
| `.env`             | Everything the stack is configured with, mode 600                                      |

The API and the web app share an origin on purpose, so there is no CORS to
configure and no second service to place. The database publishes no host port:
one less exposure, and one less collision on a machine that already runs
PostgreSQL.

There is no message broker, no cache tier and no worker fleet. The scheduled
work — notification delivery, the staleness sweep, retention, maintenance
transitions — runs on timers inside the API process. That is a ceiling rather
than an oversight, and it has one consequence worth carrying into every decision
below: **when the API process is not running, none of that happens.** A status
page left up by a dead API keeps showing the last state it knew.

## Before you install

You need:

- **Docker with Compose v2.** The installer checks `docker compose version` and
  that the daemon answers, and stops if either is missing.
- **A terminal.** The installer asks questions and refuses to run without one on
  standard input, rather than writing an instance full of blank answers. That is
  also why it is downloaded and then run, never piped into `sh`.
- **`curl`**, if you are running the script outside a checkout — it fetches the
  compose file it needs.
- **A hostname you intend to keep.** Passkeys bind to the host in
  `PUBLIC_BASE_URL`. Moving the instance from `status.example.com` to
  `status.example.net` stops every registered passkey working there. That is the
  guarantee, not a defect — it is what stops a lookalike domain replaying one —
  but it is much cheaper to decide the name now.
- **TLS, in front.** TERN terminates plain HTTP on the port you publish. Passkeys
  need a secure context (https, or http on `localhost`), the agent refuses to
  carry an ingest key over plain HTTP to anything but localhost, and a session
  cookie on a clear channel is a session cookie somebody else has.

Sizing the machine is a separate question, answered by the admin's **Capacity**
screen once the instance is up. The short version: the connection pool is the
scarce resource, and raw points cost about 160 bytes each before compression.
The arithmetic and the failure modes are in
[operations → sizing](./operations.md#sizing).

## Installing

### The normal path

In an empty directory:

```bash
curl -fsSL -o setup.sh https://raw.githubusercontent.com/lelabnet-creator/ternproject/main/scripts/setup.sh
sh setup.sh
```

No clone. The script fetches `docker-compose.prod.yml` — the only other file an
installation reads — and, finding no sources beside it, pulls the published
multi-architecture image rather than trying to build from an empty context.

It asks three things:

| Question            | Default                   | What it decides                                                         |
| ------------------- | ------------------------- | ----------------------------------------------------------------------- |
| Host port           | `8080`                    | The port published in front of the app, mapped to 3011 in the container |
| Public URL          | `http://localhost:<port>` | `PUBLIC_BASE_URL` — see [configuration](#configuration); get this right |
| Trusted proxy CIDRs | empty                     | `TRUSTED_PROXIES`. Leave empty unless something really is in front      |

Then it writes `.env` with mode 600, generates `POSTGRES_PASSWORD` and
`APP_SECRET` if they are not already there, checks the storage (see below),
starts the stack with `--wait`, and returns only once the health check passes —
which is after the migrations and after the page exists, not merely after the
container started.

It is re-runnable. Values already in `.env` become the defaults, and
`APP_SECRET` is **never** regenerated once set.

One thing to know before re-running it: it rewrites `.env` from a fixed
template. Variables you added by hand — `SMTP_HOST`, `INGEST_RATE_LIMIT_MAX`,
anything — are not carried over. The previous file is copied to `.env.bak`
first, so nothing is lost, but you have to put them back.

### From a checkout

```bash
./scripts/setup.sh
```

Identical, except that it builds the image from your working tree instead of
pulling one. That is what you want if you have changed anything, and it is
slower. Set `TERN_IMAGE` to pull a published tag instead:

```bash
TERN_IMAGE=ghcr.io/lelabnet-creator/ternproject:1.0.0 ./scripts/setup.sh
```

The value is appended to `.env`, so every later `docker compose` command targets
the same image this start did.

### The storage check

Before it starts anything, the installer inspects an existing `tern-prod-db-1`
container and **refuses to continue** if the database volume is mounted at
`/var/lib/postgresql/data`. That path belongs to the plain `postgres` image;
`timescaledb-ha` keeps `PGDATA` at `/home/postgres/pgdata`. An installation in
that state is keeping its database in the container's writable layer. Read
[what to do about it](#if-you-installed-before-the-storage-fix) before doing
anything else — remounting without dumping first would present an empty database
in place of yours.

After the stack is up it checks the running container rather than the file: that
`$PGDATA/PG_VERSION` exists and that `/home/postgres/pgdata` really is a mount.
A database that is not on a volume survives everything until the day it does
not, and that day is a routine `docker compose up -d`.

### The first-run window, and closing it

A freshly installed instance has a page and nobody who can administer it.
`POST /api/v1/setup/account` needs no authentication — it cannot, there is no
account to authenticate as — and it is open only while the instance holds zero
users. The first successful call closes it permanently; every later one answers
409, including calls that arrive at the same moment.

**Whoever opens the admin first becomes the administrator.** The installer says
so, and it is why it tells you to open the page now rather than later.

If the instance will be reachable before anyone gets to it — a public DNS record
that already resolves, a deployment pipeline that finishes overnight — provision
the account instead, and the window never opens:

```bash
# in .env, before the first start
TERN_TENANT_SLUG=acme
TERN_TENANT_NAME=Acme Corp
TERN_ADMIN_EMAIL=you@example.com
TERN_ADMIN_NAME=Your Name
TERN_ADMIN_PASSWORD=…          # 8 characters minimum
```

`TERN_ADMIN_EMAIL` and `TERN_ADMIN_PASSWORD` are both-or-neither: an address
with no password creates an account nobody can sign into, which looks like
success. Provisioning is idempotent and never touches a tenant or an account
that already exists, so leaving these in `.env` afterwards is harmless — though a
plain password in a file that stays on disk is its own decision.

### The first visit

Open `PUBLIC_BASE_URL/app`. The admin resolves the page's slug from the database,
so `/app` is enough; the public page is at `/s/<slug>`.

The wizard names the page, creates your account, and sends you to enrol MFA —
**mandatory for admins**, and a session that has passed the password but not the
second factor can do nothing but complete it. The mail step goes through the
ordinary settings endpoints, so nothing it configures is unreachable later from
the same screens.

### What the development stack is not

`docker-compose.yml`, `pnpm dev`, `pnpm db:seed` and `scripts/quickstart.sh` are
the from-source development path. They run under the compose project name `tern`
rather than `tern-prod`, publish a database on host port 5433, run a mail catcher
that swallows every message, and the seed creates a demo tenant with three
months of invented history and a password printed on the terminal.

Useful to look at. Ruinous to deploy. If you want to run a real instance from
source, use `./scripts/setup.sh` from the checkout, which builds the same
production stack from your tree.

## Configuration

Everything is environment variables, validated at boot by
`apps/api/src/config.ts`. The process prints every problem it found and exits
rather than starting and failing later on a request. `APP_SECRET` shorter than 32
characters, or still set to the placeholder from `.env.example`, is one of those
problems.

### What each variable decides

| Variable                     | Default                            | Decides                                                                                                             |
| ---------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `APP_SECRET`                 | generated into `tern-data`         | Session signing, and encryption of TOTP secrets, probe auth headers, SMTP passwords and subscriber addresses        |
| `DATABASE_URL`               | —                                  | PostgreSQL. Set by the compose file to the `db` service                                                             |
| `PUBLIC_BASE_URL`            | `http://localhost:5173`            | The CORS origin, the passkey RP ID, the URL in generated install scripts, pairing commands, mail links and badges   |
| `API_PORT` / `API_HOST`      | `3011` / `0.0.0.0`                 | Where the process listens inside the container                                                                      |
| `TRUSTED_PROXIES`            | empty                              | Comma-separated CIDRs whose `X-Forwarded-For` is believed. Empty means the header is ignored entirely               |
| `DB_POOL_MAX`                | `10`                               | PostgreSQL connections for this API process. Each is a backend process                                              |
| `INGEST_RATE_LIMIT_MAX`      | `600`                              | Ingest requests a minute, per API key                                                                               |
| `AUTH_RATE_LIMIT_MAX`        | `10`                               | Sign-in and first-run attempts a minute, per IP                                                                     |
| `PAIR_RATE_LIMIT_MAX`        | `10`                               | Pairing redemptions a minute, per IP                                                                                |
| `SUBSCRIBE_RATE_LIMIT_MAX`   | `5`                                | Subscription attempts a minute, per IP                                                                              |
| `SMTP_HOST` … `SMTP_SECURE`  | `localhost:1025`                   | The instance's fallback mail server — see [mail](#mail-and-notifications)                                           |
| `MAIL_FROM`                  | `TERN Status <status@example.com>` | The fallback sender                                                                                                 |
| `LOG_LEVEL`                  | `info`                             | `silent` … `trace`                                                                                                  |
| `TERN_LOCAL_AGENT`           | `true`                             | Whether the instance runs `Agent-local-tern` for itself                                                             |
| `TERN_LOCAL_AGENT_SUPERVISE` | `true`                             | Whether the API process starts the agent binary. The production stack sets this `false`; Docker supervises instead  |
| `TERN_LOCAL_AGENT_SERVER`    | empty                              | The address written into `agent.toml`. Empty means this process's loopback, which is correct in both shipped stacks |
| `TERN_DATA_DIR`              | `/var/lib/tern` in production      | Where `agent.toml` and the offline queue live. A relative path resolves from the repository root                    |
| `APP_SECRET_FILE`            | `/var/lib/tern/app_secret`         | Read by the container entrypoint only, where it keeps the generated secret                                          |

Read once at boot by the entrypoint, then ignored: `TERN_TENANT_SLUG`,
`TERN_TENANT_NAME`, `TERN_DEFAULT_LOCALE`, `TERN_DEFAULT_TIMEZONE`,
`TERN_ADMIN_EMAIL`, `TERN_ADMIN_NAME`, `TERN_ADMIN_PASSWORD`. Provisioning never
touches a tenant that already exists.

Read by Compose, not by the application: `POSTGRES_PASSWORD`, `TERN_HTTP_PORT`,
`TERN_IMAGE`.

### Three of those do not reach a Docker install

`docker-compose.prod.yml` passes a fixed list of variables into the container.
`AUTH_RATE_LIMIT_MAX`, `PAIR_RATE_LIMIT_MAX` and `SUBSCRIBE_RATE_LIMIT_MAX` are
not on it, and neither is `TERN_LOCAL_AGENT_SERVER` or `TERN_DATA_DIR`. Compose
reads `.env` for substitution into the compose file, not as an environment for
the service, so setting one of these in `.env` on a Docker install has no effect
and says nothing about it.

To change one, add it to the `app` service's `environment:` block yourself. The
defaults are deliberately tight and most installations should leave them alone —
but a limit you believe you have raised and have not is worth knowing about.

### What is not configured here

The page's name, its branding, its retention window, its components, its SMTP
server, its notification channels and its members all live in the database and
are edited in the admin. They are per-tenant settings, and a tenant admin is
expected to get them wrong occasionally without an operator being involved.

## Where the data lives

| What                                           | Where                                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| Everything the product knows                   | Volume `tern-prod_db-data`, mounted at `/home/postgres/pgdata`          |
| `APP_SECRET`, when generated rather than given | Volume `tern-prod_tern-data`, file `/var/lib/tern/app_secret`, mode 600 |
| The local agent's key and offline queue        | The same volume: `agent.toml` (mode 600) and `agent-queue.jsonl`        |
| The stack's own configuration                  | `.env` beside the compose file, mode 600                                |

**`APP_SECRET` is not in the database.** It encrypts TOTP secrets, probe
authentication headers, tenant SMTP passwords and subscriber addresses. A
restore without it does not fail — it gives you rows whose encrypted columns
cannot be read, and sessions that cannot be validated. Back it up separately,
and not in the same place as the dump: a dump plus the secret is everything
except the passwords, which stay Argon2id hashes. The full table of what each
stolen artefact yields is in [the security model](./security.md).

### Backing up

Two things, and a third that is only convenience.

```bash
# 1. The database
docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U tern -Fc tern > tern-$(date +%F).dump

# 2. APP_SECRET — somewhere else entirely
docker compose -f docker-compose.prod.yml exec -T app cat /var/lib/tern/app_secret

# 3. .env, so a rebuild does not need the questions asked again
```

`agent.toml` is deliberately absent from that list. It holds a live ingest key,
and the instance rewrites it with a fresh key whenever the row exists and the
file does not — which is exactly what a restore onto a new volume looks like.
Losing it costs nothing; copying it around costs a credential.

`pg_dump` is enough at any size this deployment reaches. It is a logical dump,
so the restore rebuilds the hypertable rather than copying its chunks — slower
than a file-level copy, and portable across PostgreSQL versions, which matters
more here.

### Restoring

Restore into an **empty** database. The container entrypoint migrates on every
boot, so a schema will already be there if you let `app` start first.

```bash
C="docker compose -f docker-compose.prod.yml"

$C down
$C up -d db                                        # the database alone

$C exec -T db psql -U tern -d postgres -c 'DROP DATABASE IF EXISTS tern'
$C exec -T db psql -U tern -d postgres -c 'CREATE DATABASE tern'
$C exec -T db psql -U tern -d tern -c 'CREATE EXTENSION IF NOT EXISTS timescaledb'
$C exec -T db psql -U tern -d tern -c 'SELECT timescaledb_pre_restore()'

$C exec -T db pg_restore -U tern -d tern --no-owner < tern-2026-08-08.dump

$C exec -T db psql -U tern -d tern -c 'SELECT timescaledb_post_restore()'
$C up -d
```

The extension has to exist before the restore, and
`timescaledb_pre_restore()` / `timescaledb_post_restore()` have to bracket it —
that is TimescaleDB's requirement, not TERN's. Put `APP_SECRET` back in `.env`,
or the file back on the `tern-data` volume, before starting `app`.

**Rehearse this.** There is no down migration anywhere in TERN, deliberately: a
restore somebody has actually performed is a better answer than a reverse
migration nobody has ever run. That is only true if you have performed it.

### If you installed before the storage fix

Both compose files used to mount the database volume at
`/var/lib/postgresql/data`. `timescaledb-ha` never writes there, so the mount
did nothing and the cluster lived in the container's writable layer — where any
`docker compose up -d` that recreated the container, a routine upgrade or a
changed port, took the database with it.

If `./scripts/setup.sh` refuses to start and tells you the installation stores
its database in the container, this is why. Your data is still there. Get it out
before anything recreates that container:

```bash
docker exec tern-prod-db-1 pg_dump -U tern -Fc tern > tern-before-migration.dump
docker compose -f docker-compose.prod.yml down
```

Then update the compose file — `git pull` in a checkout, or re-download it — and
run `./scripts/setup.sh`. It starts on a fresh, correctly mounted volume with an
empty database. Restore the dump into it as above.

Do not shortcut this by editing the mount path and restarting. The container
would come up on an empty volume, without a word, and the old writable layer
goes with the container that was replaced.

## Upgrading

Pin a version. `latest` means an unattended restart can move you onto a release
you have not read.

```bash
# in .env
TERN_IMAGE=ghcr.io/lelabnet-creator/ternproject:1.0.0

docker compose -f docker-compose.prod.yml pull app agent
docker compose -f docker-compose.prod.yml up -d
```

`app` and `agent` run the same image on purpose, so the agent's version and the
server's cannot drift. Pull both.

The entrypoint applies migrations before the server binds, retrying for up to ten
attempts three seconds apart while a freshly started PostgreSQL finishes coming
up. Migrations are forward-only. The TimescaleDB layer is re-applied whenever its
checksum changes, and every statement in it is idempotent.

Take a dump first. Not because upgrades have gone wrong, but because the recovery
path from a migration you dislike is a restore, and a restore needs a dump from
before it.

From a source checkout, without Docker:

```bash
git pull && pnpm install
pnpm db:migrate            # Drizzle DDL, then the TimescaleDB SQL
pnpm build                 # then restart the API
```

Agents need nothing. They are independent of the server's lifecycle: one whose
server is unreachable keeps measuring and buffers to disk, 5 000 points, oldest
dropped first.

## Watching the instance

**Nothing inside TERN watches TERN.** The scheduled work runs in the API process,
so if that process is gone, so is the staleness sweep — and a status page that
stops being updated does not go unknown, it keeps showing the last state it knew.
Something outside has to watch.

### From outside

`GET /health` answers `{"status":"ok"}`, and it reaches the database to do it —
it runs `SELECT 1`, so a healthy reply means the process is up _and_ its
connection to PostgreSQL works. That is the endpoint to point your other
monitoring at.

The image also carries a `HEALTHCHECK` that fetches the same endpoint from
inside the container, which is what `docker compose up --wait` and
`depends_on: service_healthy` wait for.

The `agent` service has its health check **disabled**, deliberately. It shares
the API's network namespace, so the image's check would succeed by reporting the
API's health as the agent's — worse than no check. Whether the agent is
reporting is a question the fleet screen answers.

### From inside

**Logs → Monitoring** in the admin reports what the HTTP layer is doing:
requests a minute by class (ingest, agent, admin, public), replies that were rate
limited, p50 and p95 per class, requests in flight, and how much of `DB_POOL_MAX`
is checked out. Windows from 1 to 120 minutes.

Two limits it states on the screen rather than in a footnote. The counters live
in memory, so **it describes one API process** — behind a load balancer each
container keeps its own and neither knows about the other, which is why the tab
names the instance at the top. And latencies come from a histogram, so each
figure is the bound the sample fell under, not an exact number; past the last
bucket it reports `> 10 s` rather than inventing one.

The split by audience is worth knowing before somebody asks why they cannot see a
number you can: **a tenant admin sees their own agents' push rates** — which host
is generating the load. The instance-wide figures, the rate-limit tally and the
pool go only to an admin of the system tenant, because on an instance hosting
more than one page they describe shared machinery no single customer should
read.

The pool figure comes from `pg_stat_activity`, filtered on this process's
`application_name`. A database role that may not read that view gets zeroes and a
warning in the log rather than a broken screen.

**Logs** itself is the audit trail: sign-ins, pairings, revocations, control
edits, layout changes, mail tests, webhook changes, with actor, target, IP and a
JSONB payload. It is written on the same connection as the change it records, so
there is no queue to lose. It can be mirrored to a syslog collector — RFC 5424 or
JSON, UDP or TCP — configured per tenant. Mirroring is best effort and never
retried: a collector that is down must not make the action that produced the
event fail.

The **Capacity** screen computes what the deployment needs from what it measures
and marks where the configured value is below it. It is the forecast; Monitoring
is the measurement. [What breaks first, and in what
order](./operations.md#what-breaks-first) is the list to read before it does.

### The process log

`LOG_LEVEL` controls it. The logger removes `authorization`, `cookie` and
`set-cookie` from every line — a log file is not a place to keep credentials.
Background jobs log only when something actually happened, so a quiet instance
does not produce a line per job per tick.

```bash
docker compose -f docker-compose.prod.yml logs -f app
docker compose -f docker-compose.prod.yml logs -f agent
```

## The agents

Measurements reach TERN by being pushed. An agent is one way to push them; a
generated script or an existing monitoring system through a webhook are the
others. [Data exchange](./data-exchange.md) covers all of them.

### `Agent-local-tern`

Every instance runs one agent for itself, so a fresh install does not sit at
`unknown` until somebody deploys one. It is **provisioned, not paired** — no PIN,
because the server issuing the invitation is the machine accepting it — and it
appears in the fleet marked _this instance_.

It cannot be revoked or deleted: the API answers 409 and the admin does not draw
the button. Deleting it would leave an `agent.toml` on disk holding a key for an
agent the server had forgotten, and the next reconcile would make a second one.
`TERN_LOCAL_AGENT=false` is how you turn it off, and renaming it is fine — the
name is only a label.

In the production stack it is its own container, supervised by Docker's
`restart: unless-stopped`, because the point of a separate process is that it
keeps measuring and buffering while the API restarts. It shares the API
container's network namespace, so `127.0.0.1:3011` genuinely is the API and the
ingest key never touches a network interface. Two consequences: that container
can publish no ports, and the only channel between the two containers is
`agent.toml` on the shared `tern-data` volume. The agent starts with
`--wait-for-config` and waits for that file, so it is safe to start on a brand
new instance where nobody has run the wizard yet.

It will not run without a binary. `clients/agent/bin` is populated by CI on
`main`, so an image built from a checkout that has never run CI has none; the
container says so plainly and exits. The instance still monitors through the
in-process `local-probes` job, which is also what takes the work back if the
agent goes quiet for longer than the staleness window.

### Adding an agent elsewhere

Generate a PIN in the admin, then on the host:

```sh
curl -fsSL https://status.example.com/install.sh | sh -s -- --pin 4K7Q-92XB
```

The instance serves that script with its own address baked in, and serves the
binaries too. It is written to be readable in one screen — no compression, no
`eval`, no base64 — because piping a script into a shell deserves suspicion.
Pairing hands the agent its probes, so there is no configuration to copy onto
the host, and it asks again on every start: a control added in the admin is
picked up after a restart.

`agent.toml` holds a live ingest key and is written 0600. If it leaks, revoke the
agent — the key is useless for anything but pushing measurements to the controls
in its scope, but that is enough to publish a lie on your status page.

To diagnose one:

```sh
tern-agent doctor    # config, permissions, queue, server, key, DNS, clock, ICMP
tern-agent status    # what it runs, and how much is waiting
tern-agent run --once
```

`doctor` exits non-zero on a real failure, so it drops into a post-install step
or a monitoring check unchanged. Two of its checks catch failures that are
otherwise silent: a host whose **clock** is years out produces measurements the
server clamps and that never appear, and `agent.toml` at 0644 in a directory
somebody later archives is how a key leaks.

For a network with no route to the internet, `tern-proxy` relays for the zone and
speaks the same API, so an agent pointed at it is an ordinary agent. See
[data exchange → the proxy](./data-exchange.md#the-proxy).

### Its own page

An agent and a relay can each serve a small page about themselves — state,
version, what they are sending to, what is queued. Off until asked for: a
monitoring agent that bound a port on every machine in an estate because it was
installed would be a decision made for you.

```sh
tern-agent ui                    # or: tern-proxy ui
tern-agent ui --listen 0.0.0.0:38788
```

It prints a generated password **once** and stores only a salted hash of it, so
nothing can show it to you again — run the command again for a new one. Then
restart the process: the setting is read at startup.

Loopback by default. Bound wider, the command says so in the colour of a
warning, because the page names the server, the tenant and everything that
process is doing, and only that password is in the way.

The page asks for the password itself rather than raising the browser's dialog.
One field, because there is one account — the username that dialog insisted on
was always ignored. Five wrong answers and the door shuts for a minute.

### Asking a machine to do something

Nothing here reaches an agent. Agents poll; this server never opens a connection
to one, and an agent behind a relay has no route back at all. So the fleet
screen's `⋯` menu does not _do_ these things — it asks, and the machine takes
the instruction on its next check-in, **about a minute**.

| Asked             | What happens                                                                |
| ----------------- | --------------------------------------------------------------------------- |
| Turn its page on  | Turns the page on and hands the new password back, shown once               |
| Fetch recent logs | The lines that process has emitted since it started                         |
| Restart it        | It leaves, and the supervisor starts it again                               |
| Pause measuring   | An agent runs no probes; a relay keeps its zone's points instead of sending |
| Resume            | Undoes a pause, from here                                                   |
| Stop it for good  | It reports nothing at all — see below                                       |

The trail under each row shows three states, and they are not the same thing.
_Waiting for its next check-in_ means the machine has not polled yet. _Taken, no
answer yet_ means it has, and is the ordinary end of a restart — the process
that carried it out stopped existing before it could report. Only _done_ means
an answer came back.

An instruction is handed over once. If a machine takes one and dies before
acting, it is lost rather than repeated: a restart performed twice is worse than
one never performed, which you can see and ask for again.

**Pause and stop differ only in what keeps listening.** A paused agent still
talks to the server, so the console can resume it. A stopped one talks to
nothing — that is what makes it final. Getting it back needs a shell on the
machine:

```sh
tern-agent resume        # then restart it
```

The console says exactly that before it asks, because from there the door does
not reopen. A stopped **relay** still serves its zone: stopping one must not
take a whole network's monitoring with it.

The logs are the agent's own recent lines, kept in a bounded ring in memory —
not journald, not the system log. That is a deliberate trade: it holds only this
process's output since this process started, and it works identically on Linux,
macOS, Windows and on a zone machine where nobody can log in to run anything.
Whatever the supervisor said _about_ the process is not there.

### Updating an agent

Re-run the installer with no `--pin`. It replaces the binary, keeps the config
and the pairing, and restarts the service:

```sh
curl -fsSL https://status.example.com/install.sh | sh -s -- --server https://status.example.com
```

A PIN is what makes it an installation; without one, and with a config already
present, it is an update and says so. It works out on its own whether the
machine holds an agent or a relay — a machine that only relays has a
`proxy.toml` and no `agent.toml`, and an update should not depend on remembering
which.

Re-pairing does not grow a second row in the fleet. Each install carries an
identifier it generated on its first pairing and keeps in its config, so pairing
again replaces its row, revokes the key that row held, and brings it back if it
had been revoked. That identifier is deliberately not derived from anything
about the host: two agents on one machine are two installs, and two VMs cloned
from one image share a hostname and a machine id — merging either pair would
silently drop a machine's monitoring, which looks exactly like success.

## Behind a reverse proxy

Two settings and one routing rule.

Set `PUBLIC_BASE_URL` to the external URL — it is the CORS origin, the passkey RP
ID, and what is baked into every generated script and mail link. Set
`TRUSTED_PROXIES` to the proxy's CIDR, or rate limits and the audit log key on
the proxy's own address and every request looks like it came from one client.
Leave it empty when the app is exposed directly: believing `X-Forwarded-For` from
an untrusted source lets a caller pick its own IP.

**The API serves more than `/api`.** Route all of these to it, or the SPA's
catch-all answers them with HTML:

```
/api/    /install.sh    /install.ps1    /badge/    /health
```

That failure is nastier than it looks. `curl … /install.sh | sh` then pipes a web
page into a shell, and fails with a syntax error that says nothing about why.

Badges are served from `/badge/:slug.svg` and `/badge/:slug/:key.svg` in five
styles, cached 60 s with `stale-while-revalidate=300` so a CDN or GitHub's image
proxy keeps serving the last render rather than a broken image. Unsubscribe links
in mail point at `/api/v1/unsubscribe/<ref>`, which is under `/api/` and needs no
separate rule.

## Mail and notifications

There are two layers, and knowing which one is in use is most of the
troubleshooting.

**The tenant's own SMTP settings**, entered in the first-run wizard and editable
in the admin, are used for every message sent to a person: incident and
maintenance notifications, subscriber double opt-in, password recovery. The
password is encrypted with `APP_SECRET`. A transporter is cached per tenant, so
changing the settings closes and rebuilds it.

**`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE` and
`MAIL_FROM`** are the instance-level fallback, used only when the tenant has
configured nothing. On an installation set up through the wizard — the normal
case — they are unset and unused.

The admin has a "send a test" button. Use it: it exercises the same settings the
real messages use.

If a relay still negotiates a 1024-bit Diffie-Hellman group, the handshake fails
with `dh key too small` before a byte of mail moves. The tenant's mail settings
carry an opt-in for that case, which lowers OpenSSL's security level to 1 —
enough to accept the small group, not enough to accept broken ciphers or null
encryption, and the TLS 1.2 floor is untouched. It is off unless asked for. A
1024-bit group is within reach of an adversary who can afford the
precomputation; it is offered because on port 25 with opportunistic STARTTLS the
honest alternative is not stronger TLS, it is no TLS.

Notification delivery is a background job polling every ten seconds, with
retries. Subscribers, incidents and maintenance windows generate the messages;
outbound webhooks are signed over `<timestamp>.<body>` so a captured payload is
not replayable forever.

Every notification mail carries an unsubscribe link in the body and advertises
`List-Unsubscribe` and `List-Unsubscribe-Post`. The address answers a GET with a
one-button page — a GET must not unsubscribe anyone, because mail clients and
security appliances prefetch links — and a POST with the unsubscribe itself,
including the form encoding an RFC 8058 provider sends.

## Security, and what is yours to do

The [security model](./security.md) is the reference: three non-interchangeable
credentials, three roles, what is encrypted with what, and the table of what an
attacker gets from each thing they steal. What falls to you as the operator:

- **Terminate TLS in front, and keep the hostname.** Nothing below works without
  it, and passkeys are bound to it.
- **Custody of `APP_SECRET`.** Separately from the dump. Rotating it invalidates
  every session and makes every encrypted value unreadable; there is no
  re-encryption path.
- **Set `TRUSTED_PROXIES` correctly, or not at all.** A wrong value is worse than
  an empty one.
- **Close the first-run window**, by opening the admin immediately or by
  provisioning the account in advance.
- **Understand that there is no step-up re-authentication.** A stolen admin
  session can do anything an admin can until it is revoked. Sessions are revocable
  in the admin; that is the lever.
- **Every secret TERN generates is shown exactly once.** There is no "show key"
  anywhere, because only a hash is kept. A key that was not written down is a key
  to reissue.
- **Do not publish the database port.** The production compose file publishes
  none. Adding one to debug something is a change to undo.

The application process runs as the unprivileged `node` user inside the image,
and the container is the security boundary you already have — the usual host
hardening applies and TERN neither helps nor hinders it.

Vulnerability reports go to [`SECURITY.md`](../SECURITY.md).

## When something is wrong

### The stack will not start

`docker compose -f docker-compose.prod.yml logs app`. The most common causes,
in the order they appear:

- **`✗ Invalid environment:`** followed by a list. The configuration failed
  validation and the process exited on purpose. `APP_SECRET` under 32 characters
  or still the placeholder is the usual one.
- **`✗ /var/lib/tern/app_secret is not writable`**. The `tern-data` volume is
  missing or not writable by the `node` user. Mount it, or supply `APP_SECRET`
  yourself.
- **`✗ migrations failed after 10 attempts`**. The database did not become
  reachable. Check `logs db`; on a first start it may be initialising a cluster.

### `setup.sh` refuses to start

Either the Docker daemon is not answering, or standard input is not a terminal
(you piped the script instead of downloading it), or the installation still holds
its database in the container layer — see
[the storage fix](#if-you-installed-before-the-storage-fix).

If it starts the stack and then reports that the database does not seem to rest
on a volume, stop. The instance works, and a `docker compose up -d` would destroy
it. Compare the `db` service's `volumes:` block against the shipped compose file.

### The agent container restarts, or never reports

- **`✗ … tern-agent-… is missing`** — the image has no agent binary for this
  architecture. That is normal for an image built from a checkout that has never
  run CI. The instance still monitors through its in-process prober; the fleet
  screen shows the agent as never having reported.
- **From source**, the API supervises the binary itself, and gives up after three
  exits inside five seconds with a line saying so. A binary older than the server
  is the usual cause.
- **A paired agent that stopped** — run `tern-agent doctor` on the host. It checks
  the clock and the config permissions along with the obvious things.

### The public page trails, or has gaps

- **429s in agent logs and gaps on the page** — the ingest rate limit. Capacity
  predicts it; `INGEST_RATE_LIMIT_MAX` raises it. Remember that one agent sends
  one request per run, not one per probe.
- **Slow requests everywhere, not only ingest** — the connection pool. Past about
  40 the answer is a pooler rather than a bigger `DB_POOL_MAX`.
- **The public page trails the admin by minutes** — aggregate refresh lag.
  Lengthen the probe interval before raising retention.
- **A control stuck at `unknown`** — it has an expected interval and has not
  reported within it. That is the staleness sweep doing its job, and it only runs
  while the API does.

### Mail does not arrive

Check which layer is sending. If the tenant has SMTP settings, they are what is
used; if it does not, the environment variables are — and on a wizard-installed
instance those are unset, so nothing goes anywhere. The test button exercises the
real path. Password recovery deliberately reports success either way, so as not
to reveal whether an address exists, which means the process log is where the
failure is recorded.

### `/install.sh` or `/badge/…` returns HTML

The reverse proxy is not routing it to the API. See
[behind a reverse proxy](#behind-a-reverse-proxy).

Four paths live **outside** `/api/` and are served by the API all the same:
`/install.sh`, `/install.ps1`, `/badge/…` and `/health`. A proxy configured to
forward only `/api/` sends the rest to the web app, which answers every unknown
path with the single-page shell — so the installer pipes an HTML document into
`sh`, and a badge embedded in a README renders as a broken image. Both fail in a
way that points anywhere except at the proxy.

The quickest check, from anywhere that can reach the instance:

```sh
curl -sI https://status.example.com/badge/<slug>.svg | head -1
```

`content-type: image/svg+xml` is right. `text/html` is the proxy.

### Passkeys are not offered

The page is not in a secure context — plain http on something other than
`localhost`. The interface hides the button rather than showing one that throws.
If passkeys stopped working after a move, the hostname in `PUBLIC_BASE_URL`
changed; the password and the emailed reset link are the way back in.

### Starting over

`./scripts/reset.sh --prod` returns the instance to the state a first boot
produces: schema migrated, no accounts, first-run wizard waiting. It is
destructive — measurements, incidents, subscribers, agents and accounts — and it
takes no backup of its own. Take the dump first.

To empty one tenant without deleting it, the admin has a danger zone that removes
what the tenant monitors and publishes while keeping what the tenant is: its
address, branding, members and audit trail. Wiping the audit trail would erase
the record of the wipe, which is the one entry somebody will certainly look for
afterwards.

## Known limitations that affect operations

Recorded with reasoning in [`BACKLOG.md`](../BACKLOG.md). The one an operator
runs into:

- **Named metrics are not on the public page.** They are ingested, stored and
  drawn in the admin, but the public page reads the daily rollups and the
  continuous aggregates do not roll up a JSONB map.

And two properties that are not defects but are often mistaken for them: the
Monitoring tab describes one API process rather than the deployment, and per-tenant
retention runs as an application job because TimescaleDB's own retention policies
act per hypertable — the 740-day policy on `checks` is only a backstop.

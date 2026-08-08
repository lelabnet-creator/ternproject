# Operations

For whoever has to keep this running.

## Installing

```bash
curl -fsSL -o setup.sh https://raw.githubusercontent.com/lelabnet-creator/ternproject/main/scripts/setup.sh
sh setup.sh
```

Asks for the published port, the public URL and the trusted-proxy CIDRs, writes
`.env`, pulls the image and starts `docker-compose.prod.yml`. The page name, the
administrator account and the mail server are not asked here: they are set at
the first visit to the admin, by the person in front of it, so no password has
to pass through a file on disk. Running it again keeps any variable you added to
`.env` by hand.

It speaks English, or French when the system does. `TERN_LANG=fr` or `en`
overrides that.

### What actually runs

`setup.sh` installs nothing itself. It fetches `tern-setup` — a ~670 KB Rust
binary built by CI for five targets — checks its SHA-256 against the release's
`SHA256SUMS`, and hands over. `TERN_SETUP_VERSION=v1.4.2` pins a version instead
of taking the latest.

That is a trade, and it is worth naming. A script can be read before it is run;
a binary cannot, which is exactly the argument this project uses to refuse
`curl … get.docker.com | sh`. Three things carry the weight: the bootstrap stays
short enough to read in one screen, the checksum is verified against the same
release that published the binary — with no hashing tool on the machine it stops
rather than pretending — and the sources are in this repository under
`clients/installer/`.

What it buys is the thing a shell script could not: a list of steps that fills
itself in, with the ones still to come visible from the start, and **no command
output scrolling past**. Everything `apt-get`, `docker` and `curl` say goes to
`tern-setup.log` beside the `.env` — every command, its exit code, its full
output, and the answers given, with secrets replaced by a character count. On a
failure the step turns red, the last useful lines appear, and the log path is
printed. That file is what to attach to a bug report.

```
┌  TERN — setting up an instance
│
│  ✓  Checking Docker                                              (2s)
│  ✓  Installing Docker                                           (34s)
│  ✓  Fetching the compose file                           already there
│  ✓  Writing the configuration                 .env written (mode 600)
│  ◐  Pulling the images
│  ○  Starting the services
│  ○  Waiting for the API
```

### If Docker is missing

The script no longer stops at the sight of it. On Linux it detects the package
manager by which command is present — `apt-get`, `dnf`, `yum` or `pacman`, not
what `/etc/os-release` claims, since a derivative rarely names its base — and
offers to install Docker. It asks first, every time: putting system packages on
a machine and enabling a service at boot is not a decision an installer makes on
someone's behalf.

What it installs comes from the repositories already configured on the machine
(`docker.io` or `docker-ce`, `moby-engine`, `docker`) plus the Compose v2 plugin
as a separate package. It does **not** pipe `get.docker.com` into a shell, and it
does not add Docker's own repository. Both would trade a file you can read
before running it for one you cannot, and the second is a decision about where
your packages come from.

It then enables and starts the service when systemd is the init (checked through
`/run/systemd/system`, not merely a `systemctl` binary on the PATH), verifies
that `docker compose version` answers, and tells you the exact `usermod -aG
docker` line if your account cannot reach the socket — along with the fact that
group membership is only read at login, so a new terminal will not do.

Anything else it refuses rather than guesses, pointing at
<https://docs.docker.com/engine/install/>: macOS, where the engine ships as
Docker Desktop and not as a package; RHEL, Rocky and Alma, whose base
repositories carry no Docker at all; an unknown package manager; a missing
`sudo` when not running as root; and of course a plain "no".

The container's entrypoint settles `APP_SECRET`, applies the migrations and
creates the tenant before the server binds — all three idempotent, so a restart
repeats none of them.

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
| `TERN_LOCAL_AGENT`                                | true           | Whether the instance runs `Agent-local-tern` for itself                                                                                   |
| `TERN_AGENT_NETWORK_MODE`                         | service:app    | Which network that agent measures from. `host` lets it reach this machine's own services — see [`Agent-local-tern`](#agent-local-tern)    |
| `TERN_LOCAL_AGENT_SERVER`                         | —              | Where that agent reports. Required with `host`, where the API is only at the published port                                               |
| `TERN_DATA_DIR`                                   | /var/lib/tern  | That agent's `agent.toml` and offline queue. Relative paths resolve from the repository root                                              |

### Watching the values above under load

**Logs → Monitoring** reports what the HTTP layer is actually doing: requests a
minute by class (ingest, agent, admin, public page), replies that were rate
limited, p50 and p95 per class, requests in flight, and how much of
`DB_POOL_MAX` is checked out. It is the measured counterpart to the Capacity
screen, which computes what a fleet _needs_.

Two things it will not do, and says so on the screen rather than in a footnote:

- **It describes one API process.** The counters live in memory, so behind a load
  balancer each container keeps its own and neither knows about the other. The
  instance names itself at the top of the tab.
- **Latencies come from a histogram**, so each figure is the bound the sample
  fell under, not an exact number. Past the last bucket it reports `> 10 s`
  rather than inventing one.

The instance-wide half is visible only to an admin of the system tenant. A
tenant admin sees their own agents' push rates — which host is generating the
load — and nothing about the shared machinery.

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

### Where the data actually sits

`timescaledb-ha` keeps `PGDATA` in `/home/postgres/pgdata`, which is **not** the
`/var/lib/postgresql/data` the plain `postgres` image uses. Both compose files
used to mount the named volume on the conventional path: the image never wrote
there, so the cluster lived in the container's writable layer and any
`docker compose up -d` that recreated the container — a routine upgrade, a
changed port — took the database with it.

Fixed in both files, and `setup.sh` now checks it twice: it refuses to start on
an installation still holding its data the old way, since remounting would
present an empty database without a word, and it verifies after start that the
running container really has its cluster on the volume.

**If you installed before this fix**, your data is in the container layer. Dump
it before pulling:

```bash
docker exec tern-prod-db-1 pg_dump -U tern -Fc tern > tern-before-migration.dump
docker compose -f docker-compose.prod.yml down
git pull && ./scripts/setup.sh          # starts on a fresh, correctly-mounted volume
# then restore the dump, per the section above
```

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

### Surviving a reboot

`install.sh` and `install.ps1` register the agent with whatever supervises
services on the machine, because the alternative fails in the worst possible
way: an agent installed and paired but not registered works perfectly until the
first restart, then stops — and stops quietly. The server shows it as gone
quiet, but only to somebody looking at the fleet screen.

What gets written, decided by what is actually running rather than by the
distribution's name:

| Machine       | As root / administrator                           | Otherwise                            |
| ------------- | ------------------------------------------------- | ------------------------------------ |
| systemd       | `/etc/systemd/system/tern-agent.service`, enabled | user unit + `loginctl enable-linger` |
| macOS         | `/Library/LaunchDaemons/net.tern.agent.plist`     | `~/Library/LaunchAgents/…`           |
| OpenRC        | `/etc/init.d/tern-agent`, `rc-update add`         | refused, with the reason             |
| Windows       | scheduled task, at startup, as SYSTEM             | scheduled task, at logon             |
| anything else | says so, and does not pretend                     | same                                 |

Three decisions worth knowing before changing any of it:

- **systemd is detected by `/run/systemd/system`**, not by finding `systemctl`.
  A machine can carry the command and boot something else; the question is what
  is supervising right now.
- **Lingering matters more than it looks.** A systemd _user_ unit stops when the
  last session closes and does not come back until somebody logs in — which on a
  server is never. Without `enable-linger` the agent would survive a reboot on
  paper and not in fact.
- **Windows gets a scheduled task, not a service.** `tern-agent` is an ordinary
  console program; a real service must answer the Service Control Manager within
  its timeout and is killed when it does not. `New-Service` would install
  something that looks right and dies at every boot. The task also sets an
  unlimited execution time limit — the default stops a task after three days,
  which would end monitoring without reporting a fault.

`--no-service` (`-NoService`) skips all of it. Pairing writes to an absolute
path — `/etc/tern/agent.toml` as root, `$XDG_CONFIG_HOME/tern/agent.toml`
otherwise — because the agent's own default is `agent.toml` in the working
directory, and a supervisor starts it from `/`.

On Linux as a non-root user, `ping` controls need `cap_net_raw`; the installer
says so, and `tern-agent doctor` checks it.

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

### `Agent-local-tern`

Every instance runs one agent for itself. It is provisioned at first run — no
PIN, no pairing, because the server issuing the invitation is the machine
accepting it — and it appears in the fleet like any other, marked _this
instance_.

It cannot be revoked or deleted: the API answers 409 and the admin does not
draw the button. Deleting it would leave `agent.toml` on disk holding a key for
an agent the server had forgotten, and the next reconcile would make a second
one. `TERN_LOCAL_AGENT=false` is how you turn it off; renaming it is allowed,
since the name is only a label.

**It runs as its own container.** `docker-compose.prod.yml` has an `agent`
service: the same image, a different entrypoint, and `restart: unless-stopped`
as its supervisor. Nothing in TERN supervises a process — the point of a
separate one is that it keeps measuring and buffering while the API restarts,
which a child of the API could not do.

By default it shares the API container's network namespace
(`network_mode: service:app`). The agent refuses to send an ingest key over
plain HTTP to anything but localhost — a guard worth keeping — so rather than
weakening it, the namespace is arranged so that `127.0.0.1:3011` genuinely _is_
the API and the key never touches a network interface. Worth knowing before
editing that service: it can therefore publish no ports of its own.

#### What it can measure, and what it cannot

That arrangement decides what the agent can see, and the answer surprises
people. Measured from inside the container rather than assumed:

| Target                             | `service:app` | `host`     |
| ---------------------------------- | ------------- | ---------- |
| The internet — DNS, TCP, TLS       | yes           | yes        |
| This instance's own containers     | yes           | by address |
| Services on the machine's loopback | **no**        | yes        |
| Other Docker networks              | **no**        | yes        |
| The machine's local network        | yes           | yes        |

Outbound is not the problem — it works fully. The problem is that `127.0.0.1`
means _the container_, so a service listening only on the machine's loopback has
no address the agent could even name. Somebody monitoring their own machine
writes `localhost:5432`, and that is exactly the target this mode cannot reach.
The check fails against an address that looks obviously right, which is the
hardest kind of wrong to find. The control editor now says so before the check
is saved, and the fleet screen says it on the agent's row.

`host` is the other answer. The agent joins the machine's network stack, where
`127.0.0.1` is the machine:

```sh
TERN_AGENT_NETWORK_MODE=host
TERN_LOCAL_AGENT_SERVER=http://127.0.0.1:$TERN_HTTP_PORT
```

then `docker compose -f docker-compose.prod.yml up -d`. `scripts/setup.sh` asks
the question at install time and writes both lines for you.

Both lines, always. In the machine's namespace the API is no longer at
`127.0.0.1:3011` but at its published port, and the second line is the only
thing that tells the agent so — without it the agent would go quiet. The guard
still holds: that address is a loopback, so the key still never crosses a
network interface. Changing the setting later is safe, since the API rewrites
`agent.toml` when the address moves and keeps the key already in it.

**Linux only.** Docker Desktop on macOS and Windows does not give host
networking the meaning expected here; `setup.sh` says so rather than writing a
setting that would quietly do nothing useful.

The in-process `local-probes` job has the _same_ blind spots — it runs in the
API's container either way — so this setting is the only way to measure the
machine from an instance that monitors itself.

The API's only part is the record: it writes the row, the key and `agent.toml`
as soon as a page exists. That file, on the shared `tern-data` volume, is the
whole channel between the two containers. The agent container starts with
`--wait-for-config` and waits for it to appear, so it is safe to start on a
brand new instance where the setup wizard has not been run yet.

Two things it will not do, neither of them a fault:

- **Run without a binary.** `clients/agent/bin` is populated by CI on `main`. A
  source build that has never run CI has none, the container says so and exits,
  and the instance still monitors through the in-process `local-probes` job.
- **Compete with the in-process prober.** Its key carries an empty scope, which
  `local-probes` reads as the whole tenant, so that job stands down entirely
  while the agent reports and takes the work back if it goes quiet for longer
  than the staleness window.

Its files live in `TERN_DATA_DIR` — `/var/lib/tern` in the production image,
which is the volume already backed up with `APP_SECRET`. `agent.toml` holds a
live ingest key and is written 0600.

Running the API from source, there is no container to run the agent, so the API
starts it itself — `TERN_LOCAL_AGENT_SUPERVISE`, on by default and turned off in
the production stack. Without it a development install shows an agent that was
provisioned and never reported, which looks like a fault and is not.

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

- **Named metrics are not on the public page.** They are ingested, stored and
  drawn in the admin, but the public page reads the daily rollups and the
  aggregates do not roll up a JSONB map.

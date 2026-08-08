# TERN — the public demonstration, as one image with its database inside it.
#
#   scripts/demo-image.sh            build it
#   scripts/demo-image.sh --run      build it and open http://localhost:8088
#
# Why one image and not the production pair
# -----------------------------------------
# A demonstration is not a deployment. Nobody signs up for it, nobody keeps
# anything in it, and the one property that matters is that it looks the same
# to the next visitor as it did to the last. So the database is not a volume
# mounted beside the app — it is baked into the image, at build time, from the
# repository's own seed. Every container started from this image begins at the
# same 90 days of history, and every restart discards whatever the last few
# hours did to it.
#
# That also settles the read-only question at three levels rather than one:
#
#   1. The tenant. `TERN_DEMO=1` at seed time sets `isDemo` and `readOnly`, and
#      `apps/api/src/plugins/context.ts` refuses every permission outside
#      `READ_ONLY_PERMISSIONS` — for everyone, admin sessions included, at one
#      point rather than at forty call sites. This is the real protection, and
#      it is the product's, not this file's.
#   2. The filesystem. The container is meant to run with `--read-only`; see
#      `compose.demo.yml`. The cluster lives on a tmpfs the entrypoint fills
#      from an immutable copy, so the writable surface is RAM and nothing else.
#   3. Time. A restart is a reset. No cron, no reset endpoint, nothing to get
#      wrong — `docker restart` is the whole mechanism.
#
# The base is the production database image, not a Postgres of our choosing:
# the schema needs `timescaledb` *and* `timescaledb_toolkit`, and a demo that
# runs on a different engine than the product is a demo of something else.
# Node is added to it rather than Postgres added to Node, because that way the
# extension versions are the ones the product is tested against.

ARG TERN_IMAGE=ghcr.io/lelabnet-creator/ternproject:latest

# ── the application, taken whole from the published image ────────────────────
# Not rebuilt here. The demo has to show the artefact people actually install;
# a second build of the same sources is a second thing that can differ from it.
FROM ${TERN_IMAGE} AS app

# ── the demo image ───────────────────────────────────────────────────────────
FROM timescale/timescaledb-ha:pg16 AS demo

USER root
ENV DEBIAN_FRONTEND=noninteractive

# Node, from the official tarball rather than from the image next door.
# `node:22-slim` is Debian bookworm (glibc 2.36) and this base is Ubuntu 22.04
# (glibc 2.35), so copying that binary across produces a container that starts
# and immediately dies on a missing symbol. The tarball is built for a much
# older baseline and runs on both.
ARG NODE_VERSION=22.23.2
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) node_arch=x64 ;; \
      arm64) node_arch=arm64 ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl xz-utils ca-certificates tini; \
    curl -fsSLo /tmp/node.tar.xz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    curl -fsSLo /tmp/SHASUMS256.txt \
      "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; \
    (cd /tmp && grep " node-v${NODE_VERSION}-linux-${node_arch}.tar.xz\$" SHASUMS256.txt \
      | sed "s| node-v${NODE_VERSION}-linux-${node_arch}.tar.xz| node.tar.xz|" | sha256sum -c -); \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
      --exclude CHANGELOG.md --exclude LICENSE --exclude README.md; \
    rm -f /tmp/node.tar.xz /tmp/SHASUMS256.txt; \
    apt-get purge -y curl xz-utils; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*; \
    node --version

# The application tree, node_modules included. `pnpm install --prod` in the
# published image already dropped the build-time dependencies, and what is left
# is enough to run the migrations and the seed — both go through `tsx`, which
# is a real dependency there for exactly this reason.
COPY --from=app /app /app

# Where the pristine cluster is kept. Read at boot, never written to.
ENV TERN_DEMO_PGDATA=/opt/tern/pgdata
ENV PGDATA=/home/postgres/pgdata/data

# ── baking the database ──────────────────────────────────────────────────────
# The cluster is created, migrated and seeded here, once, and what the image
# ships is the result. The alternative — seeding at container start — costs two
# minutes on every boot of every replica and makes the demo's contents depend
# on when it was restarted.
#
# `APP_SECRET` is generated now and kept beside the cluster, because the seed
# encrypts with it: probe authentication headers, TOTP secrets, subscriber
# addresses. A secret regenerated at boot would leave every one of those
# unreadable — the same failure `docker/entrypoint.sh` guards against, arriving
# by a different road. It protects nothing here (the whole database is public
# by construction, and is thrown away on restart), and it must not be reused
# anywhere that is not this demo.
ARG TERN_SEED_DAYS=90
RUN set -eux; \
    mkdir -p /opt/tern; \
    node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))" \
      > /opt/tern/app_secret; \
    chmod 640 /opt/tern/app_secret; \
    mkdir -p "$PGDATA" /run/postgresql; \
    chown -R postgres:postgres "$PGDATA" /run/postgresql /opt/tern /app; \
    chmod 700 "$PGDATA"

USER postgres
RUN set -eux; \
    export APP_SECRET="$(cat /opt/tern/app_secret)"; \
    initdb -D "$PGDATA" -U postgres --encoding=UTF8 --locale=C.UTF-8; \
    # timescaledb is a preload library; without this line CREATE EXTENSION
    # fails and every migration after it does too.
    printf "shared_preload_libraries = 'timescaledb'\n" >> "$PGDATA/postgresql.conf"; \
    # The loopback of this container's own network namespace, and nothing else.
    # A Unix socket would be tighter still, but `postgres@3` — the driver the
    # product uses — parses its connection string with `new URL()`, and a URL
    # with no host is not a URL. Rather than teach the demo a second way of
    # connecting, it uses the same shape as production.
    printf "listen_addresses = 'localhost'\n"           >> "$PGDATA/postgresql.conf"; \
    printf "fsync = off\nfull_page_writes = off\n"      >> "$PGDATA/postgresql.conf"; \
    pg_ctl -D "$PGDATA" -w -t 120 start; \
    createdb -h 127.0.0.1 tern; \
    cd /app/packages/db; \
    export DATABASE_URL="postgresql://postgres@127.0.0.1:5432/tern"; \
    node --import tsx src/migrate.ts; \
    TERN_DEMO=1 TERN_SEED_DAYS="${TERN_SEED_DAYS}" node --import tsx src/seed.ts; \
    # A demo is read hundreds of times and written once, here. Paying for the
    # statistics and the space now is free; paying for them at every visit is
    # not.
    vacuumdb -h 127.0.0.1 --analyze --full tern; \
    pg_ctl -D "$PGDATA" -w -t 120 -m fast stop; \
    # fsync back on for the copy that ships: the durability settings above are
    # a build-time shortcut, and an image that carries them would be lying
    # about what it is. `listen_addresses` stays — the runtime needs it.
    sed -i "/^fsync = off\$/d;/^full_page_writes = off\$/d" \
      "$PGDATA/postgresql.conf"; \
    cp -a "$PGDATA" "$TERN_DEMO_PGDATA"; \
    rm -rf "$PGDATA"

USER root
COPY docker/demo/entrypoint.sh /usr/local/bin/tern-demo-entrypoint
# `/var/lib/tern` is where the API writes the local agent's `agent.toml`. The
# production image creates it; this base is the database image and does not, so
# without this the local-agent job fails on every tick with an ENOENT that
# reads, in the log of a demo, exactly like a broken product. Created here and
# mounted as a tmpfs at run time — see compose.demo.yml — because the container
# may not write to its own filesystem.
RUN chmod +x /usr/local/bin/tern-demo-entrypoint \
 && mkdir -p /var/lib/tern \
 && chown -R postgres:postgres "$TERN_DEMO_PGDATA" /var/lib/tern

ARG TERN_VERSION=""
ARG TERN_REVISION=""
LABEL org.opencontainers.image.title="TERN — demo" \
      org.opencontainers.image.description="The TERN demonstration: one image, its database inside it, read-only and reset on every restart." \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.source="https://github.com/lelabnet-creator/ternproject" \
      org.opencontainers.image.version="${TERN_VERSION}" \
      org.opencontainers.image.revision="${TERN_REVISION}" \
      eu.tern-project.demo.seed-days="${TERN_SEED_DAYS}"

USER postgres
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=3011 \
    TERN_DEMO=1

EXPOSE 3011

# The API is what has to be healthy; Postgres being up is necessary and not
# sufficient, and the demo is broken for a visitor precisely when this fails.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3011)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/tern-demo-entrypoint"]
CMD ["node", "--import", "tsx", "src/server.ts"]

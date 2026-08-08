#!/bin/sh
#
# The demo container, from a read-only image to a page anyone can open.
#
# Three things happen here and nothing else: the pristine cluster is copied onto
# a writable tmpfs, Postgres is started on it, and the API takes over as PID 1's
# child. There is no migration step and no seed step — both ran at build time,
# and running them again would make the demo's contents depend on when it was
# last restarted.
#
# Everything this script writes lives under paths that are expected to be
# tmpfs mounts (see compose.demo.yml). The image itself is never written to,
# which is what lets the container run with `--read-only`.

set -eu

PGDATA="${PGDATA:-/home/postgres/pgdata/data}"
PRISTINE="${TERN_DEMO_PGDATA:-/opt/tern/pgdata}"

# --- the database ------------------------------------------------------------
# `cp -a` and not a volume: the copy is the reset. A container that has been
# poked at for a week comes back identical to one started a minute ago, and the
# mechanism is `docker restart` rather than a job somebody has to remember to
# schedule.
#
# It costs a few seconds and a few hundred megabytes of RAM at boot. That is the
# price of a demo nobody has to curate.
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "==> restoring the demo database"
  mkdir -p "$PGDATA"
  # Into the directory rather than onto it: $PGDATA is a mount point, and
  # copying onto a mount point replaces nothing.
  cp -a "$PRISTINE/." "$PGDATA/"
  chmod 700 "$PGDATA"
fi

mkdir -p /run/postgresql

echo "==> starting Postgres"
pg_ctl -D "$PGDATA" -w -t 120 start

# Draining matters even here. Without it, `docker restart` kills Postgres
# mid-write, the next boot copies a fresh cluster anyway, and the log fills with
# recovery noise that looks like a fault in the product.
stop_postgres() {
  echo "==> stopping Postgres"
  pg_ctl -D "$PGDATA" -w -t 30 -m fast stop || true
}

# --- the application ---------------------------------------------------------
# The loopback of this container's own network namespace. Nothing outside the
# container can reach it — only 3011 is published — so a host on the public
# internet exposes the API and nothing else.
DATABASE_URL="postgresql://postgres@127.0.0.1:5432/tern"
export DATABASE_URL

# The secret the seed encrypted with. Baked beside the cluster for the reason
# given in the Dockerfile: generating a new one here would leave every encrypted
# value in the baked database unreadable.
if [ -z "${APP_SECRET:-}" ] && [ -s /opt/tern/app_secret ]; then
  APP_SECRET="$(cat /opt/tern/app_secret)"
  export APP_SECRET
fi

: "${PUBLIC_BASE_URL:=http://localhost:3011}"
export PUBLIC_BASE_URL

echo "==> starting TERN (demo, read-only) on ${API_HOST:-0.0.0.0}:${API_PORT:-3011}"
cd /app/apps/api

# Not `exec`: this shell has to outlive the API in order to stop Postgres on the
# way out. tini is PID 1 and forwards SIGTERM here; what follows forwards it on
# and only then shuts the database down. Signalling the API first is the whole
# point of the order — the server drains its requests and returns its
# connections while the database it is returning them to is still running.
"$@" &
api=$!

shutdown() {
  kill -TERM "$api" 2>/dev/null || true
  wait "$api" 2>/dev/null || true
  stop_postgres
  exit 0
}
trap shutdown TERM INT

# `wait` on a shell that has a trap returns as soon as the signal arrives, so
# this line is where both the ordinary exit and the `docker stop` path end up.
wait "$api"
status=$?
stop_postgres
exit "$status"

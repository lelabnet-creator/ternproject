#!/bin/sh
#
# Container entrypoint: settle the secret, bring the schema up to date,
# provision the first tenant if asked, then hand over to the server.
#
# Everything here is idempotent — it runs on every boot, including restarts of
# a container that has been serving for months.

set -eu

SECRET_FILE="${APP_SECRET_FILE:-/var/lib/tern/app_secret}"

# --- APP_SECRET --------------------------------------------------------------
# It encrypts TOTP secrets, probe auth headers and subscriber addresses. A new
# one on each boot would not fail loudly — it would quietly make every existing
# encrypted value unreadable. So: use what the operator supplied, otherwise
# reuse what we generated last time, otherwise generate once and keep it.
if [ -z "${APP_SECRET:-}" ]; then
  if [ -s "$SECRET_FILE" ]; then
    APP_SECRET=$(cat "$SECRET_FILE")
  else
    echo "==> no APP_SECRET supplied, generating one in $SECRET_FILE"
    if ! mkdir -p "$(dirname "$SECRET_FILE")" 2>/dev/null || ! touch "$SECRET_FILE" 2>/dev/null; then
      echo "✗ $SECRET_FILE is not writable." >&2
      echo "  Mount a volume there, or pass APP_SECRET yourself." >&2
      exit 1
    fi
    APP_SECRET=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")
    printf '%s' "$APP_SECRET" > "$SECRET_FILE"
    chmod 600 "$SECRET_FILE"
    echo "    kept across restarts — back this file up with the database"
  fi
  export APP_SECRET
fi

# --- schema ------------------------------------------------------------------
# node directly rather than `pnpm -F @tern/db …`: pnpm resolves tsx per
# workspace package, so the cwd is what makes `--import tsx` resolve at all —
# and every pnpm layer here is a process that has to be started and waited on.
run_db() {
  cd /app/packages/db
  node --import tsx "src/$1.ts"
}

# Compose waits on the database healthcheck, but a healthy Postgres in a
# just-created cluster can still be a moment away from accepting connections.
echo "==> migrations"
attempt=0
until run_db migrate; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 10 ]; then
    echo "✗ migrations failed after $attempt attempts" >&2
    exit 1
  fi
  echo "    retrying in 3s ($attempt/10)"
  sleep 3
done

# --- first tenant ------------------------------------------------------------
# Only when the operator gave one. provision.ts leaves an existing tenant
# alone, so this is safe on every subsequent boot.
if [ -n "${TERN_TENANT_SLUG:-}" ]; then
  echo "==> tenant"
  run_db provision
fi

echo "==> starting TERN on ${API_HOST:-0.0.0.0}:${API_PORT:-3011}"

# From apps/api, and exec so the server *becomes* this process. Going through
# `pnpm start` instead puts pnpm and a shell between tini and node: SIGTERM then
# kills the wrapper, `server.ts` never runs its shutdown handler, and in-flight
# requests and database connections are dropped rather than drained.
cd /app/apps/api
exec "$@"

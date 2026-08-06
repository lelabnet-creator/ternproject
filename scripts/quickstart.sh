#!/bin/sh
#
# TERN — quick start for Linux and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/tern-status/tern/main/scripts/quickstart.sh | sh
#
# Brings up a complete local instance: clone, secret, database, migrations,
# demo tenant, dev server. Safe to re-run — every step checks before it acts.
#
# POSIX sh rather than bash: macOS still ships bash 3.2, and there is nothing
# here that needs more than sh.

set -eu

REPO_URL="${TERN_REPO:-https://github.com/tern-status/tern.git}"
DIR="${TERN_DIR:-tern}"

# ANSI only when stdout is a terminal — piped into a log this stays readable.
if [ -t 1 ]; then
  B=$(printf '\033[1m'); DIM=$(printf '\033[2m'); R=$(printf '\033[0m')
  OK=$(printf '\033[32m'); ERR=$(printf '\033[31m')
else
  B=''; DIM=''; R=''; OK=''; ERR=''
fi

say()  { printf '%s==>%s %s\n' "$B" "$R" "$1"; }
note() { printf '    %s%s%s\n' "$DIM" "$1" "$R"; }
die()  { printf '%s==> %s%s\n' "$ERR" "$1" "$R" >&2; exit 1; }

# --- prerequisites -----------------------------------------------------------
# Checked together so a missing toolchain is reported once, not one round trip
# at a time.
missing=''
for cmd in git docker node; do
  command -v "$cmd" >/dev/null 2>&1 || missing="$missing $cmd"
done
[ -z "$missing" ] || die "Manquant :$missing — installez-les puis relancez."

docker compose version >/dev/null 2>&1 \
  || die "Docker Compose v2 est requis (docker compose), et Docker doit tourner."

node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 22 ] || die "Node 22+ requis, trouvé $(node -v)."

# --- clone -------------------------------------------------------------------
if [ -f package.json ] && [ -d packages/db ]; then
  say "Dépôt déjà présent, on reste ici."
elif [ -d "$DIR" ]; then
  say "$DIR existe déjà, on l'utilise."
  cd "$DIR"
else
  say "Clonage de $REPO_URL"
  git clone --depth 1 "$REPO_URL" "$DIR"
  cd "$DIR"
fi

# --- secret ------------------------------------------------------------------
# 32 bytes of hex. openssl if present, /dev/urandom otherwise — a container
# image without openssl should not stop the quick start.
random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
  fi
}

if [ -f .env ]; then
  say ".env déjà présent, laissé tel quel."
else
  say "Création de .env avec un APP_SECRET neuf"
  cp .env.example .env
  secret=$(random_hex)
  # A temp file rather than sed -i: the in-place flag differs between GNU and
  # BSD sed, and this works the same on both.
  awk -v s="$secret" '/^APP_SECRET=/ { print "APP_SECRET=" s; next } { print }' \
    .env > .env.tmp && mv .env.tmp .env
  note "secret généré localement, jamais transmis"
fi

# --- database ----------------------------------------------------------------
# Compose returns as soon as the container starts, which is before Postgres
# accepts connections — migrating there fails on an otherwise healthy setup.
# `--wait` honours the healthcheck the compose file already declares; the poll
# is the fallback for older Compose builds that lack the flag.
say "Démarrage de PostgreSQL, TimescaleDB et MailHog"
if ! docker compose up -d --wait 2>/dev/null; then
  docker compose up -d
  say "Attente de la base"
  i=0
  until docker compose exec -T db pg_isready -U tern -d tern -q 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -lt 60 ] || die "La base n'a pas répondu en 60 s. Voir : docker compose logs db"
    sleep 1
  done
fi

# --- application -------------------------------------------------------------
say "Installation des dépendances"
corepack enable >/dev/null 2>&1 || note "corepack enable a échoué, on continue avec pnpm existant"
pnpm install

say "Migrations"
pnpm db:migrate

say "Données de démonstration (environ deux minutes)"
pnpm db:seed

printf '\n%s%s Prêt.%s\n' "$OK" "$B" "$R"
printf '    Page publique    http://localhost:5173/s/acme\n'
printf '    Administration   http://localhost:5173/app/acme\n'
printf '    Boîte mail       http://localhost:8025\n\n'

say "Lancement (Ctrl+C pour arrêter)"
exec pnpm dev

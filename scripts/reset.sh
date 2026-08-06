#!/bin/sh
#
# TERN — remet l'instance dans l'état d'un premier démarrage.
#
#   ./scripts/reset.sh              # détecte la pile, demande confirmation
#   ./scripts/reset.sh --prod       # la pile Docker (docker-compose.prod.yml)
#   ./scripts/reset.sh --dev        # la base de développement (pnpm dev)
#   ./scripts/reset.sh --dev --yes --slug lelab --name "Le Lab"
#
# « Premier démarrage » veut dire exactement : schéma migré et **aucun compte**.
# C'est l'état que produit le conteneur sur un volume neuf, et c'est ce qui fait
# réapparaître l'assistant de premier lancement à la place du formulaire de
# connexion. L'assistant crée la page ; elle n'est provisionnée d'avance que si
# .env porte un TERN_TENANT_SLUG.
#
# DESTRUCTIF. Efface les mesures, les incidents, les abonnés, les agents et les
# comptes. Il n'y a pas de sauvegarde automatique : `docs/operations.md` décrit
# `pg_dump`, et c'est le moment de s'en servir.
#
# POSIX sh, comme les autres scripts du dépôt.

set -eu

COMPOSE_PROD="docker-compose.prod.yml"
ENV_FILE=".env"

if [ -t 1 ]; then
  B=$(printf '\033[1m'); DIM=$(printf '\033[2m'); R=$(printf '\033[0m')
  OK=$(printf '\033[32m'); ERR=$(printf '\033[31m'); WARN=$(printf '\033[33m')
else
  B=''; DIM=''; R=''; OK=''; ERR=''; WARN=''
fi

say()  { printf '\n%s==>%s %s\n' "$B" "$R" "$1"; }
note() { printf '    %s%s%s\n' "$DIM" "$1" "$R"; }
die()  { printf '%s==> %s%s\n' "$ERR" "$1" "$R" >&2; exit 1; }

cd "$(dirname "$0")/.."

# --- arguments ---------------------------------------------------------------
MODE=''
ASSUME_YES=''
ARG_SLUG=''
ARG_NAME=''

while [ $# -gt 0 ]; do
  case "$1" in
    --prod) MODE=prod ;;
    --dev)  MODE=dev ;;
    --yes|-y) ASSUME_YES=1 ;;
    --slug) shift; ARG_SLUG=${1:-} ;;
    --name) shift; ARG_NAME=${1:-} ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^#\{1,\} \{0,1\}//'
      exit 0
      ;;
    *) die "Option inconnue : $1 (voir --help)" ;;
  esac
  shift
done

command -v docker >/dev/null 2>&1 || die "Docker est requis."

# `current <clé>` — lit une valeur de .env sans le sourcer : ce fichier contient
# des mots de passe, et un `.` sur un fichier généré exécuterait ce qu'il y a
# dedans.
current() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | sed 's/^"//; s/"$//'
}

# --- quelle pile ? -----------------------------------------------------------
prod_running() {
  [ -f "$COMPOSE_PROD" ] || return 1
  [ -n "$(docker compose -f "$COMPOSE_PROD" ps -q 2>/dev/null)" ]
}

if [ -z "$MODE" ]; then
  if prod_running; then
    MODE=prod
  elif [ -f "$ENV_FILE" ] && [ -n "$(current DATABASE_URL)" ]; then
    MODE=dev
  else
    die "Aucune pile détectée. Précisez --prod ou --dev."
  fi
  note "Pile détectée : $MODE"
fi

# --- confirmation ------------------------------------------------------------
# Avant toute destruction, et en disant précisément ce qui disparaît. Un script
# qui efface une base en annonçant « reset… » est un script qu'on lance une fois
# de trop.
if [ "$MODE" = prod ]; then
  TARGET="la pile Docker « tern-prod » : base de données ET volume tern-data"
  EXTRA="APP_SECRET sera régénéré — les valeurs chiffrées d'une sauvegarde antérieure deviendront illisibles."
else
  DB_URL=$(current DATABASE_URL)
  [ -n "$DB_URL" ] || die "DATABASE_URL introuvable dans $ENV_FILE."
  # Affiché sans le mot de passe : ce message finit dans des historiques de
  # terminal et des tickets.
  SAFE_URL=$(printf '%s' "$DB_URL" | sed 's#://[^@/]*@#://***@#')
  TARGET="la base de développement $SAFE_URL"
  EXTRA="Le serveur de dev perdra ses connexions le temps de la recréation."
fi

printf '\n%s%s Cette opération est destructive.%s\n' "$WARN" "$B" "$R"
printf '    Cible : %s\n' "$TARGET"
printf '    Efface : mesures, incidents, abonnés, agents, comptes.\n'
printf '    %s\n' "$EXTRA"

if [ -z "$ASSUME_YES" ]; then
  [ -t 0 ] || die "Entrée non interactive : relancez avec --yes pour confirmer."
  printf '\n    Tapez %sreset%s pour confirmer : ' "$B" "$R"
  read -r answer || answer=''
  [ "$answer" = "reset" ] || die "Annulé."
fi

# --- prod --------------------------------------------------------------------
if [ "$MODE" = prod ]; then
  say "Suppression des conteneurs et des volumes"
  docker compose -f "$COMPOSE_PROD" down -v

  say "Redémarrage sur des volumes neufs"
  note "L'entrypoint régénère APP_SECRET, migre et recrée la page."
  # Volontairement le même chemin qu'une première installation : migrations et
  # provisioning viennent de l'entrypoint, pas d'ici. Reproduire ces étapes dans
  # ce script en ferait un second chemin, qui dériverait du premier.
  if ! docker compose -f "$COMPOSE_PROD" up -d --wait; then
    die "Le redémarrage a échoué. Voir : docker compose -f $COMPOSE_PROD logs app"
  fi

  BASE=$(current PUBLIC_BASE_URL); [ -n "$BASE" ] || BASE="http://localhost:$(current TERN_HTTP_PORT)"
  SLUG=$(current TERN_TENANT_SLUG)

# --- dev ---------------------------------------------------------------------
else
  command -v psql >/dev/null 2>&1 || die "psql est requis pour --dev."

  # La page n'est plus obligatoire ici : l'assistant de premier démarrage la
  # crée en même temps que le compte. On ne la provisionne que si l'instance est
  # configurée pour l'avoir avant la première requête — c'est-à-dire si .env
  # porte un TERN_TENANT_SLUG, ou si on en passe un.
  SLUG=${ARG_SLUG:-$(current TERN_TENANT_SLUG)}
  NAME=${ARG_NAME:-$(current TERN_TENANT_NAME)}
  [ -z "$SLUG" ] || [ -n "$NAME" ] || NAME=$SLUG

  # Recréer la base plutôt que vider les tables : `DROP SCHEMA public` emporte
  # aussi les extensions TimescaleDB, et les remettre en place est précisément ce
  # que fait la migration. Une base neuve est le seul état vraiment identique à
  # une installation neuve.
  DB_NAME=$(printf '%s' "$DB_URL" | sed 's#.*/##; s#?.*##')
  ADMIN_URL=$(printf '%s' "$DB_URL" | sed "s#/$DB_NAME\\(?.*\\)\\{0,1\\}\$#/postgres#")

  say "Recréation de la base « $DB_NAME »"
  # WITH (FORCE) coupe les connexions ouvertes — le serveur de dev en garde une
  # poignée, et sans cela le DROP attendrait indéfiniment.
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q \
    -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE);" \
    -c "CREATE DATABASE \"$DB_NAME\";" \
    || die "Recréation impossible. La base tourne-t-elle ? (docker compose up -d db)"

  say "Migrations"
  pnpm db:migrate >/dev/null || die "Les migrations ont échoué."

  if [ -n "$SLUG" ]; then
    say "Création de la page « $NAME »"
    TERN_TENANT_SLUG="$SLUG" TERN_TENANT_NAME="$NAME" \
      TERN_DEFAULT_LOCALE="$(current TERN_DEFAULT_LOCALE)" \
      TERN_DEFAULT_TIMEZONE="$(current TERN_DEFAULT_TIMEZONE)" \
      pnpm db:provision >/dev/null || die "Le provisioning a échoué."
  else
    note "Aucune page provisionnée — l'assistant la créera."
  fi

  BASE=$(current PUBLIC_BASE_URL); [ -n "$BASE" ] || BASE="http://localhost:5173"
fi

# --- vérification ------------------------------------------------------------
# Le script affirme « comme au premier démarrage » : autant le vérifier plutôt
# que de le supposer. C'est l'API qui décide quel écran s'affiche, donc c'est
# elle qu'on interroge.
say "Vérification"
STATE=''
i=0
while [ "$i" -lt 30 ]; do
  STATE=$(curl -fsS "$BASE/api/v1/setup/state.json" 2>/dev/null || printf '')
  case "$STATE" in *'"needsSetup":true'*) break ;; esac
  i=$((i + 1))
  sleep 1
done

case "$STATE" in
  *'"needsSetup":true'*)
    printf '\n%s%s Réinitialisé.%s\n' "$OK" "$B" "$R"
    printf '    Administration   %s/app\n' "$BASE"
    [ -z "$SLUG" ] || printf '    Page publique    %s/s/%s\n' "$BASE" "$SLUG"
    printf '\n'
    if [ -z "$SLUG" ]; then
      note "L'assistant attend : nom de la page, compte, puis messagerie."
    else
      note "L'assistant attend : compte, puis messagerie."
    fi
    note "La première personne à ouvrir cette adresse devient l'administrateur."
    ;;
  '')
    printf '\n%s==> Base réinitialisée, mais l'"'"'API ne répond pas sur %s.%s\n' "$WARN" "$BASE" "$R"
    note "En développement, relancez pnpm dev — sa connexion a été coupée."
    ;;
  *)
    die "L'API répond mais annonce needsSetup=false. Un compte a déjà été recréé ?"
    ;;
esac

printf '\n'

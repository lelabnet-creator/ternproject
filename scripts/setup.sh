#!/bin/sh
#
# TERN — installation d'une instance Docker.
#
#   ./scripts/setup.sh
#
# Pose les questions, écrit .env, construit l'image et démarre la pile.
# Rejouable : les valeurs déjà présentes dans .env deviennent les défauts, et
# il suffit de valider pour les garder.
#
# POSIX sh plutôt que bash : macOS livre encore bash 3.2, et rien ici ne
# demande davantage.

set -eu

COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env"

if [ -t 1 ]; then
  B=$(printf '\033[1m'); DIM=$(printf '\033[2m'); R=$(printf '\033[0m')
  OK=$(printf '\033[32m'); ERR=$(printf '\033[31m')
else
  B=''; DIM=''; R=''; OK=''; ERR=''
fi

say()  { printf '\n%s==>%s %s\n' "$B" "$R" "$1"; }
note() { printf '    %s%s%s\n' "$DIM" "$1" "$R"; }
die()  { printf '%s==> %s%s\n' "$ERR" "$1" "$R" >&2; exit 1; }

# --- prérequis ---------------------------------------------------------------
cd "$(dirname "$0")/.."
[ -f "$COMPOSE_FILE" ] || die "$COMPOSE_FILE introuvable — lancez ce script depuis le dépôt."

command -v docker >/dev/null 2>&1 || die "Docker est requis."
docker compose version >/dev/null 2>&1 \
  || die "Docker Compose v2 est requis (docker compose), et Docker doit tourner."
docker info >/dev/null 2>&1 || die "Le démon Docker ne répond pas."

# Les questions se lisent au clavier. Si l'entrée standard n'est pas un
# terminal — `curl … | sh` — il n'y a personne pour répondre, et poser la
# question quand même produirait une instance aux réponses vides.
[ -t 0 ] || die "Script interactif : téléchargez-le puis exécutez-le (pas de pipe)."

# --- lecture de l'existant ---------------------------------------------------
# Relire .env plutôt que le réécrire à l'aveugle : une deuxième exécution ne
# doit pas effacer une valeur saisie la première fois.
current() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | sed 's/^"//; s/"$//'
}

# `ask <variable> <question> <défaut>` — le défaut affiché est celui de .env
# s'il existe, sinon celui passé en argument.
ask() {
  _var=$1; _prompt=$2; _default=$(current "$1"); [ -n "$_default" ] || _default=${3:-}
  if [ -n "$_default" ]; then
    printf '    %s %s[%s]%s : ' "$_prompt" "$DIM" "$_default" "$R"
  else
    printf '    %s : ' "$_prompt"
  fi
  read -r _answer || _answer=''
  [ -n "$_answer" ] || _answer=$_default
  eval "$_var=\$_answer"
}

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
  fi
}

printf '%s\n' "$B┌─ TERN — installation ─────────────────────────────────────────┐$R"
note "Entrée pour accepter la valeur entre crochets."

# --- l'accès -----------------------------------------------------------------
say "L'accès HTTP"
ask TERN_HTTP_PORT "Port publié sur l'hôte" "8080"
ask PUBLIC_BASE_URL "URL publique (celle qu'un navigateur utilise)" "http://localhost:$TERN_HTTP_PORT"
note "Derrière un reverse proxy, indiquez l'URL externe, pas localhost."
ask TRUSTED_PROXIES "CIDR des proxys de confiance (vide si accès direct)" ""

# --- écriture ----------------------------------------------------------------
# APP_SECRET n'est généré qu'une fois. Le régénérer rendrait illisibles les
# secrets TOTP, les en-têtes d'authentification des sondes et les adresses des
# abonnés déjà chiffrés.
APP_SECRET=$(current APP_SECRET)
case "$APP_SECRET" in
  ''|change-me-openssl-rand-hex-32) APP_SECRET=$(random_hex); _secret_new=1 ;;
  *) _secret_new='' ;;
esac

POSTGRES_PASSWORD=$(current POSTGRES_PASSWORD)
[ -n "$POSTGRES_PASSWORD" ] || POSTGRES_PASSWORD=$(random_hex)

say "Écriture de $ENV_FILE"
[ ! -f "$ENV_FILE" ] || cp "$ENV_FILE" "$ENV_FILE.bak"

# umask avant la redirection : le fichier contient APP_SECRET, et il ne doit
# pas naître lisible par tout le monde.
(
  umask 077
  cat > "$ENV_FILE" <<EOF
# Généré par scripts/setup.sh — ne pas committer (.gitignore bloque .env*).

# ── Base de données ─────────────────────────────────────────────────────────
POSTGRES_PASSWORD=$POSTGRES_PASSWORD

# ── Secret d'instance ───────────────────────────────────────────────────────
# Chiffre les secrets TOTP, les en-têtes d'authentification des sondes et les
# adresses des abonnés. Le changer rend ces valeurs illisibles : à sauvegarder
# avec la base, jamais à régénérer.
APP_SECRET=$APP_SECRET

# ── Accès ───────────────────────────────────────────────────────────────────
TERN_HTTP_PORT=$TERN_HTTP_PORT
PUBLIC_BASE_URL=$PUBLIC_BASE_URL
TRUSTED_PROXIES=$TRUSTED_PROXIES
LOG_LEVEL=info

# ── Le produit ──────────────────────────────────────────────────────────────
# Rien ici, et c'est voulu : le nom de la page, son adresse, le compte
# administrateur et le serveur d'envoi se saisissent au premier chargement de
# l'administration, par la personne qui est devant. Aucun mot de passe n'a donc
# à passer par ce fichier — un mot de passe en clair qui traîne finit par être
# lu.
#
# Pour une instance exposée avant que quiconque ne l'ouvre, définir
# TERN_TENANT_SLUG, TERN_TENANT_NAME, TERN_ADMIN_EMAIL et TERN_ADMIN_PASSWORD
# crée tout au démarrage et ferme la fenêtre avant la première requête servie.
EOF
)

note "$ENV_FILE écrit (permissions 600)"
[ -z "${_secret_new:-}" ] || note "APP_SECRET généré localement, jamais transmis"

# --- démarrage ---------------------------------------------------------------
# Deux chemins : tirer une image publiée, ou construire depuis ce dépôt. Le
# premier est celui d'une installation ; le second celui d'un développeur ou
# d'une version modifiée.
if [ -n "${TERN_IMAGE:-}" ]; then
  say "Récupération de $TERN_IMAGE et démarrage"
  # Écrit dans .env pour que les `docker compose` suivants visent la même image
  # que ce démarrage-ci.
  printf '\nTERN_IMAGE=%s\n' "$TERN_IMAGE" >> "$ENV_FILE"
  if ! docker compose -f "$COMPOSE_FILE" pull app; then
    die "Image introuvable : $TERN_IMAGE"
  fi
  _up='up -d --wait'
else
  say "Construction de l'image et démarrage"
  note "La première construction prend quelques minutes."
  note "Pour utiliser une image publiée : TERN_IMAGE=… ./scripts/setup.sh"
  _up='up -d --build --wait'
fi

# --wait rend la main sur le healthcheck, donc après les migrations et la
# création de la page — pas seulement au démarrage du conteneur.
# shellcheck disable=SC2086
if ! docker compose -f "$COMPOSE_FILE" $_up; then
  printf '\n%s==> Le démarrage a échoué.%s\n' "$ERR" "$R" >&2
  printf '    docker compose -f %s logs app\n' "$COMPOSE_FILE" >&2
  exit 1
fi

printf '\n%s%s Prêt.%s\n' "$OK" "$B" "$R"
printf '    Administration   %s/app\n\n' "$PUBLIC_BASE_URL"

# Dit tout de suite, et en premier : tant que le compte n'existe pas, la page
# d'administration crée le compte pour qui l'ouvre. C'est une fenêtre, et elle
# se ferme à la première création.
printf '%s%s Ouvrez l'"'"'administration maintenant.%s\n' "$OK" "$B" "$R"
note "Vous y nommerez la page, créerez le compte administrateur"
note "et réglerez le serveur d'envoi."
note "Tant que ce compte n'existe pas, la première personne à ouvrir"
note "cette adresse devient l'administrateur."
printf '\n'
note "Arrêt      : docker compose -f $COMPOSE_FILE down"
note "Journaux   : docker compose -f $COMPOSE_FILE logs -f app"
printf '\n'

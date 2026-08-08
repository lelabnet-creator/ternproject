#!/bin/sh
#
# TERN — installation d'une instance Docker.
#
#   ./scripts/setup.sh                     (depuis un checkout)
#   curl -fsSL -o setup.sh … && sh setup.sh  (seul, dans un répertoire vide)
#
# Pose les questions, écrit .env, construit l'image et démarre la pile.
# Rejouable : les valeurs déjà présentes dans .env deviennent les défauts, et
# il suffit de valider pour les garder.
#
# Ce fichier suffit à installer : il récupère le compose s'il ne l'a pas, et
# c'est le seul autre fichier nécessaire tant qu'on part d'une image publiée.
# Cloner le dépôt ne sert qu'à construire depuis les sources.
#
# POSIX sh plutôt que bash : macOS livre encore bash 3.2, et rien ici ne
# demande davantage.

set -eu

COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env"

# Le chemin absolu de ce fichier, retenu avant tout `cd`.
#
# Sert à une chose : se relancer sous `sg docker` après s'être ajouté au groupe,
# pour finir l'installation dans la même session. `$0` seul ne suffirait pas —
# il vaut souvent `setup.sh` ou `./scripts/setup.sh`, et le répertoire courant a
# changé entre-temps.
SCRIPT_SELF=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/$(basename -- "$0")

# D'où le compose est tiré quand ce script tourne seul, et l'image servie
# faute de sources à construire. La branche est figée : un script téléchargé
# aujourd'hui doit installer la même chose dans six mois.
RAW_BASE="https://raw.githubusercontent.com/lelabnet-creator/ternproject/main"
PUBLISHED_IMAGE="ghcr.io/lelabnet-creator/ternproject:latest"

if [ -t 1 ]; then
  B=$(printf '\033[1m'); DIM=$(printf '\033[2m'); R=$(printf '\033[0m')
  OK=$(printf '\033[32m'); ERR=$(printf '\033[31m')
else
  B=''; DIM=''; R=''; OK=''; ERR=''
fi

# `gum`, s'il se trouve être là.
#
# Une amélioration, jamais une exigence. Ce fichier tient à être un seul script
# lisible qu'on télécharge et qu'on exécute : en faire dépendre l'installation
# d'un binaire Go absent de toutes les distributions par défaut reviendrait à
# demander une installation avant l'installation. Et aller le chercher sur
# GitHub à la volée contredirait la raison même pour laquelle on refuse plus bas
# de piper `get.docker.com` dans un shell.
#
# Alors : si la personne l'a déjà — beaucoup l'ont, il est dans Homebrew, dans
# les dépôts d'Arch et dans ceux de Charm — l'installation est plus agréable à
# regarder. Sinon elle est identique à ce qu'elle était, au caractère près.
#
# Seulement quand la sortie est un terminal : dans un journal de CI, les codes
# d'échappement de gum sont du bruit que personne ne relira.
if [ -t 1 ] && command -v gum >/dev/null 2>&1; then GUM=1; else GUM=''; fi

say() {
  if [ -n "$GUM" ]; then
    printf '\n'
    gum style --bold --foreground 212 "==> $1"
  else
    printf '\n%s==>%s %s\n' "$B" "$R" "$1"
  fi
}

note() {
  if [ -n "$GUM" ]; then
    gum style --foreground 245 "    $1"
  else
    printf '    %s%s%s\n' "$DIM" "$1" "$R"
  fi
}

die() {
  if [ -n "$GUM" ]; then
    gum style --bold --foreground 196 "==> $1" >&2
  else
    printf '%s==> %s%s\n' "$ERR" "$1" "$R" >&2
  fi
  exit 1
}

# --- lecture de l'existant ---------------------------------------------------
# Relire .env plutôt que le réécrire à l'aveugle : une deuxième exécution ne
# doit pas effacer une valeur saisie la première fois.
#
# Ces fonctions sont définies avant les prérequis, et non juste avant les
# questions qu'elles servent : l'installation de Docker, plus bas, en pose déjà
# une, et en sh une fonction doit exister avant d'être appelée.
current() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | sed 's/^"//; s/"$//'
}

# `ask <variable> <question> <défaut>` — le défaut affiché est celui de .env
# s'il existe, sinon celui passé en argument.
ask() {
  _var=$1; _prompt=$2; _default=$(current "$1"); [ -n "$_default" ] || _default=${3:-}

  if [ -n "$GUM" ]; then
    # `--value` préremplit la ligne : la valeur par défaut est modifiable au
    # lieu d'être à retaper, ce qu'une invite entre crochets ne permet pas.
    # Elle reste acceptable d'une simple entrée, comme avant.
    _answer=$(gum input --prompt "  $_prompt " --value "$_default" --width 72) || _answer=''
  else
    if [ -n "$_default" ]; then
      printf '    %s %s[%s]%s : ' "$_prompt" "$DIM" "$_default" "$R"
    else
      printf '    %s : ' "$_prompt"
    fi
    read -r _answer || _answer=''
  fi

  [ -n "$_answer" ] || _answer=$_default
  eval "$_var=\$_answer"
}

# `confirm <variable> <question> <défaut o|n>` — o/n, joliment quand c'est
# possible.
#
# Réécrit dans la même variable que `ask` remplirait, et avec les mêmes valeurs
# `o`/`n`, pour que le reste du script n'ait pas à savoir laquelle des deux
# formes a posé la question.
confirm() {
  _cvar=$1; _cprompt=$2; _cdefault=${3:-o}

  if [ -n "$GUM" ]; then
    if [ "$_cdefault" = o ]; then
      gum confirm --affirmative "Oui" --negative "Non" "$_cprompt" && _canswer=o || _canswer=n
    else
      gum confirm --affirmative "Oui" --negative "Non" --default=false "$_cprompt" \
        && _canswer=o || _canswer=n
    fi
  else
    ask _canswer "$_cprompt (o/n)" "$_cdefault"
    case "$_canswer" in
      o|O|y|Y|oui|OUI|yes|YES) _canswer=o ;;
      *) _canswer=n ;;
    esac
  fi

  eval "$_cvar=\$_canswer"
}

# Un cadre, quand on peut en dessiner un.
#
# `printf` sait tracer une boîte à condition de compter les caractères à la
# main, ce qui se voit dès qu'un accent ou une largeur de terminal s'en mêle.
# gum la dessine à la bonne taille sans qu'on ait à savoir laquelle.
panel() {
  if [ -n "$GUM" ]; then
    gum style --border rounded --border-foreground 212 --padding "1 3" --margin "1 0" "$@"
  else
    printf '\n%s┌───────────────────────────────────────────────────────────┐%s\n' "$B" "$R"
    for _line in "$@"; do printf '  %s\n' "$_line"; done
    printf '%s└───────────────────────────────────────────────────────────┘%s\n' "$B" "$R"
  fi
}

# Une attente qui montre qu'elle avance.
#
# Trois opérations de ce script prennent des minutes sans rien afficher : la
# pose des paquets, le tirage de l'image, et la venue de l'API. Un terminal
# muet pendant trois minutes ressemble à un blocage, et c'est le moment où l'on
# interrompt une installation qui se serait très bien terminée.
#
# La sortie de la commande est gardée en cas d'échec — un joli tourniquet qui
# avale le message d'erreur ne rend service à personne.
#
# `as_root true` avant de lancer le tourniquet : si sudo doit demander un mot de
# passe, il faut que la question soit visible. Posée derrière une animation,
# elle donne une installation qui semble figée pour une raison invisible.
# `as_root` est traduit en commande réelle avant d'arriver ici : `gum spin --`
# exécute un programme, pas une fonction du shell, et lui passer `as_root`
# donnerait un « command not found » au moment précis où l'on installe.
spin() {
  _spin_msg=$1; shift

  if [ "$1" = as_root ]; then
    shift
    if [ "$(id -u)" -ne 0 ]; then
      # Le mot de passe est demandé maintenant, en clair à l'écran. Derrière un
      # tourniquet, l'invite est invisible et l'installation paraît figée sans
      # raison.
      sudo -v 2>/dev/null || true
      set -- sudo "$@"
    fi
  fi

  if [ -n "$GUM" ]; then
    gum spin --spinner dot --title "$_spin_msg" --show-error -- "$@"
  else
    note "$_spin_msg"
    "$@"
  fi
}

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
  fi
}

# --- prérequis ---------------------------------------------------------------
# Deux provenances. Depuis un checkout, ce fichier est dans scripts/ et tout se
# passe un cran au-dessus. Téléchargé seul, il est déjà dans le répertoire que
# la personne a choisi — y remonter d'un cran installerait l'instance dans le
# répertoire parent, qui n'est pas celui qu'elle a créé pour ça. D'où le test :
# on ne remonte que si le compose s'y trouve effectivement.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$SCRIPT_DIR/../$COMPOSE_FILE" ]; then
  cd "$SCRIPT_DIR/.."
fi

# Les questions se lisent au clavier. Si l'entrée standard n'est pas un
# terminal — `curl … | sh` — il n'y a personne pour répondre, et poser la
# question quand même produirait une instance aux réponses vides. Vérifié avant
# Docker, désormais : l'absence de Docker débouche elle aussi sur une question.
[ -t 0 ] || die "Script interactif : téléchargez-le puis exécutez-le (pas de pipe)."

# --- Docker, s'il manque -----------------------------------------------------
# Sans Docker il n'y a rien à installer. Plutôt que de s'arrêter sur ce constat
# et de laisser la personne chercher, on propose de l'installer — à trois
# conditions.
#
# On demande d'abord. Poser des paquets système et activer un service au
# démarrage n'est pas une décision qu'un script d'installation prend à la place
# de qui le lance, même quand elle paraît évidente.
#
# On passe par le gestionnaire de paquets de la distribution, pas par
# `curl … get.docker.com | sh`. Ce fichier tient à être lisible avant d'être
# exécuté ; y piper un script distant, absent de ce dépôt et modifiable après
# coup, retirerait tout son sens à cette lisibilité. La contrepartie est une
# version parfois plus ancienne que celle publiée par Docker — acceptable ici,
# Compose v2 étant le seul prérequis réel.
#
# On refuse plutôt que de deviner. Distribution non reconnue, paquet absent des
# dépôts configurés, init exotique : on renvoie vers la documentation
# officielle. Une installation de Docker bricolée ne se paie pas maintenant,
# mais des mois plus tard et ailleurs.

# La sortie commune à tous les cas où l'on n'installe pas. Une seule adresse,
# celle de Docker, plutôt qu'une commande approximative à recopier de travers.
docker_manual_exit() {
  printf '\n%s==> %s%s\n' "$ERR" "$1" "$R" >&2
  [ -z "${2:-}" ] || printf '    %s\n' "$2" >&2
  printf '    Installation : https://docs.docker.com/engine/install/\n' >&2
  printf '    Puis relancez ce script.\n' >&2
  exit 1
}

# Les droits d'administration, et seulement quand ils manquent : sur une VM
# fraîche ou dans un conteneur on est souvent déjà root, et sudo n'y est pas
# toujours installé.
as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

# Le gestionnaire de paquets, détecté par la commande présente et non par
# /etc/os-release seul : un dérivé se déclare rarement comme sa base, et ce qui
# compte est le gestionnaire qu'on va réellement appeler, pas le nom que la
# distribution se donne.
#
# apt-get plutôt qu'apt : apt avertit lui-même qu'il n'a pas d'interface stable
# pour les scripts.
#
# Sa propre fonction parce que deux installations l'utilisent — Docker, sans qui
# rien ne tourne, et gum, qui ne fait qu'embellir. Elle renseigne `PKG` et se
# contente d'échouer ; c'est à l'appelant de décider si c'est grave.
detect_pkg() {
  if command -v apt-get >/dev/null 2>&1; then
    PKG=apt
  elif command -v dnf >/dev/null 2>&1; then
    PKG=dnf
  elif command -v yum >/dev/null 2>&1; then
    PKG=yum
  elif command -v pacman >/dev/null 2>&1; then
    PKG=pacman
  else
    return 1
  fi
}

# Un paquet existe-t-il dans les dépôts *déjà* configurés ? On ne cherche pas
# ailleurs : ajouter le dépôt de Docker demanderait d'importer une clé et
# d'écrire un fichier de dépôt, ce qui ne serait pas plus vérifiable que le
# script distant qu'on vient d'écarter.
pkg_available() {
  case "$PKG" in
    apt)    apt-cache show "$1" 2>/dev/null | grep -q '^Package:' ;;
    dnf)    dnf -q info "$1" >/dev/null 2>&1 ;;
    yum)    yum -q info "$1" >/dev/null 2>&1 ;;
    pacman) pacman -Si "$1" >/dev/null 2>&1 ;;
  esac
}

# Le premier nom disponible parmi ceux proposés : le même logiciel ne s'appelle
# pas pareil d'une distribution à l'autre, et certaines en publient deux
# variantes selon les dépôts activés.
pkg_first_available() {
  for _candidate in "$@"; do
    if pkg_available "$_candidate"; then
      printf '%s\n' "$_candidate"
      return 0
    fi
  done
  return 1
}

# La commande est affichée avant d'être lancée : un script qui réclame les
# droits d'administration doit dire ce qu'il en fait.
pkg_install() {
  case "$PKG" in
    apt)
      note "apt-get install -y $*"
      spin "Installation de $*" as_root apt-get install -y "$@"
      ;;
    dnf)
      note "dnf install -y $*"
      spin "Installation de $*" as_root dnf install -y "$@"
      ;;
    yum)
      note "yum install -y $*"
      as_root yum install -y "$@"
      ;;
    pacman)
      # Sans -y : `pacman -Sy paquet` fabrique une mise à jour partielle, que
      # cette distribution ne pardonne pas. Si la base est trop vieille pour
      # que l'installation aboutisse, c'est un `pacman -Syu` qu'il faut, et
      # celui-là ne se lance pas au nom de quelqu'un d'autre.
      note "pacman -S --needed --noconfirm $*"
      spin "Installation de $*" as_root pacman -S --needed --noconfirm "$@"
      ;;
  esac
}

# Ne rend la main que si Docker est installé ; dans tous les autres cas elle
# sort elle-même du script.
# L'accès au socket, quel que soit le chemin par lequel Docker est arrivé.
#
# Ce bloc vivait dans `install_docker`, donc il ne s'exécutait que lorsque ce
# script venait de poser Docker lui-même. Sur une machine où Docker était déjà
# installé — ce qui est le cas le plus courant — le compte sans accès au socket
# tombait vingt lignes plus bas sur « Le démon Docker ne répond pas », qui est
# faux : le démon répond parfaitement, c'est ce compte qui ne peut pas lui
# parler. Le script connaissait le remède et ne le proposait pas.
#
# Le socket doit exister pour que le diagnostic tienne : sans lui, c'est bien le
# démon qui manque, et le contrôle plus bas le dira mieux.
ensure_docker_access() {
  # Reste l'accès au socket, premier mur après une installation réussie : il
  # appartient au groupe `docker`, le compte courant n'y est pas, et `docker`
  # répond « permission denied ».
  #
  # Le socket doit exister pour que le diagnostic tienne : sans lui, c'est le
  # démon qui manque, et le contrôle `docker info` plus bas le dira mieux.
  if [ "$(id -u)" -ne 0 ] && [ -S /var/run/docker.sock ] && ! docker info >/dev/null 2>&1; then
    # Ce script s'arrêtait ici, avec la commande à taper et l'instruction de se
    # reconnecter puis de tout relancer. C'était lui laisser la moitié du
    # travail qu'elle venait de demander en une commande — et la moitié la plus
    # déroutante, puisque « ouvrez un nouveau terminal » ne suffit pas.
    #
    # Appartenir au groupe `docker` équivaut à être root sur cette machine : ça
    # se demande, ça ne s'attrape pas au passage. Mais la personne vient
    # d'autoriser l'installation de Docker, qui a exactement la même portée, et
    # le sudo est déjà accordé. Alors on demande, et si c'est oui on va au bout.
    say "Accès au démon Docker"
    note "Docker n'est utilisable que par root et par le groupe « docker »."
    note "Appartenir à ce groupe équivaut à être administrateur de cette machine."

    confirm _join_docker "Ajouter $(id -un) au groupe docker ?" o
    case "$_join_docker" in
      o) ;;
      *)
        docker_manual_exit "Docker est installé, mais votre compte n'y a pas accès." \
          "Sans cela : sudo usermod -aG docker $(id -un), puis rouvrez votre session."
        ;;
    esac

    as_root usermod -aG docker "$(id -un)" \
      || docker_manual_exit "Impossible d'ajouter $(id -un) au groupe docker."
    note "Ajouté. Prend effet à la prochaine ouverture de session."

    # Et on termine maintenant, dans cette session-ci.
    #
    # L'appartenance à un groupe n'est lue qu'à l'ouverture de session : le
    # processus courant ne l'a pas, et ne l'aura pas. `sg` ouvre une session de
    # groupe pour une commande, ce qui permet de relancer ce script avec l'accès
    # plutôt que de renvoyer quelqu'un se déconnecter au milieu d'une
    # installation.
    #
    # `TERN_REEXEC` empêche la boucle : si l'accès manque encore après ça, le
    # problème n'est pas l'appartenance, et il faut le dire plutôt que
    # recommencer indéfiniment.
    if [ -z "${TERN_REEXEC:-}" ] && command -v sg >/dev/null 2>&1; then
      note "Reprise de l'installation avec les droits acquis…"
      TERN_REEXEC=1
      export TERN_REEXEC
      exec sg docker -c "sh $SCRIPT_SELF"
    fi

    docker_manual_exit "Votre compte vient d'être ajouté au groupe docker." \
      "Fermez cette session, rouvrez-en une, et relancez ce script."
  fi

  return 0
}

install_docker() {
  # macOS d'abord : il n'y a pas de gestionnaire de paquets système à
  # interroger, et le moteur y arrive avec Docker Desktop, qui n'est pas un
  # paquet.
  case "$(uname -s)" in
    Linux) ;;
    Darwin)
      docker_manual_exit "Docker est requis." \
        "Sur macOS, installez Docker Desktop et lancez-le avant de relancer ce script."
      ;;
    *)
      docker_manual_exit "Docker est requis." \
        "Ce script ne sait pas installer Docker sur $(uname -s)."
      ;;
  esac

  detect_pkg || docker_manual_exit "Docker est requis." \
    "Aucun gestionnaire de paquets connu ici (apt-get, dnf, yum, pacman)."

  if [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
    docker_manual_exit "Docker est requis." \
      "L'installation demande les droits d'administration, et ni root ni sudo ne répondent ici."
  fi

  say "Docker n'est pas installé"
  note "Gestionnaire de paquets détecté : $PKG"
  note "Les paquets viendront des dépôts de cette distribution."
  # Dit avant de le faire : un mot de passe réclamé sans prévenir au milieu
  # d'un script ressemble à un incident.
  [ "$(id -u)" -eq 0 ] || note "L'installation passera par sudo ; un mot de passe sera peut-être demandé."

  confirm _install_docker "Installer Docker maintenant ?" o
  case "$_install_docker" in
    o) ;;
    *) docker_manual_exit "Docker est requis, et l'installation a été refusée." ;;
  esac

  # Les listes de paquets d'abord, sur apt : sans elles il n'y a rien à
  # interroger, et l'installation échouerait sur un paquet que la machine
  # connaît pourtant.
  if [ "$PKG" = apt ]; then
    say "Mise à jour des listes de paquets"
    note "apt-get update"
    as_root apt-get update || docker_manual_exit "apt-get update a échoué."
  fi

  # Le moteur, puis le plugin Compose, sous les noms de chaque distribution.
  # docker-ce n'apparaît que si le dépôt de Docker a déjà été ajouté sur cette
  # machine — dans ce cas autant s'en servir, il est plus à jour que celui de
  # la distribution.
  case "$PKG" in
    apt)
      _engine=$(pkg_first_available docker-ce docker.io) || _engine=''
      _compose=$(pkg_first_available docker-compose-plugin docker-compose-v2) || _compose=''
      _compose_hint='docker-compose-v2, ou docker-compose-plugin avec le dépôt de Docker'
      ;;
    dnf|yum)
      _engine=$(pkg_first_available docker-ce moby-engine) || _engine=''
      _compose=$(pkg_first_available docker-compose-plugin docker-compose) || _compose=''
      _compose_hint='docker-compose-plugin, ou docker-compose sur Fedora'
      ;;
    pacman)
      _engine=$(pkg_first_available docker) || _engine=''
      _compose=$(pkg_first_available docker-compose) || _compose=''
      _compose_hint='docker-compose'
      ;;
  esac

  # Le cas typique est RHEL, Rocky ou Alma : leurs dépôts de base ne publient
  # pas Docker du tout. Ajouter celui de Docker à leur place serait exactement
  # le genre de décision qu'on s'est interdit plus haut.
  [ -n "$_engine" ] || docker_manual_exit \
    "Aucun paquet Docker dans les dépôts configurés de cette machine." \
    "Il faudrait y ajouter le dépôt de Docker, ce que ce script ne fait pas."

  say "Installation de Docker"
  pkg_install "$_engine" || docker_manual_exit "L'installation de $_engine a échoué."

  # Compose est un paquet distinct partout, et c'est celui qu'on oublie.
  if [ -n "$_compose" ]; then
    pkg_install "$_compose" || docker_manual_exit "L'installation de $_compose a échoué."
  fi

  # Le service, s'il y a un systemd pour le porter. `systemctl` peut exister
  # sans que systemd soit l'init — conteneurs, WSL sans systemd, systèmes qui
  # gardent l'outil par compatibilité. /run/systemd/system, lui, n'apparaît que
  # si systemd tourne vraiment.
  if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
    say "Activation du service Docker"
    note "systemctl enable --now docker"
    as_root systemctl enable --now docker \
      || docker_manual_exit "Le service docker n'a pas démarré." "À regarder : systemctl status docker"
  else
    note "Init non-systemd : démarrez le démon Docker vous-même avant de continuer."
  fi

  # Compose v2 vérifié ici, tant qu'on sait encore de quelle distribution il
  # s'agit. Trois lignes plus bas, le contrôle générique échouerait sans
  # pouvoir nommer le paquet à installer, et c'est précisément le seul
  # renseignement utile à ce moment-là.
  docker compose version >/dev/null 2>&1 || docker_manual_exit \
    "Docker est installé, mais le plugin Compose v2 manque." \
    "Paquet attendu sur cette distribution : $_compose_hint"

  ensure_docker_access

  say "Docker est installé"
}

# --- gum, pour que ce qui suit soit agréable à lire --------------------------
#
# Même démarche que pour Docker — on demande, on passe par les dépôts de la
# distribution — et une différence qui change tout : gum est décoratif. Rien de
# ce qui suit n'en dépend, et donc rien de ce qui suit ne doit s'arrêter à cause
# de lui. Paquet absent des dépôts, installation refusée, installation ratée :
# on continue avec l'affichage d'origine, sans en faire une histoire.
#
# Proposé ici, avant l'installation de Docker, parce que c'est ce qui reste à
# poser des questions ensuite : le proposer plus tard n'embellirait plus rien.
offer_gum() {
  [ -z "$GUM" ] || return 0
  [ -t 1 ] || return 0
  detect_pkg || return 0

  say "Affichage"
  note "gum rend les questions de cette installation plus lisibles."
  note "Purement esthétique : tout fonctionne à l'identique sans lui."

  confirm _want_gum "Installer gum ?" o
  [ "$_want_gum" = o ] || return 0

  # D'abord les dépôts de la distribution, quand ils l'ont. Arch et Fedora le
  # publient ; Ubuntu 24.04 non — `apt-cache show gum` n'y renvoie rien.
  if _gum_pkg=$(pkg_first_available gum); then
    [ "$PKG" != apt ] || as_root apt-get update >/dev/null 2>&1 || true
    if pkg_install "$_gum_pkg" && command -v gum >/dev/null 2>&1; then
      GUM=1
      note "Installé depuis les dépôts de la distribution."
      return 0
    fi
  fi

  # Sinon la version publiée par Charm, et c'est un arbitrage différent de celui
  # fait pour Docker quelques lignes plus haut.
  #
  # Docker est un service qui vivra des années sur cette machine : un moteur
  # d'origine douteuse s'y paie longtemps, d'où le refus d'aller le chercher
  # ailleurs que dans les dépôts. gum est un binaire autonome dont ce script se
  # sert pendant deux minutes, qu'il n'installe nulle part, qui ne démarre à
  # aucun boot et qui disparaît avec le répertoire temporaire. Le risque n'est
  # pas de la même nature, et la somme de contrôle le referme.
  #
  # Version figée, jamais « latest » : un script qui installe ce qui se trouve
  # être publié le jour où on l'exécute n'est pas reproductible.
  gum_from_release || {
    note "Récupération impossible — on continue sans, à l'identique."
    return 0
  }

  return 0
}

# La version publiée par Charm, vérifiée puis dépliée dans un répertoire
# temporaire.
#
# Rien n'est écrit hors de ce répertoire, et il part avec le shell. Un
# `PATH` étendu suffit à ce que `command -v gum` le trouve pour la durée de
# l'installation.
GUM_VERSION=0.17.0
gum_from_release() {
  command -v curl >/dev/null 2>&1 || return 1
  command -v tar >/dev/null 2>&1 || return 1

  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64|Linux-amd64)   _gum_asset="gum_${GUM_VERSION}_Linux_x86_64.tar.gz" ;;
    Linux-aarch64|Linux-arm64)  _gum_asset="gum_${GUM_VERSION}_Linux_arm64.tar.gz" ;;
    Darwin-arm64)               _gum_asset="gum_${GUM_VERSION}_Darwin_arm64.tar.gz" ;;
    Darwin-x86_64)              _gum_asset="gum_${GUM_VERSION}_Darwin_x86_64.tar.gz" ;;
    *) return 1 ;;
  esac

  _gum_base="https://github.com/charmbracelet/gum/releases/download/v${GUM_VERSION}"
  _gum_dir=$(mktemp -d 2>/dev/null) || return 1

  note "Récupération de gum $GUM_VERSION ($_gum_asset)"
  curl -fsSL -o "$_gum_dir/$_gum_asset" "$_gum_base/$_gum_asset" || return 1
  curl -fsSL -o "$_gum_dir/checksums.txt" "$_gum_base/checksums.txt" || return 1

  # Vérifiée avant d'être dépliée. C'est ce qui distingue « récupérer une
  # archive publiée » de « exécuter ce qui arrive » — sans cette ligne, l'objet
  # serait exactement le `curl … | sh` que ce script refuse plus haut.
  if command -v sha256sum >/dev/null 2>&1; then
    _gum_sum=$(sha256sum "$_gum_dir/$_gum_asset" | cut -d' ' -f1)
  elif command -v shasum >/dev/null 2>&1; then
    _gum_sum=$(shasum -a 256 "$_gum_dir/$_gum_asset" | cut -d' ' -f1)
  else
    note "Ni sha256sum ni shasum : impossible de vérifier l'archive, on renonce."
    return 1
  fi

  grep -q "^$_gum_sum  $_gum_asset\$" "$_gum_dir/checksums.txt" || {
    note "⚠ La somme de contrôle ne correspond pas. Archive écartée."
    return 1
  }

  tar -xzf "$_gum_dir/$_gum_asset" -C "$_gum_dir" || return 1

  # L'archive place le binaire à la racine ou dans un sous-répertoire selon les
  # versions ; on le cherche plutôt que de parier.
  _gum_bin=$(find "$_gum_dir" -type f -name gum -perm -u+x 2>/dev/null | head -1)
  [ -n "$_gum_bin" ] || return 1

  PATH="$(dirname "$_gum_bin"):$PATH"
  export PATH
  command -v gum >/dev/null 2>&1 || return 1

  GUM=1
  note "Vérifié et prêt — pour cette installation seulement, rien n'est posé sur le système."
  return 0
}

offer_gum

# Appelée depuis le corps d'un `if`, et non derrière un `||` : dans une liste
# `a || b`, `set -e` est suspendu pour tout ce que `b` exécute, y compris à
# l'intérieur d'une fonction. L'installation ci-dessous a besoin qu'une commande
# qui échoue arrête le script.
if ! command -v docker >/dev/null 2>&1; then
  install_docker
else
  # Docker était déjà là : on n'installe rien, mais l'accès au socket se vérifie
  # exactement de la même façon.
  ensure_docker_access
fi

docker compose version >/dev/null 2>&1 \
  || die "Docker Compose v2 est requis (docker compose), et Docker doit tourner."
# Distinguer les deux, parce que le remède n'est pas le même. `ensure_docker_access`
# a déjà proposé le groupe si c'était ça ; arriver ici avec un socket présent
# veut dire que la personne a refusé, et le lui redire clairement vaut mieux
# qu'un diagnostic qui accuse le démon.
if ! docker info >/dev/null 2>&1; then
  if [ -S /var/run/docker.sock ]; then
    die "Votre compte n'a pas accès au démon Docker (le démon, lui, tourne)."
  fi
  die "Le démon Docker ne répond pas."
fi

# Le compose, s'il manque. C'est le seul fichier que ce script lui-même ne
# porte pas, et le récupérer ici évite de faire cloner 40 Mo de sources pour
# une installation qui n'en lira que celui-là.
if [ ! -f "$COMPOSE_FILE" ]; then
  command -v curl >/dev/null 2>&1 || die "curl est requis pour récupérer $COMPOSE_FILE."
  say "Récupération de $COMPOSE_FILE"
  curl -fsSL -o "$COMPOSE_FILE" "$RAW_BASE/$COMPOSE_FILE" \
    || die "Téléchargement impossible : $RAW_BASE/$COMPOSE_FILE"
  note "récupéré dans $(pwd)"
fi

panel "TERN — installation d'une instance" \
      "" \
      "Quelques questions, puis la pile démarre." \
      "Entrée accepte la valeur proposée."

# --- l'accès -----------------------------------------------------------------
say "L'accès HTTP"
ask TERN_HTTP_PORT "Port publié sur l'hôte" "8080"

# L'adresse par laquelle cette machine est jointe, et non « localhost ».
#
# `PUBLIC_BASE_URL` n'est pas décoratif : il signe les cookies, construit les
# URL d'appairage des agents, se retrouve dans les scripts d'installation
# générés et dans les liens des courriels. Y laisser `localhost` produit une
# instance qui marche parfaitement pour la personne assise devant le serveur, et
# pour personne d'autre — les agents s'appairent sur une adresse qui, chez eux,
# désigne leur propre machine, et les liens des courriels ne mènent nulle part.
#
# Le défaut proposé est donc l'adresse source que le noyau choisit pour sortir :
# celle par laquelle on atteint cette machine, dans l'immense majorité des cas.
# Le nom de domaine reste préférable quand il y en a un, et la question le
# demande — c'est un défaut, pas une décision.
primary_address() {
  # Linux : l'adresse retenue pour joindre l'extérieur. Aucun paquet n'est
  # envoyé, `route get` consulte la table.
  if command -v ip >/dev/null 2>&1; then
    ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1
    return 0
  fi
  # macOS et BSD : même question, autre outil.
  if command -v route >/dev/null 2>&1 && command -v ipconfig >/dev/null 2>&1; then
    _iface=$(route -n get 1.1.1.1 2>/dev/null | sed -n 's/.*interface: *//p' | head -1)
    [ -z "$_iface" ] || ipconfig getifaddr "$_iface" 2>/dev/null
  fi
}

_host=$(primary_address)
[ -n "$_host" ] || _host=localhost

ask PUBLIC_BASE_URL "URL publique (celle qu'un navigateur utilise)" \
  "http://$_host:$TERN_HTTP_PORT"

case "$PUBLIC_BASE_URL" in
  *localhost*|*127.0.0.1*)
    # Dit maintenant plutôt que découvert au premier agent qui refuse de
    # s'appairer, ou au premier courriel dont le lien ne mène nulle part.
    note "⚠ Cette adresse ne désigne cette machine que depuis elle-même."
    note "  Les agents distants, les liens des courriels et les scripts générés"
    note "  la reprendront telle quelle. À corriger dans .env si des tiers"
    note "  doivent accéder à cette instance."
    ;;
  *)
    note "Derrière un reverse proxy ou un nom de domaine, indiquez l'URL"
    note "externe — c'est elle qui sera reprise partout."
    ;;
esac

ask TRUSTED_PROXIES "CIDR des proxys de confiance (vide si accès direct)" ""

# --- ce que l'agent peut mesurer -------------------------------------------
# L'agent de l'instance partage par défaut la pile réseau du conteneur de l'API.
# Sa sortie vers Internet est complète, mais `127.0.0.1` y désigne le conteneur,
# pas cette machine : un service qui n'écoute que sur la loopback de l'hôte n'a
# alors aucune adresse que l'agent puisse nommer. Or « localhost » est
# exactement ce qu'on écrit quand on veut surveiller sa propre machine, et le
# contrôle échoue sans que l'adresse ait l'air fausse.
#
# La question est donc posée ici, en termes de ce qu'on veut surveiller. Le
# défaut reste le comportement actuel : un réglage réseau plus large se demande,
# il ne s'hérite pas.
say "Ce que l'agent doit pouvoir surveiller"
note "Par défaut il voit Internet et cette instance, mais pas les services"
note "de cette machine ni les autres conteneurs Docker."

case "$(current TERN_AGENT_NETWORK_MODE)" in
  host) _vantage_default=o ;;
  *)    _vantage_default=n ;;
esac

confirm _vantage "Surveiller aussi les services de cette machine ?" "$_vantage_default"

case "$_vantage" in
  o)
    TERN_AGENT_NETWORK_MODE=host
    # Indispensable, et c'est tout ce qui fait fonctionner la bascule : dans la
    # pile de la machine, l'API n'est plus sur 127.0.0.1:3011 mais sur le port
    # publié. Le garde-fou de l'agent — pas de clé en HTTP clair ailleurs que
    # vers localhost — reste satisfait, l'adresse étant bien une loopback.
    TERN_LOCAL_AGENT_SERVER="http://127.0.0.1:$TERN_HTTP_PORT"
    note "L'agent mesurera depuis la machine."
    case "$(uname -s)" in
      Linux) ;;
      *)
        note "⚠ $(uname -s) : Docker Desktop ne donne pas au mode hôte le sens"
        note "  attendu ici. Le réglage sera écrit, mais l'agent risque de ne"
        note "  voir ni la loopback de la machine ni son réseau local."
        ;;
    esac
    ;;
  *)
    TERN_AGENT_NETWORK_MODE=service:app
    TERN_LOCAL_AGENT_SERVER=''
    note "L'agent mesurera depuis son conteneur. Modifiable plus tard :"
    note "l'écran Agents indique quoi changer."
    ;;
esac

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

# ── Ce que l'agent de l'instance peut mesurer ───────────────────────────────
# service:app — il partage la pile réseau de l'API. Internet et les conteneurs
#               de cette instance ; ni la loopback de la machine, ni les autres
#               réseaux Docker.
# host        — il partage celle de la machine. Ses services en loopback, son
#               réseau local et les autres réseaux Docker deviennent visibles.
#               Linux uniquement.
#
# Les deux lignes vont ensemble : en mode hôte l'API n'est joignable que par son
# port publié, et la seconde est ce qui le dit à l'agent.
TERN_AGENT_NETWORK_MODE=$TERN_AGENT_NETWORK_MODE
TERN_LOCAL_AGENT_SERVER=$TERN_LOCAL_AGENT_SERVER

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

  # Ce que ce script ne sait pas écrire, mais que quelqu'un a ajouté à la main.
  #
  # Le fichier est régénéré depuis un gabarit fixe à chaque exécution. Sans ce
  # report, relancer le script pour changer un port effaçait SMTP_HOST,
  # INGEST_RATE_LIMIT_MAX et tout le reste — récupérables dans le .bak, mais
  # rien ne prévenait, et une limite de débit qui redevient sa valeur par défaut
  # ne se voit pas.
  if [ -f "$ENV_FILE.bak" ]; then
    _kept=$(awk -F= '
      /^[A-Za-z_][A-Za-z0-9_]*=/ {
        split($0, kv, "=")
        if (kv[1] !~ /^(POSTGRES_PASSWORD|APP_SECRET|TERN_HTTP_PORT|PUBLIC_BASE_URL|TRUSTED_PROXIES|LOG_LEVEL|TERN_IMAGE|TERN_AGENT_NETWORK_MODE|TERN_LOCAL_AGENT_SERVER)$/) print
      }' "$ENV_FILE.bak")

    if [ -n "$_kept" ]; then
      {
        printf '\n# ── Reporté depuis la configuration précédente ──────────────────────────────\n'
        printf '%s\n' "$_kept"
      } >> "$ENV_FILE"
    fi
  fi
)

note "$ENV_FILE écrit (permissions 600)"
[ -z "${_secret_new:-}" ] || note "APP_SECRET généré localement, jamais transmis"

# --- le stockage --------------------------------------------------------------
# Où vit réellement la base.
#
# `timescaledb-ha` place `PGDATA` dans `/home/postgres/pgdata`, pas dans
# `/var/lib/postgresql/data` — ce dernier appartient à l'image `postgres`
# ordinaire. Une version antérieure de ce fichier montait le volume sur le
# chemin conventionnel : l'image n'y écrivait jamais, donc le cluster vivait
# dans la couche inscriptible du conteneur et chaque `docker compose up -d` qui
# recréait celui-ci emportait la base.
#
# Deux choses à faire, dans cet ordre : refuser de démarrer si une installation
# existante est encore dans cet état — remonter le volume lui présenterait une
# base vide sans rien dire — puis vérifier après coup que le cluster est bien
# sur le volume.

DB_CONTAINER="tern-prod-db-1"
LEGACY_MOUNT="/var/lib/postgresql/data"

if docker container inspect "$DB_CONTAINER" >/dev/null 2>&1; then
  _mounted=$(docker container inspect -f \
    '{{range .Mounts}}{{println .Destination}}{{end}}' "$DB_CONTAINER" 2>/dev/null || true)

  case "$_mounted" in
    *"$LEGACY_MOUNT"*)
      printf '\n%s==> Cette installation stocke sa base dans le conteneur, pas sur un volume.%s\n' "$ERR" "$R" >&2
      printf '    Le montage visait %s, un chemin que cette image n%s\n' "$LEGACY_MOUNT" "'utilise pas." >&2
      printf '    La corriger maintenant présenterait une base vide à la place de la vôtre.\n\n' >&2
      printf '    Sauvegardez d%s\n' "'abord, puis relancez ce script :" >&2
      printf '      docker exec %s pg_dump -U tern -Fc tern > tern-avant-migration.dump\n' "$DB_CONTAINER" >&2
      printf '      docker compose -f %s down\n' "$COMPOSE_FILE" >&2
      printf '      ./scripts/setup.sh\n\n' >&2
      printf '    Puis restaurez le dump dans la base neuve. Voir docs/operations.md.\n' >&2
      exit 1
      ;;
  esac
fi

# --- démarrage ---------------------------------------------------------------
# Deux chemins : tirer une image publiée, ou construire depuis ce dépôt. Le
# premier est celui d'une installation ; le second celui d'un développeur ou
# d'une version modifiée.
#
# Sans Dockerfile sous la main, il n'y a rien à construire : le script tourne
# seul, hors d'un checkout. Choisir l'image publiée ici évite d'envoyer Docker
# échouer sur un contexte de construction vide, trois écrans plus bas.
if [ -z "${TERN_IMAGE:-}" ] && [ ! -f Dockerfile ]; then
  TERN_IMAGE=$PUBLISHED_IMAGE
  note "Pas de sources ici — image publiée : $TERN_IMAGE"
fi

if [ -n "${TERN_IMAGE:-}" ]; then
  say "Récupération de $TERN_IMAGE et démarrage"
  # Écrit dans .env pour que les `docker compose` suivants visent la même image
  # que ce démarrage-ci.
  printf '\nTERN_IMAGE=%s\n' "$TERN_IMAGE" >> "$ENV_FILE"
  if ! spin "Récupération de l'image (quelques minutes)" \
      docker compose -f "$COMPOSE_FILE" pull app; then
    die "Image introuvable : $TERN_IMAGE"
  fi
  _up='up -d'
else
  say "Construction de l'image et démarrage"
  note "La première construction prend quelques minutes."
  note "Pour utiliser une image publiée : TERN_IMAGE=… ./scripts/setup.sh"
  _up='up -d --build'
fi

# On démarre, puis on attend nous-mêmes que l'API réponde.
#
# `--wait` faisait ça, et le faisait mieux : il rendait la main sur le
# healthcheck, donc après les migrations et la création de la page. Il a été
# retiré parce qu'il rend l'installation dépendante de la version de Compose.
#
# Le service `agent` n'a délibérément pas de healthcheck — le sien curlerait
# l'API et rapporterait la santé de l'API comme étant la sienne, ce qui est pire
# que pas de contrôle du tout. Docker Compose 29 refuse d'attendre un conteneur
# dans cet état : « container tern-prod-agent-1 has no healthcheck configured »,
# code de sortie non nul, et le script annonçait « Le démarrage a échoué » sur
# une installation parfaitement réussie. Compose 5.4 ne bronchait pas, ce qui est
# la pire forme du défaut : invisible chez qui l'écrit, systématique chez qui
# l'installe.
#
# Attendre l'API directement dit la même chose sans rien supposer de Compose :
# `/health` ne répond qu'une fois les migrations passées et la page créée.
# shellcheck disable=SC2086
if ! docker compose -f "$COMPOSE_FILE" $_up; then
  printf '\n%s==> Le démarrage a échoué.%s\n' "$ERR" "$R" >&2
  printf '    docker compose -f %s logs app\n' "$COMPOSE_FILE" >&2
  exit 1
fi

say "Attente de l'API"
_ready=''
# Deux minutes : la première migration d'une base vide est le cas long, et un
# disque lent la rallonge encore.
_tries=60
while [ "$_tries" -gt 0 ]; do
  if docker compose -f "$COMPOSE_FILE" exec -T app \
      node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3011)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
    _ready=1
    break
  fi
  _tries=$((_tries - 1))
  sleep 2
done

if [ -z "$_ready" ]; then
  printf '\n%s==> L%s\n' "$ERR" "'API n'a pas répondu dans le délai.$R" >&2
  printf '    Les conteneurs tournent peut-être encore leurs migrations :\n' >&2
  printf '    docker compose -f %s logs app\n' "$COMPOSE_FILE" >&2
  exit 1
fi

# Le montage est correct dans le fichier, mais c'est le conteneur qui tourne qui
# compte. Vérifié plutôt que supposé : une base qui n'est pas sur un volume
# survit à tout jusqu'au jour où elle ne survit pas, et ce jour-là est un
# `docker compose up -d` de routine.
if ! docker compose -f "$COMPOSE_FILE" exec -T db \
  sh -lc 'test -s "$PGDATA/PG_VERSION" && grep -q " /home/postgres/pgdata " /proc/mounts' 2>/dev/null; then
  printf '\n%s==> La base ne semble pas reposer sur un volume.%s\n' "$ERR" "$R" >&2
  printf '    Elle fonctionne, mais un `docker compose up -d` la détruirait.\n' >&2
  printf '    Vérifiez le bloc `volumes:` du service `db` dans %s.\n' "$COMPOSE_FILE" >&2
  exit 1
fi
note "Base sur le volume db-data — elle survit à une recréation du conteneur."

# L'adresse en évidence, et l'avertissement avec elle.
#
# Tant que le compte administrateur n'existe pas, cette page le crée pour qui
# l'ouvre. C'est une fenêtre, elle se ferme à la première création, et c'est la
# seule chose de cet écran qui ne peut pas attendre demain — d'où le cadre.
panel "✓ Prêt." \
      "" \
      "Administration   $PUBLIC_BASE_URL/app" \
      "" \
      "Ouvrez-la maintenant : vous y nommerez la page, créerez le" \
      "compte administrateur et réglerez le serveur d'envoi." \
      "" \
      "Tant que ce compte n'existe pas, la première personne à ouvrir" \
      "cette adresse en devient l'administrateur."

note "Arrêt      : docker compose -f $COMPOSE_FILE down"
note "Journaux   : docker compose -f $COMPOSE_FILE logs -f app"
printf '\n'

#!/bin/sh
#
# TERN — amorçage de l'installateur.
#
#   curl -fsSL -o setup.sh https://raw.githubusercontent.com/…/scripts/setup.sh
#   sh setup.sh
#
# Ce fichier ne pose rien. Il récupère `tern-setup`, le binaire qui installe
# réellement, vérifie son empreinte, et lui passe la main.
#
# ── Pourquoi un binaire, et pourquoi cet amorçage reste court ────────────────
#
# L'installation tenait auparavant dans mille lignes de shell. Elle posait des
# questions, installait Docker, démarrait la pile — et affichait tout cela comme
# un script des années 90, ce qui n'a aucune importance jusqu'au moment où c'est
# la première chose que quelqu'un voit du produit. `tern-setup` est écrit en
# Rust et dessine une liste d'étapes qui se remplit, en anglais ou en français
# selon la langue du système, sans jamais faire défiler la sortie des commandes
# qu'il lance — celle-ci va dans un journal, complet et relisible.
#
# Le compromis est réel et mérite d'être nommé plutôt que passé sous silence :
# un binaire ne se lit pas avant d'être exécuté, alors qu'un script, si. C'est
# exactement l'argument qui a toujours fait refuser `curl … get.docker.com | sh`
# dans ce projet. Trois choses le rattrapent, et aucune n'est facultative :
#
#   - Ce fichier reste court et lisible. C'est le seul que vous exécutez sans
#     l'avoir relu, et il tient sur un écran.
#   - L'empreinte SHA-256 est vérifiée contre le `SHA256SUMS` publié par la même
#     release. Sans outil de somme sur la machine, on s'arrête plutôt que de
#     faire semblant de vérifier.
#   - Les sources sont dans ce dépôt, sous `clients/installer/`, et la CI qui
#     produit ces binaires est dans `.github/workflows/ci.yml`.
#
# POSIX sh : ce script tourne avant tout le reste, y compris sur un système où
# personne n'a encore rien installé.

set -eu

REPO="lelabnet-creator/ternproject"

# Le canal par défaut. `TERN_SETUP_VERSION=v1.4.2` épingle une version précise —
# pour reproduire une installation, ou en refaire vingt identiques.
VERSION="${TERN_SETUP_VERSION:-latest}"

B=''
DIM=''
R=''
ERR=''
if [ -t 1 ]; then
  B=$(printf '\033[1m')
  DIM=$(printf '\033[2m')
  R=$(printf '\033[0m')
  ERR=$(printf '\033[31m')
fi

say() { printf '%s==>%s %s\n' "$B" "$R" "$1"; }
note() { printf '    %s%s%s\n' "$DIM" "$1" "$R"; }
die() { printf '%s==> %s%s\n' "$ERR" "$1" "$R" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl est requis pour récupérer l'installateur."

# La cible, nommée comme Rust la nomme.
#
# Linux seulement, et musl plutôt que glibc : un seul binaire tourne alors sur
# n'importe quelle distribution, y compris Alpine, alors qu'une compilation
# glibc échoue sur l'image minimale où personne ne veut déboguer.
#
# macOS n'est pas publié, et ce n'est pas un oubli. Le moteur y arrive avec
# Docker Desktop, que cet installateur ne sait pas poser et se contenterait de
# réclamer : un binaire qui commence par dire d'aller installer autre chose ne
# vaut pas d'être téléchargé. Avec Docker Desktop déjà là, le programme fait
# très bien le reste — d'où le renvoi aux sources plutôt qu'un simple refus.
#
# Proposer un binaire qui ne s'exécutera pas est pire que dire qu'il n'y en a
# pas : l'un envoie lire une page d'installation, l'autre produit un
# « Exec format error » que personne ne sait interpréter.
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64 | Linux-amd64) TARGET=x86_64-unknown-linux-musl ;;
  Linux-aarch64 | Linux-arm64) TARGET=aarch64-unknown-linux-musl ;;
  Darwin-*)
    die "Pas d'installateur publié pour macOS.
    Installez Docker Desktop, puis construisez l'installateur depuis les
    sources : clonez le dépôt et lancez cargo build --release dans
    clients/installer."
    ;;
  *)
    die "Pas d'installateur publié pour $(uname -s) $(uname -m).
    Construisez-le : clonez le dépôt, puis cargo build --release dans clients/installer."
    ;;
esac

BIN="tern-setup-$TARGET"
if [ "$VERSION" = latest ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/$VERSION"
fi

DIR=$(mktemp -d) || die "Impossible de créer un répertoire temporaire."

# Le binaire est jetable : son travail est fini quand il rend la main, et le
# laisser dans le répertoire d'installation ne ferait que suggérer qu'il faut le
# garder. Le piège couvre aussi l'interruption au clavier, sans quoi un Ctrl-C
# pendant le téléchargement laisserait un répertoire derrière lui.
trap 'rm -rf "$DIR"' EXIT INT TERM

say "Récupération de l'installateur ($TARGET)"
curl -fsSL -o "$DIR/tern-setup" "$BASE/$BIN" \
  || die "Téléchargement impossible : $BASE/$BIN"

# L'empreinte, avant tout le reste.
#
# C'est ce qui sépare « récupérer un binaire publié » de « exécuter ce qui
# arrive ». Sans outil pour la calculer, on s'arrête : une vérification qu'on
# saute faute d'outil est une vérification qui n'existe pas.
if command -v sha256sum >/dev/null 2>&1; then
  SUM=$(sha256sum "$DIR/tern-setup" | cut -d' ' -f1)
elif command -v shasum >/dev/null 2>&1; then
  SUM=$(shasum -a 256 "$DIR/tern-setup" | cut -d' ' -f1)
else
  die "Ni sha256sum ni shasum : impossible de vérifier l'installateur."
fi

# `SHA256SUMS`, le nom que la CI publie déjà pour les binaires de l'agent — une
# seule liste pour toutes les architectures, vérifiable d'une commande.
curl -fsSL -o "$DIR/SHA256SUMS" "$BASE/SHA256SUMS" \
  || die "Empreintes introuvables : $BASE/SHA256SUMS"

grep -q "^$SUM  $BIN\$" "$DIR/SHA256SUMS" \
  || die "L'empreinte ne correspond pas à celle publiée. Rien n'a été exécuté."

note "empreinte vérifiée"
chmod +x "$DIR/tern-setup"

# `exec` : l'installateur prend la place de ce script au lieu d'en devenir
# l'enfant. Il hérite du terminal — dont il a besoin pour ses questions et pour
# redessiner sa liste d'étapes — et son code de sortie devient celui de la
# commande que la personne a tapée.
exec "$DIR/tern-setup" "$@"

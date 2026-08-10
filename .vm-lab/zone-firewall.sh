#!/bin/sh
#
# Couper la route vers TERN, pour un compte et un seul.
#
#   sudo sh zone-firewall.sh apply  <adresse-tern> [compte]
#   sudo sh zone-firewall.sh clear  <adresse-tern> [compte]
#   sudo sh zone-firewall.sh status
#
# Ce que ça sert à prouver : un agent dans une zone isolée n'atteint pas TERN,
# et passe pourtant par le relais. Sans une coupure réelle, la démonstration ne
# vaut rien — l'agent pourrait joindre le serveur directement et personne ne le
# verrait, puisque les points arriveraient quand même.
#
# ── Pourquoi un filtre par compte, et pas par interface ──────────────────────
#
# Le relais et l'agent de zone tournent sur la même machine ici. Une règle qui
# bloquerait l'adresse de TERN pour tout l'hôte couperait aussi le relais, qui
# est précisément ce dont la zone dépend : la démonstration se saborderait. Le
# module `owner` d'iptables filtre sur l'UID du processus émetteur, ce qui donne
# exactement la frontière voulue — `zone` n'a pas de route, `tern` en a une.
#
# REJECT et non DROP, délibérément. Un paquet jeté en silence fait attendre le
# client jusqu'au bout de son délai, et un agent qui met dix secondes à échouer
# ressemble à un réseau lent plutôt qu'à une machine sans route. Un refus est
# immédiat et se lit dans les journaux.
#
# POSIX sh : cette machine n'a rien d'autre de garanti.

set -eu

ACTION="${1:-}"
TERN="${2:-}"
USER_NAME="${3:-zone}"

usage() {
  echo "usage: $0 apply|clear <adresse-tern> [compte]" >&2
  echo "       $0 status" >&2
  exit 2
}

need_root() {
  [ "$(id -u)" = 0 ] || { echo "Ce script a besoin de root (sudo)." >&2; exit 1; }
}

case "$ACTION" in
  status)
    need_root
    echo "Règles OUTPUT portant un filtre owner :"
    iptables -S OUTPUT | grep -- "--uid-owner" || echo "  (aucune)"
    ;;

  apply)
    [ -n "$TERN" ] || usage
    need_root
    id "$USER_NAME" >/dev/null 2>&1 || {
      echo "Le compte $USER_NAME n'existe pas." >&2; exit 1; }

    # Idempotent : rejouer le script ne doit pas empiler des règles identiques,
    # sans quoi `clear` en laisserait derrière lui et l'isolement survivrait à
    # sa propre suppression — le pire des deux mondes.
    if iptables -C OUTPUT -d "$TERN" -m owner --uid-owner "$USER_NAME" -j REJECT 2>/dev/null; then
      echo "Déjà en place : $USER_NAME ne joint pas $TERN"
    else
      iptables -I OUTPUT 1 -d "$TERN" -m owner --uid-owner "$USER_NAME" -j REJECT
      echo "Posé : $USER_NAME ne joint plus $TERN"
    fi
    ;;

  clear)
    [ -n "$TERN" ] || usage
    need_root
    # Une boucle, parce qu'une seule suppression laisserait les doublons qu'une
    # version antérieure de ce script aurait pu créer.
    removed=0
    while iptables -C OUTPUT -d "$TERN" -m owner --uid-owner "$USER_NAME" -j REJECT 2>/dev/null; do
      iptables -D OUTPUT -d "$TERN" -m owner --uid-owner "$USER_NAME" -j REJECT
      removed=$((removed + 1))
    done
    echo "Retiré : $removed règle(s)"
    ;;

  *)
    usage
    ;;
esac

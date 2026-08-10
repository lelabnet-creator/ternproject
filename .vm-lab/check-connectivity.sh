#!/bin/sh
#
# Qui joint quoi, depuis cette machine.
#
#   sh check-connectivity.sh <adresse-tern> <adresse-relais> [compte-zone]
#
# Quatre questions, et la réponse attendue à chacune. Elles sont écrites ici
# plutôt que lues dans une sortie, parce qu'une trace de test qui se contente de
# montrer des succès ne dit pas lesquels étaient censés échouer — et dans une
# zone isolée, l'échec est le résultat qui compte.
#
#   relais -> TERN      doit passer   (le relais est là pour ça)
#   zone   -> TERN      doit ÉCHOUER  (sinon la zone n'est pas isolée)
#   zone   -> relais    doit passer   (sinon la zone ne mesure rien)
#   zone   -> Internet  informatif    (dit si la coupure est ciblée ou totale)
#
# Sort avec 0 si les trois premières sont conformes, 1 sinon. Le but est qu'un
# essai se conclue sur un code de sortie, et non sur une lecture attentive.

set -eu

TERN="${1:-}"
RELAY="${2:-}"
ZONE_USER="${3:-zone}"

[ -n "$TERN" ] && [ -n "$RELAY" ] || {
  echo "usage: $0 <adresse-tern> <adresse-relais> [compte-zone]" >&2
  exit 2
}

# Court, et sans redirection : ce qui est mesuré est l'atteignabilité, pas la
# patience de qui regarde. Deux secondes suffisent sur un réseau local, et un
# REJECT répond bien avant.
reach() {
  curl -fsS --max-time 2 -o /dev/null "$1" 2>/dev/null
}

as_zone() {
  # `sudo -n` : si le mot de passe est demandé, l'essai s'arrête au lieu
  # d'attendre une saisie que personne ne fera.
  sudo -n -u "$ZONE_USER" sh -c "$1" 2>/dev/null
}

line() {
  # Attendu et obtenu côte à côte, dans cet ordre : la question d'abord.
  printf '  %-24s attendu %-8s obtenu %-8s %s\n' "$1" "$2" "$3" "$4"
}

fail=0
verdict() {
  if [ "$2" = "$3" ]; then
    line "$1" "$2" "$3" "ok"
  else
    line "$1" "$2" "$3" "NON CONFORME"
    fail=1
  fi
}

echo "Connectivité, depuis $(hostname)"
echo

reach "http://$TERN/health" && a=joint || a=refusé
verdict "relais -> TERN" "joint" "$a"

as_zone "curl -fsS --max-time 2 -o /dev/null http://$TERN/health" && b=joint || b=refusé
verdict "zone -> TERN" "refusé" "$b"

as_zone "curl -fsS --max-time 2 -o /dev/null http://$RELAY/health" && c=joint || c=refusé
verdict "zone -> relais" "joint" "$c"

as_zone "curl -fsS --max-time 3 -o /dev/null https://example.com/" && d=joint || d=refusé
line "zone -> Internet" "-" "$d" "informatif"

echo
if [ "$fail" = 0 ]; then
  echo "Conforme : la zone passe par le relais, et seulement par lui."
else
  echo "NON CONFORME : voir les lignes ci-dessus." >&2
fi
exit "$fail"

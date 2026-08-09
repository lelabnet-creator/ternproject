# CONTEXT

## Current Task

Rien en cours. `v0.1.8` est taguée : l'admin dit qu'une image plus récente
existe, et sait l'appliquer via le service `updater` (profil, opt-in). Tout est
vert — typecheck, lint, format, 673 tests JS.

## Key Decisions

- La socket Docker reste hors du serveur. L'API écrit une demande dans le volume
  partagé ; le conteneur `updater` la lit, décide, et rend compte par fichier.
  C'est aussi la seule forme qui survit au remplacement du conteneur `app`.
- Un registre injoignable répond « on ne sait pas », jamais « à jour ». La
  réponse rassurante est celle qui fait cesser de croire l'écran.
- `updater.sh` est monté depuis l'hôte en lecture seule : ni dans l'image, ni
  dans le volume, sinon une app compromise réécrit ce qui tourne en root.

## Next Steps

- Déployer `v0.1.8` ailleurs qu'en local : il manque toujours l'accès registre
  et l'hôte.
- Réparer l'accès SSH en écriture (la clé authentifie `jacquesh82`, sans droit
  d'écrire). Les push passent par `gh` comme credential helper.
- Vérifier le sidecar `updater` contre un vrai Docker : il n'a été joué que
  contre un faux, en test.

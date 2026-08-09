# CONTEXT

## Current Task

Rien en cours. `v0.1.10` est taguée. Elle répare le bandeau de mise à jour, qui
ne pouvait s'allumer sur aucun déploiement depuis la 0.1.8, et publie la
référence OpenAPI. Vert — typecheck, lint, format, 728 tests JS, e2e 21/21.

## Key Decisions

- L'étage runtime du Dockerfile ne convertissait pas `ARG TERN_VERSION` en `ENV`.
  Le label OCI était juste, le serveur ne savait rien, et le pied de page —
  gravé par vite à la construction — faisait passer l'écran pour correct. Une
  garde CI interroge désormais l'image poussée avant de la laisser partir.
- L'OpenAPI est généré depuis les schémas Zod qui valident déjà les requêtes.
  Aucune route n'est annotée ; les groupes sont dérivés des chemins par un hook.
- La page publique porte le logo du client à la place du wordmark. TERN signe au
  centre de l'anneau de statut, sous le verdict et jamais à sa place.

## Next Steps

- Après publication de l'image : `docker compose pull && up -d` à la main sur
  l'instance. Le bandeau ne peut pas s'annoncer le correctif qui le répare.
- Le binaire `x86_64-pc-windows-msvc` échoue (exit 101) et bloque le job
  `Release` depuis la 0.1.8 : l'image GHCR part, la release GitHub non.
- `apps/web/public/bg.jpeg` est modifié dans l'arbre par quelqu'un d'autre.

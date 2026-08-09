# CONTEXT

## Current Task

Rien en cours. `v0.1.13` est taguée. Elle pose un relais depuis l'interface —
rôle au moment de l'appairage, installateur qui va jusqu'au service, cadence de
transmission réglable, liaisons dessinées dans le rond — et elle est la première
image à livrer un agent qui connaît les huit genres et qui ne s'emballe pas.
Vert : 763 tests JS, 51 côté agent.

## Key Decisions

- Deux binaires, pas un mode : `tern-agent` et `tern-proxy` ne partagent ni les
  verbes ni les dépendances, et l'agent n'a pas à embarquer un serveur HTTP.
- TERN n'émet pas de PIN de zone. Le relais émet les siens, sur sa machine —
  c'est ce qui fait qu'un hôte compromis dans la zone ne détient rien d'amont.
  L'interface l'écrit au lieu de le masquer.
- Une échéance que rien ne déplace ne doit pas entrer dans le calcul d'un
  réveil. Sous `--no-refresh`, `next_refresh` figé faisait tourner l'agent à
  plein cœur passé cinq minutes : 233 Mo de journal en 104 s.

## Next Steps

- Le septième point de la recette VM reste à rejouer : les huit genres derrière
  un relais, avec les binaires de cette version. `deploy-tests/ubuntu/proxy-0.1.12/`.
- Le service worker sert un bundle périmé après une mise à jour — vu à la main,
  jamais corrigé.
- Aucun test serveur pour HTTP, TCP, DNS ; `ping` couvert seulement par son
  checksum.

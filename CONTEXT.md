# CONTEXT

## Current Task

Campagne console sur trois distributions — Ubuntu 24.04, Rocky 9.8, Arch — qui
passent toutes l'installation, l'affichage et le redémarrage. Cinq commits
poussés sur `chore/console-demo-and-incidents` : installateur, image de
démonstration, bloc incidents plaçable, backlog, traces.

## Key Decisions

- Sur un terminal à jeu restreint (`TERM=linux`), l'état d'une étape voyage par
  la couleur et la graisse ; le symbole ASCII n'est qu'un renfort.
- L'image de démonstration porte sa base : la lecture seule tient au tenant, au
  système de fichiers et au redémarrage, et `docker restart` est la remise à zéro.
- Le bloc incidents est plaçable mais jamais supprimable : sans bloc nommé, ils
  reviennent au-dessus de la disposition.

## Next Steps

- Finir WebSocket et Docker : trois déclarations de genres bloquent une
  fonctionnalité écrite à 80 %. Détail dans BACKLOG.md, section « À reprendre ».
- Déployer la démonstration ; il manque l'accès registre et l'hôte.
- Intégrer la branche, et réparer l'accès SSH en écriture (clé `jacquesh82`).

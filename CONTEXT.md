# CONTEXT

## Current Task

Rien en cours. Les sondes WebSocket et Docker sont finies et intégrées : l'API
crée désormais ces contrôles, et `main` (`b89b597`) est poussée, avec la branche
console fusionnée au passage. Tout est vert — typecheck, lint, format, 605 tests
JS, clippy `-D warnings`, 40 tests Rust.

## Key Decisions

- La route `controls` importe `CONTROL_KINDS` au lieu de réécrire la liste : la
  panne venait d'avoir épelé les mêmes six genres à trois endroits.
- `docker` est accepté à la création et refusé au moment de sonder. Un fichier
  dit quoi surveiller, pas qui surveille ; le serveur n'a pas de socket Docker.
- Les décisions de conception sont tenues par des tests, pas par des
  commentaires : une sonde WebSocket refuse un `send`, parce qu'elle n'envoie rien.

## Next Steps

- Supprimer les 5 branches distantes fusionnées ; les pointes sont dans
  BACKLOG.md. Bloqué ici par les permissions, à lancer à la main.
- Réparer l'accès SSH en écriture (clé `jacquesh82`) : les push passent par une
  URL HTTPS écrite à la main. C'est ce qui bloque tout le reste.
- Déployer la démonstration ; il manque l'accès registre et l'hôte.

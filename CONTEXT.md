# CONTEXT

## Current Task

Rien en cours. `v0.1.25` : la cause des 401 derrière un relais est trouvée et
corrigée — l'appairage émettait une clé et la jetait quand un `agent.toml`
existait déjà.

## Key Decisions

- **L'appairage écrit la clé et laisse le reste.** Refuser le fichier faisait
  réussir l'appairage, brûler un PIN à usage unique, émettre une clé et la
  jeter ; l'agent présentait l'ancienne et prenait 401 pour toujours. Une clé
  est ce que l'appairage produit ; les sondes appartiennent à l'exploitant.
  `--force` remplace tout, en nommant chaque sonde retirée.
- **Un chemin de config se tape sans drapeau** sur `run`, `doctor` et `status`.
  « unexpected argument found » nommait ce qui est faux, pas ce qui serait juste.
- **`STARTED` est décidé où chaque superviseur le prend**, pas déduit à la fin :
  autrement l'installeur revendique un démarrage au boot que la branche
  au-dessus vient d'échouer à créer.
- Formater après la dernière édition, régénérer le rendu des docs, inspecter les
  hunks avant d'indexer un fichier partagé.

## Next Steps

- **Bouton de reset du mot de passe de l'UI dans la console** : non fait. Demande
  que le serveur dépose une instruction reprise par l'agent à son prochain
  `jobs` — un credential qui voyage serveur→agent, à concevoir.
- Reprendre les textes de `docs/` pour le processus d'ajout d'un agent de zone.
- Non exercés : l'annonce de `--force` (demande un vrai serveur), les onglets du
  panneau d'appairage, le rendu de la page locale de l'agent.

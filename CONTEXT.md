# CONTEXT

## Current Task

Rien en cours. `v0.1.24` : l'agent sert une page sur lui-même, le relais envoie
enfin un heartbeat, et le PIN de zone a sa propre page dans l'admin.

## Key Decisions

- **Le relais n'envoyait aucun heartbeat.** Il paraissait vivant par effet de
  bord de `/agent/jobs`, qui rafraîchit `last_seen_at`. Vrai tant que
  `refresh_s` est court, faux dès qu'il ne l'est plus. Les trois rôles disent
  désormais le même verbe.
- **La page locale est éteinte par défaut.** Un agent de supervision qui ouvre
  un port par défaut, c'est un port sur chaque machine d'un parc, décidé par
  nous. `tern-agent ui` l'allume et imprime le mot de passe une fois.
- Mot de passe **généré, jamais choisi**, SHA-256 salé, comparaison à temps
  constant. Pas d'argon2 : une dépendance de hachage dans un binaire construit
  pour la taille, pour garder une page en boucle locale.
- Formater **après** la dernière édition, régénérer le rendu des docs, et
  inspecter les hunks avant d'indexer un fichier partagé — les trois causes des
  incidents de cette série.

## Next Steps

- **Bouton de reset du mot de passe de l'UI dans la console** : non fait. Demande
  que le serveur dépose une instruction reprise par l'agent à son prochain
  `jobs` — un credential qui voyage serveur→agent, à concevoir.
- Reprendre les textes de `docs/` pour le nouveau processus d'ajout d'un agent
  de zone.
- Non testés : les onglets du panneau d'appairage (rendu statique contre
  mutation résolue) et le rendu de la page de l'agent.

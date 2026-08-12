# CONTEXT

## Current Task

Release v0.2.1 : le battement d'agent est retenu ouvert (long-poll), et un
`flock` empêche deux copies de se disputer une même config.

## Key Decisions

- **Un POST retenu, pas un WebSocket** : c'est l'agent qui ouvre la connexion,
  et c'est cette propriété qui le rend joignable derrière pare-feu et relais.
- **`holding` est dit, jamais déduit** : deviner d'après le temps de réponse
  était faux quand un relais relâche ses battements en s'arrêtant (57 s perdues).
- **Le verrou refuse, ne tue pas** : il nomme le pid et propose le `kill`.

## Next Steps

- Mettre à jour les agents 0.1.0 de Jacques (protocole v1 les refuse).
- Supprimer l'entrée fantôme de zone restée à « never reported ».
- Surfacer `protocol-mismatch` comme motif sur la ligne de flotte.

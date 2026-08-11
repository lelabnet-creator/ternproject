# CONTEXT

## Current Task

Rien en cours. `v0.1.28` : la page locale de chaque rôle, et trois corrections
trouvées en faisant tourner de vraies machines.

## Key Decisions

- **La machine dit où joindre sa page**, le serveur ne devine plus. `pairedIp`
  est l'adresse *source vue par le serveur* — la passerelle du bridge quand TERN
  est en conteneur. L'agent consulte sa table de routage (`outbound_address`) et
  annonce l'adresse au battement ; rien quand la page est éteinte ou sur
  loopback, ce qui supprime le lien de lui-même. Écrite **hors** de la limite de
  fréquence de `touchAgent`, qui l'avalait.
- **La page demande le mot de passe elle-même** (session en mémoire, cookie
  `HttpOnly`/`SameSite=Strict`, verrou après 5 échecs) au lieu de Basic auth.
  `tern-proxy` a désormais la même, sur un écouteur **séparé** du port de zone.
- **Supprimer un relais n'abandonne plus sa zone** : clé étrangère `set null`
  ajoutée (elle était documentée mais absente), et la confirmation nomme et
  emporte les agents derrière.
- **Un PIN consommé est détecté** et remplacé automatiquement dans la console.

## Next Steps

- Cadence de refresh 300 s : le premier battement d'un relais arrive tard.
- Logs du relais silencieux sur l'activité périodique réussie.
- Reset du mot de passe de la page depuis la console (canal serveur→agent).

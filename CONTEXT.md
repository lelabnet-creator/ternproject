# CONTEXT

## Current Task

Release v0.2.2 : la page locale d'un agent s'ouvre enfin quand on le demande,
et un agent en retard se met à jour depuis la console.

## Key Decisions

- **`ui::reconcile` est le seul chemin** : démarrage et `ui-on` partagent la
  même fonction, sinon l'instruction écrit la config et n'ouvre aucun port.
- **La machine se met à jour elle-même** : somme SHA-256, puis `--version` sur
  le binaire téléchargé, puis « est-il plus récent » — et alors seulement le
  renommage. Aucun des trois échecs ne touche l'agent qui marchait.
- **Le tag vient après la collecte** : l'image d'une release construite avant
  que la CI ait rafraîchi `clients/agent/bin` embarque les binaires précédents.

## Next Steps

- Essayer le bouton d'upgrade de bout en bout sur un vrai agent.
- Supprimer l'entrée fantôme de zone restée à « never reported ».
- Surfacer `protocol-mismatch` comme motif sur la ligne de flotte.

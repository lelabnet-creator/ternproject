# CONTEXT

## Current Task

Rien en cours. `v0.1.29` : se ré-appairer ne crée plus de ligne jumelle dans la
flotte.

## Key Decisions

- **L'agent porte un identifiant d'installation**, engendré au premier
  appairage et gardé dans sa config. Se ré-appairer remplace sa ligne, réveille
  une ligne révoquée, et tue la clé précédente — après avoir pointé la ligne sur
  la neuve. Fondé sur le fichier de config, **jamais sur l'hôte** : un nom
  d'hôte ou un machine-id fusionnerait deux VM clonées d'une même image, ce qui
  ferait disparaître en silence la supervision de l'une.
- Un agent trop ancien n'envoie pas d'identifiant et garde une ligne à lui —
  refuser sa requête mettrait une flotte hors service.
- La version stockée à l'appairage perd le préfixe `proxy/` : le rôle a sa
  propre colonne.

## Next Steps

- Les doublons déjà en base ne se résorbent pas seuls (créés sans identifiant) —
  à supprimer depuis la console.
- L'installeur sans `--pin` (chemin de mise à jour) affiche « Next: … --pin » et
  ne redémarre pas le service : message écrit pour une installation inachevée.
- Reset du mot de passe de la page depuis la console (canal serveur→agent).

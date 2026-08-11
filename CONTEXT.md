# CONTEXT

## Current Task

Rien en cours. `v0.1.27` : les boutons Copy ne fonctionnaient pas hors contexte
sécurisé, plus deux retouches de l'écran Agents.

## Key Decisions

- **`navigator.clipboard` n'existe qu'en contexte sécurisé** (HTTPS ou
  `localhost`) — donc pas sur `http://<ip-lan>:port`, la façon ordinaire
  d'atteindre une instance auto-hébergée. L'appel non gardé levait un TypeError
  avalé par React : les 13 boutons Copy de l'admin ne faisaient rien, sans
  message. Repli `execCommand('copy')` dans `apps/web/src/lib/clipboard.ts`,
  appelé sans `await` préalable pour rester dans le geste utilisateur, et un
  aveu visible quand même le repli refuse. Prouvé de bout en bout (presse-papier
  système lu depuis l'hôte). Le endpoint `/badge/*.svg` n'avait rien de cassé.
- **Un menu `⋯` par agent** : adresses (avec Copy), lien vers la page locale de
  l'agent, Rename, Revoke. Le lien n'apparaît que si le serveur connaît une
  adresse — ce qui exclut d'office l'agent de zone isolé.
- **Commandes d'installation en onglets** (`Tabs` partagé), la non choisie reste
  en `hidden` pour rester trouvable ; le choix est retenu en localStorage.

## Next Steps

- Cadence de refresh 300 s : réactivité lente (nouvelle assignation, apparition
  d'un agent de zone).
- Logs du relais silencieux sur l'activité périodique réussie.
- Reset du mot de passe de l'UI de l'agent depuis la console (canal
  serveur→agent à concevoir).

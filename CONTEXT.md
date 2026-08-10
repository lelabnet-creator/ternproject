# CONTEXT

## Current Task

Rien en cours. `v0.1.19` est taguée. Elle porte la **migration 0019**
(`agents.zone_address`) : un relais déclare l'adresse sur laquelle il sert sa
zone, au lieu que l'admin la devine. Vert : 790 tests JS, 56 côté agent, 75 côté
installateur.

## Key Decisions

- `pairedIp` ne peut pas répondre « où joindre ce relais » : c'est l'adresse
  d'où une connexion est arrivée **vue par le serveur**, donc la passerelle d'un
  pont Docker quand TERN est en conteneur. Seul le relais sait où il se lie.
  Repli conservé et étiqueté « guessed » pour un relais d'avant cette version.
- Un amont injoignable et un code refusé sont deux faits distincts : 503 avec
  une phrase actionnable dans le premier cas. Confondus, ils envoyaient chercher
  du côté du PIN pendant qu'une instance redémarrait.
- La liste d'étapes garde le terminal par le descripteur 3 ; tout le reste est
  retenu puis restitué, échec compris.

## Next Steps

- La recette VM avec isolement réel reste à jouer — scripts dans `.vm-lab/`.
- Le service worker sert un bundle périmé après une mise à jour.
- Aucun test serveur pour HTTP, TCP, DNS ; `ping` couvert par son seul checksum.

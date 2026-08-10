# CONTEXT

## Current Task

Rien en cours. `v0.1.14` est taguée. Elle répond à « comment une machine sans
route vers TERN envoie-t-elle ses mesures à travers une autre » : le relais sert
l'installateur et les binaires de sa zone, `install.sh` gagne `--server`,
`tern-proxy pin` imprime la une-ligne, et la carte du relais montre les machines
derrière lui. Vert : 772 tests JS, 54 côté agent.

## Key Decisions

- L'autorisation du HTTP en clair est décidée **par le script, à l'exécution**.
  Gravée à la génération, elle répondait pour l'adresse de TERN alors que
  `--server` vise celle d'un relais que l'instance ne connaît pas.
- Le relais relaie l'installation sans cache et sans réécriture : c'est
  `--server` qui ramène l'installation vers lui. La seule route qui prend un nom
  dans la requête est gardée par une liste de formes.
- Un agent de zone n'apparaît qu'une fois, dans la carte de son relais — mais un
  orphelin reste au premier niveau : un relais absent ne doit pas faire
  disparaître une machine de l'écran qui dit lesquelles existent.

## Next Steps

- La recette VM avec un **isolement réel** (pare-feu bloquant TERN depuis la
  machine de zone) reste à jouer ; elle refermerait le septième point de
  `deploy-tests/ubuntu/proxy-0.1.12/`.
- Le service worker sert un bundle périmé après une mise à jour.
- Aucun test serveur pour HTTP, TCP, DNS ; `ping` couvert par son seul checksum.

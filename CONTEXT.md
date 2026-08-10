# CONTEXT

## Current Task

Rien en cours. `v0.1.20` est taguée : l'adresse et le port d'un relais se
choisissent au lieu d'être devinés. Vert : 796 tests JS, 56 côté agent, 75 côté
installateur. Migration `0020` (`agents.zone_addresses`).

## Key Decisions

- Le relais déclare **toutes** ses adresses joignables ; l'admin les offre en
  liste. `pairedIp` — l'adresse vue par le serveur, donc une passerelle Docker
  quand TERN est en conteneur — n'est plus qu'un dernier recours étiqueté.
- Port de zone par défaut à **38787** : 8787 est dans la plage où les choses se
  choisissent un port seules, et une collision de défaut échoue au bout d'une
  installation. Les relais déjà posés gardent le leur.
- Ne jamais indexer par répertoire. Un `git add apps/web/src` a emporté une
  refonte en cours dans un commit poussé sur `main`, rouge en CI ; annulé,
  travail préservé sur `wip/tenant-style`, arbre restitué à l'identique.

## Next Steps

- La refonte `TenantStyle` / `custom-style` est en cours dans l'arbre de
  travail, non commitée — 25 fichiers.
- La recette VM avec isolement réel reste à jouer (scripts dans `.vm-lab/`).
- Le service worker sert un bundle périmé après une mise à jour.

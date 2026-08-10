# CONTEXT

## Current Task

Rien en cours. `v0.1.15` est taguée. Elle apporte `sh setup.sh --upgrade-only`
et `--check` : redéployer l'image sur la configuration en place, ou savoir si une
plus récente existe — sans question, donc par ssh et depuis cron. Vert : 772
tests JS, 75 côté installateur, 54 côté agent.

## Key Decisions

- `setup.sh` passait déjà `"$@"` depuis toujours ; c'est `tern-setup` qui ne
  lisait aucun argument et les ignorait en silence. Il refuse désormais une
  option inconnue plutôt que de dérouler une installation complète.
- Les versions sont lues sur l'image, par le label OCI et `docker inspect
  --format` : ce binaire n'a ni client HTTP ni parseur JSON, délibérément. La
  version en service vient du **conteneur**, pas de la référence.
- `--check` interroge `:latest` et non la référence configurée — épinglée, une
  instance se comparerait à elle-même et se dirait à jour pour toujours.
  `--upgrade-only` respecte l'épinglage, et le dit.

## Next Steps

- La recette VM avec un **isolement réel** (pare-feu bloquant TERN depuis la
  machine de zone) reste à jouer ; elle refermerait le septième point de
  `deploy-tests/ubuntu/proxy-0.1.12/`.
- Le service worker sert un bundle périmé après une mise à jour.
- Aucun test serveur pour HTTP, TCP, DNS ; `ping` couvert par son seul checksum.

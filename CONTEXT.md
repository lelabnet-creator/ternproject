# CONTEXT

## Current Task

Rien en cours. `v0.1.16` est taguée. Deux corrections tirées de l'usage : un
relais s'installe désormais sur une adresse que sa zone peut joindre, et le mode
`custom` d'une page part d'un exemple au lieu de trois champs vides. Vert : 776
tests JS, 56 côté agent, 75 côté installateur.

## Key Decisions

- `listen` d'un `proxy.toml` neuf porte l'adresse de l'interface qui parle déjà
  à TERN, lue dans la table de routage. `--interface` en désigne une autre.
  Loopback ne servait personne ; `0.0.0.0` n'aurait rien dit à un lecteur.
- Le document d'exemple vit dans `@tern/shared/custom-document`, d'où la démo
  **et** l'éditeur le tirent. Un exemple qui diverge de la démo serait pire que
  pas d'exemple : la démo est où l'on regarde d'abord.
- Le brouillon n'est pré-rempli qu'une fois, gardé par un `ref` : qui vide les
  trois champs délibérément ne doit pas les voir se réécrire.

## Next Steps

- La recette VM avec un **isolement réel** reste à jouer. Les deux scripts sont
  écrits (`.vm-lab/zone-firewall.sh`, `check-connectivity.sh`) et une mesure
  d'avant-coupure est prise ; il manque l'appairage du relais.
- Le service worker sert un bundle périmé après une mise à jour.
- Aucun test serveur pour HTTP, TCP, DNS ; `ping` couvert par son seul checksum.

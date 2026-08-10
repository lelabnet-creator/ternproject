# CONTEXT

## Current Task

Rien en cours. `v0.1.18` est taguée : trois correctifs sortis d'un déploiement
réel sur une machine isolée. La liste d'étapes de l'installateur n'écrase plus
ce que les étapes disent, les binaires impriment leur chemin absolu, et le
relais se choisit dans une liste. Vert : 788 tests JS, 56 côté agent, 75 côté
installateur.

## Key Decisions

- La liste garde le terminal par le descripteur 3 ; tout le reste est retenu et
  restitué quand elle s'arrête, échec compris. Un redessin par-dessus la sortie
  d'une étape a fait disparaître la ligne qui disait où le binaire avait
  atterri — sur le seul écran qui en avait besoin.
- Les binaires impriment `current_exe`, pas leur nom : l'installateur les pose
  dans `~/.local/bin`, absent du PATH sur un serveur.
- Le relais se choisit par son nom, son adresse reste tapable : le nom est su,
  l'adresse est devinée depuis l'endroit où il s'est appairé.

## Next Steps

- La recette VM avec isolement réel reste à jouer — scripts posés dans
  `.vm-lab/`, mesure d'avant-coupure prise.
- Le service worker sert un bundle périmé après une mise à jour.
- Aucun test serveur pour HTTP, TCP, DNS ; `ping` couvert par son seul checksum.

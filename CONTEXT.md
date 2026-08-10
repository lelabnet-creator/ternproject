# CONTEXT

## Current Task

Rien en cours. `v0.1.23` : la page publique se feuillette sur mobile, le PIN de
zone dure cinq minutes avec son compte à rebours, et l'installeur du relais
n'imprime plus une commande qui n'en est pas une.

## Key Decisions

- **Deux arrangements rendus, pas un restylé.** `order` en CSS sépare ce que
  l'œil voit de ce que le clavier parcourt ; `useCompact` rend deux DOM pour que
  l'ordre visuel et l'ordre de tabulation restent la même chose.
- **Feuilleter ne doit jamais masquer une panne.** Les points sont de vrais
  contrôles, celui d'un volet en difficulté garde sa couleur et respire, et le
  filtre « only what is not working » n'est jamais mémorisé — une page filtrée
  ressemble à une page saine.
- **`eslint-plugin-react-hooks` était absent.** Ajouté et prouvé en
  réintroduisant le bug qu'il devait attraper. Une règle non vérifiée est une
  case cochée, pas un garde-fou.
- Formater **après** la dernière édition, et régénérer le rendu des docs : les
  deux causes des deux CI rouges de la 0.1.21.

## Next Steps

- Le panneau d'appairage de zone en **deux onglets** (PIN + compte à rebours,
  puis le contenu actuel) : non fait.
- Reprendre les textes de `docs/` et des écrans d'admin pour décrire le nouveau
  processus d'ajout d'un agent de zone.
- Rien du travail mobile n'a été vu à 390 px — anneau, cadre ASCII, coupe à deux
  lignes du bandeau, hauteur des volets.

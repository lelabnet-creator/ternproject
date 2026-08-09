# CONTEXT

## Current Task

Rien en cours. `v0.1.9` est préparée : l'import YAML des contrôles est
atteignable depuis l'admin, la suppression d'un dossier propose d'emporter ses
contrôles, et un bac à sable de développement permet d'exercer les écritures sur
la démo. Vert — typecheck, lint, format, 726 tests JS, e2e 21/21.

## Key Decisions

- Le format d'import est publié comme document : JSON Schema écrit en YAML,
  dialecte ASDF, généré depuis le même Zod que l'endpoint valide. Une seconde
  description du format serait une description qui diverge.
- Supprimer un dossier laisse ses contrôles par défaut, et propose l'autre acte
  par un bouton distinct. Une case à cocher qui transforme l'un en l'autre est le
  clic dont personne ne se souvient.
- Le bac à sable de la démo est une surcouche localStorage posée à la seule
  couture par où passent toutes les requêtes admin, sous `import.meta.env.DEV`.
  Vérifié absent du bundle de production.

## Next Steps

- Pousser `main` et l'étiquette `v0.1.9` : le `git push` est bloqué par le
  classifieur de permissions de la session, pas par le dépôt. `origin` est
  désormais en HTTPS — la clé SSH authentifie un compte sans droit d'écrire.
- Déployer ailleurs qu'en local : il manque toujours l'accès registre et l'hôte.
- Vérifier le sidecar `updater` contre un vrai Docker : il n'a été joué que
  contre un faux, en test.

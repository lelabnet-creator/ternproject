# Backlog

Le sujet précédent — **validation de bout en bout sur trois VM réelles** — est
terminé. Le bilan complet, les preuves et les hypothèses sont dans
`deploy-tests/e2e-2026-08-11/RESTITUTION.md`.

## Ce que la validation e2e a établi (2026-08-11)

Les trois rôles déployés et vivants sur trois distributions (Ubuntu, Rocky,
Arch) : agent direct, relais, agent de zone **isolé** (installé via le relais
uniquement, l'instance bloquée au pare-feu). Les onze genres de contrôle
exécutés par l'agent, 328 points persistés en base — `cert` rend `down` à raison
(rejet d'un cert auto-signé), tout le reste `operational`.

Un **bug réel** trouvé et corrigé sur une vraie machine : `default_path()` /
`default_config()` étaient relatifs, si bien qu'un `pair`/`run`/`doctor` sans
`--config` visait le cwd et divergeait du fichier du service → 401 en boucle sur
une config qu'on croyait fraîche (probable cause du « never reported » initial).
Corrigés en chemin XDG absolu, cohérent avec l'installeur (commit `13817d2`),
validé en réel.

Un **tutoriel** de démarrage rapide, appuyé sur ces vraies sorties :
`docs/tutorial.md`.

## Ce qui reste ouvert (non bloquant)

- **Cadence de refresh 300 s** : réactivité lente à une nouvelle assignation et
  à l'apparition d'un agent de zone. Piste : intervalle plus court, ou
  déclenchement sur événement.
- **Logs du relais silencieux** sur l'activité périodique réussie (heartbeat,
  déclaration de zone) — un log debug aiderait au diagnostic.
- **Reset du mot de passe de l'UI de l'agent depuis la console** : toujours non
  fait (demande un canal serveur→agent à concevoir).

## Règles de la boucle

- Un point à la fois, dans l'ordre, entièrement, prouvé par des commandes
  réellement exécutées.
- Vérification avant de cocher : `pnpm typecheck`, `lint`, `format`, `test` ; et
  pour l'agent `cargo test`, `cargo fmt --check`, `cargo clippy -- -D warnings`.
  `pnpm format` **après** la dernière édition.
- Commiter le point seul, en nommant les chemins ; jamais `git add -A` ni un
  répertoire. Inspecter les hunks des fichiers partagés.
- Ne pas toucher au relais de prod de Jacques (`192.168.1.170:38787`).
- Regrouper les corrections de code pour minimiser builds et CI ; ne pousser
  qu'une fois en fin de mission.

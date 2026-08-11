# CONTEXT

## Current Task

Rien en cours. `v0.1.26` : correction du chemin de config relatif (cause des 401
en boucle), trouvée et validée lors d'une validation e2e sur trois VM réelles.

## Key Decisions

- **`default_path()`/`default_config()` étaient relatifs** (`agent.toml`). Un
  `pair`/`run`/`doctor` sans `--config` visait le cwd et divergeait du fichier
  du service → 401 en boucle sur une config qu'on croyait fraîche. Corrigés en
  chemin XDG absolu, cohérent avec le CONF_DIR de l'installeur. euid lu depuis
  /proc (pas de dépendance libc).
- **Validation e2e complète** : 3 rôles sur Ubuntu/Rocky/Arch, 11 genres de
  contrôle (328 points en base), agent de zone isolé via relais. Bilan dans
  `deploy-tests/e2e-2026-08-11/RESTITUTION.md`. Tutoriel : `docs/tutorial.md`.

## Next Steps

- Cadence de refresh 300 s : réactivité lente (nouvelle assignation, apparition
  d'un agent de zone). Piste : intervalle plus court ou déclenchement sur
  événement.
- Logs du relais silencieux sur l'activité périodique réussie.
- Reset du mot de passe de l'UI de l'agent depuis la console (canal
  serveur→agent à concevoir).

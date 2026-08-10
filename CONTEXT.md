# CONTEXT

## Current Task

Rien en cours. `v0.1.21` : le taux de disponibilité se calcule sur la durée et
non sur un compte de checks, et trois genres de sonde regardent la machine
(`file`, `directory`, `uptime`). Vert : 848 tests JS, 68 côté agent, 75 côté
installateur. Migration `0021` (trois valeurs de plus sur `control_kind`).

## Key Decisions

- Le chiffre publié **change de sens** à cette version : time-weighted, `degraded`
  compte comme disponible, le temps non observé quitte le dénominateur, un push
  silencieux compte contre vous. Dit au lecteur dans `docs/user-guide.md`.
- `computeAvailability` prend des **intervalles**, pas des points : un check brut
  est un intervalle à état plein, un seau d'agrégat un intervalle fractionnaire.
  Un seul compteur, sinon une résolution porte sa propre copie des règles.
- `file`/`directory`/`uptime` sont refusées côté serveur comme `docker`, et pour
  une raison plus vive : le disque est là sans qu'on ait rien à monter.

## Next Steps

- La refonte `TenantStyle` / `custom-style` reste en cours dans l'arbre — 27
  fichiers non commités.
- Bornes `from`/`to` arbitraires et regroupement semaine/mois/année sur
  `uptime.json` : non livrés, séparables.
- Le service worker sert un bundle périmé après une mise à jour.

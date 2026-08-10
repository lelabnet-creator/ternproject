# CONTEXT

## Current Task

Rien en cours. `v0.1.22` : correctifs d'usage sur la zone, l'installation et
l'admin, plus la réparation d'une régression que j'avais publiée en 0.1.21.
Vert : 850 tests JS avec l'index seul, 68 côté agent, 75 côté installateur.

## Key Decisions

- **Ne jamais indexer un fichier partagé sans inspecter ses hunks.** Nommer le
  chemin ne suffit pas : `git add apps/api/src/routes/status.ts` a emporté un
  travail en cours dans une image publiée, et la page publique est morte sur
  `custom.html.trim()`. Deuxième occurrence après `apps/web/src`.
- Le relais déclare sa zone **à l'appairage**, plus seulement toutes les cinq
  minutes : l'agent apparaissait avec des minutes de retard et tout donnait
  l'impression d'un échec d'installation.
- `systemctl restart --no-block` : attendre l'unité, c'est attendre
  `network-online.target`, soit deux minutes pleines sur une machine à deux
  interfaces.
- Révoquer un relais demande ce qu'il advient de sa zone. Ces lignes n'existent
  que parce qu'il les déclare ; le laisser choisir vaut mieux que les orpheliner
  ou les supprimer en silence.

## Next Steps

- La refonte `TenantStyle` / `custom-style` reste en cours dans l'arbre — 27
  fichiers non commités. Le passage de `custom` à `{ css }` côté serveur devra
  repartir **avec** son côté client cette fois.
- La déclaration immédiate de zone n'a pas de test dédié : exercer `pair` de
  bout en bout demande un `AppState` complet avec un amont simulé.
- Bornes `from`/`to` et regroupement semaine/mois/année sur `uptime.json`.

# Backlog — le taux de disponibilité

Le sujet précédent (poser un relais depuis l'interface) est terminé, fusionné et
tagué `v0.1.20` ; son détail est dans l'historique git.

Celui-ci part d'un défaut mesurable. `GET /public/:slug/uptime.json`
(`apps/api/src/routes/status.ts:438`) calcule aujourd'hui :

```sql
round(100.0 * sum(a.ok_samples) / sum(a.samples), 4)
```

C'est **check-weighted** : un ratio de points, pas de durée. Deux conséquences
qu'un lecteur de la page ne peut pas deviner.

- Un contrôle sondé toutes les 10 s et un autre toutes les 5 min pèsent le même
  pourcentage pour une panne de même durée.
- Changer l'intervalle d'un contrôle réécrit rétroactivement le sens de son
  historique, sans que rien ne le dise.

Ce qui est demandé est un passage en **time-weighted**, plus quatre règles qui
n'existent nulle part : anti-flapping, cas `push`, exclusion des maintenances,
et OR entre agents d'un même contrôle.

## Ce qui est déjà vrai — à ne pas refaire

- **Les agrégats continus existent** : `checks_1m`, `checks_5m`, `checks_1h`
  (`packages/db/sql/0001_timescale.sql`), avec leurs politiques de rafraîchis-
  sement. Le calcul doit s'appuyer dessus, pas sur la table brute.
- **La table `maintenances` existe** (`packages/db/src/schema/incidents.ts:96`),
  avec `maintenance_controls` pour la portée. Aucune migration à créer : il
  manque l'**exclusion dans le calcul**, pas l'entité.
- **Les deux widgets existent** et consomment déjà cet endpoint : `uptime-ribbon`
  et `availability-calendar` (`apps/web/src/charts/registry.ts`).
- **Un contrôle peut avoir plusieurs agents** : `control_agents` est une table de
  jonction (`packages/db/src/schema/controls.ts:140`). C'est ce que « plusieurs
  sondes sur un même monitor » désigne ici.
- **La rétention borne déjà la fenêtre** : `clampToRetention` refuse de publier
  au-delà de ce que le locataire garde.

## Une limite à écrire, pas à contourner

Un agrégat horaire ne connaît pas l'instant d'une bascule. Le time-weighting sur
`checks_1h` est donc exact à l'heure près, pas à la seconde. Pour les fenêtres
courtes (jour), le calcul descend sur `checks_1m` ; au-delà il reste horaire, et
**l'endpoint dit laquelle il a utilisée** plutôt que de laisser croire à une
précision qu'il n'a pas.

## À faire

- [x] **1. La fonction de calcul, isolée et testée.** Un module pur qui prend une
      série de points (`ts`, `status`, `agentId`) et une liste de fenêtres
      d'exclusion, et rend une durée disponible / durée totale. Il porte les
      quatre règles : time-weighting, debounce à 2 échecs consécutifs avec
      antidatage au **premier** échec de la série, OR entre agents, exclusion des
      maintenances. Aucun accès base ici — c'est ce qui le rend testable.

      Fait : `packages/shared/src/availability.ts`, 17 tests. Vérifié avec
              l'index seul. Deux décisions écrites en chemin — `degraded` compte comme
              disponible (les agrégats ne comptaient que `operational`, donc un service
              lent baissait l'uptime publié), et le temps que personne n'a observé quitte
              le dénominateur au lieu d'être deviné dans un sens ou dans l'autre.
              Le sous-chemin `@tern/shared/availability` reste à ajouter au point 4 :
              `packages/shared/package.json` porte un travail en cours non commité.

- [ ] **2. Le cas `push`.** Pas d'échec au sens classique : l'indisponibilité
      commence à `expectedIntervalS` + grâce après le dernier battement reçu, et
      court jusqu'au suivant. La grâce est configurable ; choisir un défaut et
      écrire pourquoi. Se raccorder à la balayeuse de péremption qui existe déjà.

- [ ] **3. L'endpoint.** Granularités jour / semaine / mois / année, bornes de
      début et de fin, un contrôle ou tous. Il annonce la résolution employée.
      Arrondi à 2–3 décimales, et sous le seuil d'incertitude dû à la fréquence
      de sondage il publie `100%` plutôt qu'un `99,997%` trompeur — le seuil se
      déduit de l'intervalle, pas d'une constante magique.

- [ ] **4. Le câblage.** Le ruban prend une valeur par jour, le calendrier une
      grille de 20 semaines. Les deux consomment déjà l'endpoint : vérifier que
      le changement de sémantique ne casse pas leur lecture, et que le libellé
      dit « time-weighted » là où un lecteur pourrait supposer l'autre.

- [ ] **5. Les paliers.** Les libellés d'affichage suivent la table des « nines »
      (99 / 99,9 / 99,95 / 99,99 / 99,999). Un palier est une étiquette, pas une
      promesse : ne pas inventer de SLA là où le produit n'en a pas.

- [ ] **6. La documentation.** `docs/data-model.md` pour la règle de calcul et
      ses quatre cas, `docs/user-guide.md` pour ce que le lecteur de la page
      voit changer. Dire explicitement que le chiffre publié change de sens à
      cette version, et dans quel sens.

## Hors périmètre

- Pondération différente entre types de sondes d'un même contrôle : OR simple.
- Réglage du seuil de debounce dans l'interface : défaut codé, 2.

## Règles de la boucle

- Un point à la fois, dans l'ordre, entièrement.
- Vérification avant de cocher : `pnpm typecheck`, `lint`, `format`, `test` ; et
  pour l'agent `cargo test`, `cargo fmt --check`, `cargo clippy -- -D warnings`.
  `pnpm format` **avant** de commiter.
- Commiter le point seul, **en nommant les chemins**. Jamais `git add -A`, jamais
  un répertoire : l'arbre contient un travail en cours de Jacques
  (`TenantStyle` / `custom-style`, 28 fichiers) qui ne doit pas bouger. Vérifier
  chaque commit isolément avec `git stash push --keep-index -u`.
- Si un point repose sur une prémisse fausse, arrêter et l'expliquer plutôt que
  d'improviser.
- Quand les six sont cochés : fusionner dans `main`, pousser, taguer `v0.1.21`.

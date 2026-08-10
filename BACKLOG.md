# Backlog

Le sujet précédent — **le taux de disponibilité** — est terminé, fusionné et
tagué `v0.1.21`. Le détail de chaque point est dans l'historique git ; ce qui
suit est ce qu'il faut savoir sans le lire.

## Ce que la 0.1.21 a changé

Le chiffre publié était `sum(ok_samples) / sum(samples)` — un ratio de points.
Il est désormais pondéré par la durée, et **il change de sens** : une panne coûte
le temps qu'elle a duré, et non un nombre de checks qui dépendait de la fréquence
de sondage.

Quatre règles, dans `packages/shared/src/availability.ts`, délibérément loin de
tout SQL — chacune est une décision que quelqu'un contestera un jour, et toutes
se testent sans base, sans horloge et sans serveur de test :

- **Anti-flapping** à 2 échecs consécutifs, la panne datée du **premier**.
- **Contrôles `push`** : le silence est l'indisponibilité, après l'intervalle
  déclaré plus un intervalle de grâce — le même seuil que `sweepStaleControls`.
- **Maintenances** : quittent le dénominateur, et seulement pour leur durée
  réelle (`actual_*` avant `scheduled_*`).
- **Plusieurs agents** : OR, jamais une moyenne.

Deux décisions qui changent aussi ce que le nombre veut dire : `degraded` compte
comme disponible, et le temps que personne n'a observé quitte le dénominateur au
lieu d'être deviné.

Le module prend des **intervalles** et non des points : un check brut est un
intervalle à état plein, un seau d'agrégat un intervalle fractionnaire. Un seul
compteur sert les deux — sinon une résolution finit par porter sa propre copie
des règles, et le pourcentage veut dire une chose pour un jour et une autre pour
une année.

## Ce qui reste ouvert

- **Bornes `from`/`to` arbitraires** et regroupement calendaire semaine / mois /
  année sur `uptime.json`. Le regroupement est journalier, ce que consomment le
  ruban et le calendrier — rien n'est bloqué, c'est un ajout séparable.
- **Le OR entre agents ne vaut que sur le chemin brut.** Les agrégats groupent
  par `control_id` seul : la dimension agent est déjà écrasée quand un seau
  existe.
- **La recette VM avec isolement réel** reste à jouer (scripts dans `.vm-lab/`).
- **Le service worker** sert un bundle périmé après une mise à jour.

## Règles de la boucle

- Un point à la fois, dans l'ordre, entièrement.
- Vérification avant de cocher : `pnpm typecheck`, `lint`, `format`, `test` ; et
  pour l'agent `cargo test`, `cargo fmt --check`, `cargo clippy -- -D warnings`.
  `pnpm format` **avant** de commiter — et après la dernière édition, pas avant.
- Commiter le point seul, **en nommant les chemins**. Jamais `git add -A`, jamais
  un répertoire. Vérifier chaque commit isolément avec
  `git stash push --keep-index -u`, et **dépiler avant d'en empiler une autre**.
- Si un point repose sur une prémisse fausse, arrêter et l'expliquer plutôt que
  d'improviser.

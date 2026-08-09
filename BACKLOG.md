# Backlog — poser un relais depuis l'interface

Le sujet précédent (vue Fleet des proxies) est terminé et fusionné ; son détail
est dans l'historique git. Celui-ci part du constat suivant : l'admin sait
**dessiner** un relais mais n'offre aucun moyen d'en **poser** un.

Plan complet et raisonné :
`~/.claude/plans/j-avais-pr-vu-d-ajouter-un-quiet-hickey.md`.

## Ce qui est déjà vrai — à ne pas refaire

- **Une seule crate, deux `[[bin]]`.** Le fichier propre au proxy fait 161
  lignes de CLI ; le reste est partagé. Décision prise : on garde deux binaires.
- **La file existe.** `spawn_flush` vide une file bornée sur disque par lots de
  200 toutes les 10 s et garde les points quand l'amont tombe. Il manque
  l'option, pas le mécanisme.
- **Le binaire proxy est déjà dans l'image publiée** (vérifié en tirant la
  `0.1.12`) et `routes/download.ts` le sert déjà.
- **Les huit genres marchent déjà derrière un relais** — ce sont les agents de
  la zone qui sondent, le proxy relaie. Vérifié de bout en bout.

## Une limite à écrire, pas à contourner

TERN ne peut pas émettre un PIN de zone : le proxy émet les siens, sur sa
machine, et c'est ce qui fait qu'un hôte compromis dans la zone ne détient jamais
de justificatif amont. Le « même mode de jonction » vaut pour **joindre le proxy
à TERN**. Joindre un agent au proxy reste un `tern-proxy pin` sur le relais, et
l'interface doit le dire.

## À faire, dans cet ordre

### 1. ~~Le panneau d'appairage choisit un rôle~~ — fait

Vérifié : `pnpm typecheck`, `lint`, `format`, `test` — 754 (+6). Les commandes
sont extraites en `PairCommands` pour être rendues sans mutation ni serveur, et
la garde est éprouvée : retirer le `--proxy` fait rougir deux cas.

Un premier jet de test n'assertait que sur une chaîne écrite dans le test
lui-même — décoratif, retiré. C'est ce qui a motivé l'extraction.

<details><summary>Description d'origine</summary>

`apps/web/src/routes/app/FleetScreen.tsx`, `PairPanel`. Deux choix — agent ou
relais — avant le PIN. Même endpoint : le serveur déduit le rôle du
`agentVersion` annoncé, ce qui reste vrai pour un proxy déjà déployé.

La une-ligne gagne `--proxy` (et `-Proxy` en PowerShell), le repli « by hand »
montre la commande `init`, et une phrase explique le `tern-proxy pin` à venir —
avec sa raison, parce qu'une limite expliquée se retient et une limite subie se
signale comme un bug.

</details>

### 2. ~~L'installateur finit le travail~~ — fait

Vérifié : `pnpm typecheck`, `lint`, `format`, `test` — 759 (+5), dont le cas qui
parse le script en `sh -n`. La garde est éprouvée : recoder `tern-agent` en dur
dans l'`ExecStart` fait rougir un cas.

Un piège rencontré, que ce fichier documente lui-même : les backticks d'un
commentaire ferment le template literal TypeScript qui contient le script. Deux
commentaires réécrits sans.

<details><summary>Description d'origine</summary>

`apps/api/src/routes/download.ts`. Les deux scripts s'arrêtent aujourd'hui sur
« _tern-proxy installed. It takes no config and no pairing._ », ce qui est faux :
le proxy s'appaire et écrit une config.

Remplacer les deux sorties anticipées par la suite déjà écrite pour l'agent, avec
trois différences : `init` au lieu de `pair`, la config du proxy, et une unité de
service qui lance `tern-proxy run`. Réutiliser la machinerie systemd/launchd du
même script plutôt que d'en écrire une seconde.

</details>

### 3. ~~La commande d'appairage du proxy~~ — fait, et remonté avant le point 1

Permuté avec le point 1, qui en dépend : le panneau a besoin de cette commande
pour l'afficher, et la fabriquer côté client en attendant aurait été un
provisoire à défaire.

Vérifié : `pnpm typecheck`, `lint`, `format`, `test` — 2 cas ajoutés (le rendu
lui-même, et la réponse de `pairing-codes` qui porte désormais les deux verbes).

<details><summary>Description d'origine</summary>

`renderProxyInitCommand` dans `packages/shared/src/templates.ts`, à côté de
`renderAgentPairCommand`. Exposée comme `proxyPairCommand` dans la réponse de
`POST /:slug/pairing-codes` — un champ de plus, pas un remplacement.

</details>

### 4. La cadence de transmission

`clients/agent/src/proxy.rs`. `ProxyConfig` gagne `forward_interval_s` (défaut 10) et `forward` (`batch` par défaut, ou `stream`), tous deux
`#[serde(default)]` pour qu'un `proxy.toml` existant se charge encore.

En `stream`, `ingest` réveille la boucle d'envoi **après** avoir mis en file, par
un `Notify` : la file reste le filet, et il n'y a toujours qu'un seul chemin vers
l'amont. `init` gagne les drapeaux correspondants et `status` les affiche.

### 5. Le rond, jugé sur pièce

Les traits existent — zone → proxy → centre, losange, légende — et **personne ne
les a encore vus**. Une fois un relais et son agent en place, regarder et
corriger ce qui ne se lit pas : l'écart proxy/zone à 320 px, les pointillés en
clair comme en sombre, le cas à deux relais et celui du relais sans agent.

### 6. La recette sur VM Ubuntu

Les préalables sont réunis sur cette machine : `ubuntu.img`, pont `br0`,
`/dev/kvm` accessible, `bridge.conf` autorisant `br0`.

```sh
python3 .vm-lab/run.py ubuntu
python3 .vm-lab/console.py ubuntu
```

Ce que cette phase doit prouver, et que le labo en conteneurs ne peut pas :

- la une-ligne `--proxy` posée sur une **machine vierge** installe le binaire,
  appaire, écrit la config et enregistre le service — sans étape manuelle
- le relais **survit à un redémarrage** de la VM et reprend son service
- un agent appairé au relais mesure les huit genres et ses points remontent
- le tout en lisant l'écran, pas seulement les journaux : `console.py` est là
  pour ça, et `deploy-tests/README.md` rappelle que quatre captures « réussies »
  d'un écran de connexion ont déjà trompé cette recette

Déposer la trace dans `deploy-tests/`, comme les recettes précédentes.

## Règles de la boucle

- Un point à la fois, fini et vérifié avant le suivant.
- Vérifier veut dire : `pnpm typecheck`, `lint`, `format`, `test` ; et pour
  l'agent `cargo test`, `cargo fmt --check`, `cargo clippy -- -D warnings`.
  **Lancer `pnpm format` avant de commiter** — c'est ce qui a fait échouer la
  v0.1.11 et empêché la publication de son image.
- Un commit par point, sur la branche courante. **Ne pas pousser, ne pas taguer,
  ne pas publier.**
- Ne jamais `git add -A` : nommer les chemins. Un `bg.png` qui n'était pas de moi
  s'est retrouvé dans un commit de cette façon.
- Si un point repose sur une prémisse fausse ou déborde largement de sa
  description, s'arrêter et le dire plutôt qu'improviser.

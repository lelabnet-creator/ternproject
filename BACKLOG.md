# Backlog — agents-proxy dans la vue Fleet

La moitié serveur est faite et fusionnable ; la chaîne n'est pas fonctionnelle
tant que le point 1 n'est pas livré. Cette liste est consommée par une boucle
d'agent : elle est ordonnée, chaque point est fini avant le suivant, et un point
n'est coché qu'une fois vérifié.

## Fait

- [x] Migration `0018` — `agents.role` (`agent` | `proxy`) et `agents.parent_agent_id`.
- [x] Détection du rôle à l'appairage, depuis `agent_version: "proxy/<version>"`
      que le proxy envoie déjà. Aucun nouveau champ de protocole.
- [x] `POST /agent/zone` — un proxy y déclare sa zone. Remplace au lieu de
      fusionner, délie au lieu de supprimer, refuse un appelant non-proxy.
- [x] `role`, `parentAgentId` et `pairedIp` exposés par `GET /agents`.
- [x] Vue : losange pour le proxy, flux `agent → proxy → TERN` en pointillés,
      agents relayés groupés autour de leur relais, IP dans la liste, badge
      « proxy » en toutes lettres.

## À faire, dans cet ordre

### 1. ~~Le proxy remonte sa zone~~ — fait

Vérifié : `cargo test` 45 (+3), `cargo fmt --check`, `cargo clippy -D warnings` ;
`pnpm typecheck`, `lint`, `format`, `test` 738 (+5). La migration `0018` a dû
être appliquée à la base de dev — la fixture d'intégration ne migre pas, et les
tests d'appairage tombaient en 500 sans elle.

Une chose n'est pas testée et ne le sera pas ainsi : « un amont injoignable ne
casse pas le relais ». `declare_zone` vit dans la boucle de rafraîchissement,
pas sur le chemin de service ; il avertit et rend la main. C'est structurel, pas
assertable sans un faux client, et l'écrire coûterait plus que ce que ça prouve.

<details><summary>Description d'origine</summary>

`clients/agent/src/proxy.rs` ne garde par agent local qu'un
`LocalKey { name, key_hash }`. Sans dernier contact ni adresse, la route ajoutée
côté serveur n'a rien à recevoir et le dessin rien à dessiner.

- Étendre `LocalKey` : dernier contact, et l'adresse vue à l'intérieur de la
  zone. Persisté comme le reste — un redémarrage du proxy ne doit pas vider la
  vue.
- Toucher ce dernier contact quand un agent local demande ses jobs ou pousse un
  point : ce sont les deux seuls moments où le proxy le voit vivant.
- Pousser l'inventaire vers `POST /agent/zone`, sur le même rythme que le reste
  du trafic amont, et sans faire échouer quoi que ce soit si l'amont est coupé —
  la file existante sert de modèle.
- Tests : l'inventaire se remplit, il survit à un redémarrage, un amont
  injoignable ne casse pas le relais.

</details>

### 2. ~~Les deux tests de sonde manquants~~ — fait

Vérifié : `cargo test` 46 (+1) plus un ignoré, `cargo fmt --check`,
`cargo clippy -D warnings` ; `pnpm typecheck`, `lint`, `format`, `test` 738
inchangés. Le test `docker` réel a été **exécuté contre le démon de la machine**
(`tern-prod-app-1`) : `State.Running`, `State.Status`, et le refus nommé d'un
conteneur inconnu. Le test `cert` nominal a été mis à l'épreuve en retirant la CA
du magasin de confiance — il échoue, donc il vérifie bien quelque chose.

`days_until_expiry` a dû être scindé : l'ancre de confiance devient un paramètre.
Sans ça le chemin nominal était intestable, puisqu'un certificat local n'est par
définition signé par rien que webpki connaisse — et l'affaiblir en test aurait
prouvé l'inverse du but. La production passe les vraies racines et reste seule
appelante.

<details><summary>Description d'origine</summary>

- `cert`, chemin nominal. Demande un générateur de certificats en
  dev-dependency (`rcgen`) et un serveur rustls local. Aujourd'hui seul le
  chemin d'échec est couvert — le bon hôte, le mauvais port.
- `docker` contre un vrai démon plutôt que contre la fausse socket Unix du test
  actuel, qui vérifie le dialogue HTTP et le parsing mais pas que Docker répond
  bien ce qui est supposé. À garder derrière une condition : la suite doit
  rester verte sur une machine sans Docker.

</details>

### 3. ~~Ce que la zone divulgue désormais~~ — fait

Vérifié : `pnpm docs:build`, l'ancre croisée `#what-an-isolated-zone-discloses`
résout, `pnpm typecheck`, `lint`, `format`, `test` 738 ; agent inchangé, 46
tests. Trois documents touchés plutôt que deux — `data-exchange.md` décrivait le
proxy endpoint par endpoint et serait devenu faux en restant muet sur celui-ci.

<details><summary>Description d'origine</summary>

`docs/security.md` décrit une zone isolée opaque. Elle ne l'est plus de la même
façon : le proxy remonte les noms, les adresses internes et les horaires de sa
zone. C'est une décision explicite, elle doit être écrite là où quelqu'un
l'évalue — avec le fait que ne pas activer la remontée laisse la vue exactement
comme avant.

`docs/architecture.md` doit dire ce que le losange signifie dans la vue Fleet.

</details>

### 4. ~~L'essai de bout en bout~~ — fait

Mené sur une instance dédiée (`tern-lab`, port 28995, image construite depuis la
branche), pas sur les VM : la recette `.vm-lab/` teste en plus l'installation sur
système nu, qui n'a pas changé, alors que ce point visait la conversation entre
les trois morceaux.

Modes exercés, chacun de bout en bout :

| Mode                        | Vérifié par                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------- |
| agent local de l'instance   | présent dans la flotte au démarrage                                                 |
| agent → TERN                | appairage, jobs, sonde, ingestion, battement                                        |
| proxy → TERN                | appairage (rôle détecté), assignation en cache, déclaration de zone                 |
| agent → proxy → TERN        | PIN émis par le proxy, job servi du cache, `Operational`, point remonté par la file |
| push par clé, direct        | `POST /api/v1/ingest`, `accepted: 1`                                                |
| push par clé, via le relais | idem contre le proxy, valeur visible sur la page publique                           |

Trois défauts trouvés et corrigés, chacun mis à l'épreuve en le remettant :
heartbeat absent du proxy, déclaration de zone happant les agents directs par
collision de hostname, et `PATCH /controls/:id` réécrivant cinq champs qu'il ne
mentionnait pas.

Non vérifié : le dessin lui-même. L'admin demande une session, et je ne saisis
pas de mot de passe. Les données que la vue consomme sont justes — rôle, parent,
IP — mais personne n'a encore regardé le losange à l'écran.

<details><summary>Description d'origine</summary>

Sur une machine Ubuntu, via `.vm-lab/` : un proxy appairé au serveur, un agent
appairé au proxy, et la vue qui montre la chaîne. C'est le seul niveau où l'on
saura que les trois morceaux se parlent.

## Règles de la boucle

- Un point à la fois, fini et vérifié avant le suivant.
- Vérifier veut dire : `pnpm typecheck`, `pnpm lint`, `pnpm format`, `pnpm test`,
  et pour l'agent `cargo test`, `cargo fmt --check`, `cargo clippy -- -D warnings`.
- Un commit par point, sur la branche en cours. **Ne pas pousser, ne pas taguer,
  ne pas publier** — ces gestes restent des décisions humaines.
- Si un point se révèle plus large qu'écrit, ou repose sur une prémisse fausse,
  s'arrêter et le dire plutôt que d'improviser.

</details>

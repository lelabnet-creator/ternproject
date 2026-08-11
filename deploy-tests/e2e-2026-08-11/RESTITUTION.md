# Restitution — validation de bout en bout, 2026-08-11

Mission : déployer les trois rôles (agent, relais, agent derrière relais) sur
trois VM réelles, vérifier les battements, exercer **tous** les genres de
contrôle par l'agent, corriger ce qui se révèle défectueux, et en tirer un
tutoriel. Objectif : l'application fonctionne de bout en bout, preuves à l'appui.

**Résultat : atteint.** Les trois rôles sont déployés et vivants, les onze
genres de contrôle produisent des points en base (328 au total), un bug réel a
été trouvé et corrigé sur une vraie machine, et un tutoriel appuyé sur ces
vraies sorties est écrit.

---

## Le banc

| Machine | Distro       | IP LAN        | Rôle                              |
| ------- | ------------ | ------------- | --------------------------------- |
| ubuntu  | Ubuntu 24.04 | 192.168.1.112 | agent direct                      |
| rocky   | Rocky 9      | 192.168.1.157 | relais (`tern-proxy`, port 38787) |
| arch    | Arch Linux   | 192.168.1.106 | agent de zone, **isolé**          |

Instance : celle de **développement** (`http://192.168.1.144:3011`, tenant
`acme`), servie par le dev-server. IP hôte pour le banc : `192.168.1.144`
(bridge br0).

---

## Ce qui marche, prouvé

1. **Les trois déploiements** via `install.sh`, chacun enregistré en service
   systemd et démarré. Traces `03-*.txt`.
2. **Les trois battements** vivants côté serveur — agent, relais (heartbeat
   ajouté récemment), et agent de zone remonté par la déclaration du relais.
   Trace `04-heartbeats.txt`.
3. **L'isolement réel** d'arch : pare-feu bloquant l'instance (HTTP 000), install
   et appairage **uniquement via le relais**. Trace `03-arch-isolation.txt`.
4. **Les onze genres de contrôle**, exécutés par l'agent ubuntu, points persistés
   en base (`05-db-points.txt`) :

   | Genre       | Verdict     | Note                                        |
   | ----------- | ----------- | ------------------------------------------- |
   | http        | operational |                                             |
   | tcp         | operational |                                             |
   | ping        | operational | après `setcap cap_net_raw+ep`               |
   | dns         | operational |                                             |
   | cert        | **down**    | **attendu** — rejet correct d'un auto-signé |
   | websocket   | operational | cible locale (handshake 101)                |
   | docker      | operational | conteneur `e2e-nginx` sur ubuntu            |
   | file        | operational |                                             |
   | directory   | operational |                                             |
   | uptime      | operational |                                             |
   | push        | operational | alimenté par script via `/ingest`           |

5. **La page publique** rend l'état (capture `07-page-publique.jpg`) — avec le
   layout mobile en volets à points.

---

## Le bug trouvé et corrigé

**`default_path()` / `default_config()` renvoyaient un chemin relatif**
(`agent.toml` / `proxy.toml`). Conséquence : un `pair`, `run` ou `doctor` tapé
sans `--config` visait le répertoire courant du shell, alors que le service lit
`~/.config/tern/agent.toml`. Un ré-appairage manuel écrivait donc une clé valide
dans `~/agent.toml` tandis que le service gardait sa clé périmée → **401 en
boucle, sur une config qu'on croyait fraîche**.

C'est vraisemblablement la cause du symptôme « never reported » rencontré
précédemment lors d'un ré-appairage manuel.

Corrigé (commit `13817d2`) : chemin XDG absolu, identique au `CONF_DIR` de
l'installeur — `/etc/tern` en root, sinon `$XDG_CONFIG_HOME/tern` ou
`~/.config/tern`. Validé **en réel** : le `pair` sans `--config` écrit désormais
dans `~/.config/tern/agent.toml`, clé HTTP 200 (`06-defaultpath-fix.txt`). Test
unitaire ajouté ; 74 tests agent au vert.

L'installeur, lui, n'était pas affecté : il passe déjà `--config` explicite
partout. Seul un usage manuel tombait dans le piège.

---

## Analyse jobs / erreurs / logs (point 6)

- **Récupération des jobs** : cadence 300 s. Un contrôle nouvellement assigné
  n'est pris qu'au prochain refresh (redémarrage du service pour l'accélérer).
  Sur 401 ou serveur injoignable, l'agent garde l'assignation en mémoire et
  continue — correct.
- **Gestion des erreurs** : clé invalide (401) et serveur injoignable sont
  distingués par des messages différents et actionnables.
- **Qualité des logs** : excellente côté agent (chaque sonde loggée : control,
  kind, status, latence). Côté relais, l'activité périodique réussie n'est pas
  loggée — on ne confirme la déclaration de zone qu'en regardant le serveur.

Détail complet : `06-logs-analyse.txt`.

---

## Hypothèses et écarts (à connaître)

1. **Instance de dev, pas la prod.** `28999` est la prod de Jacques (interdite),
   `28994` refusait le login. L'instance de dev est seedée, ses identifiants
   sont publics dans le dépôt, et son API écoute sur le LAN. Le relais de prod
   sur `192.168.1.170:38787` n'a **pas** été touché.
2. **Binaires reconstruits.** Les binaires servis par l'API dataient de la CI.
   Pour tester le **code courant** (dont les correctifs récents), agent et proxy
   ont été recompilés en `x86_64-unknown-linux-musl` et placés dans le dossier
   servi ; restaurés à l'état git après le test. Sans cela, le test aurait
   validé du code périmé.
3. **Migration `0021` appliquée à la base de dev.** Elle ajoute les genres
   `file`/`directory`/`uptime` à l'enum `control_kind` et était en attente ; sans
   elle, créer ces contrôles échouait en 500. Ce n'est pas un bug de code, mais
   un environnement de dev non migré.
4. **`cert` = down est correct.** Le probe utilise un trust store webpki
   embarqué et rejette à raison un certificat auto-signé. Un cert de CA publique
   donnerait `operational`. La cible locale ne pouvant pas avoir de cert de
   confiance sans dépendance externe, `down` prouve que le genre fonctionne.
5. **Paquets installés** (autorisé par Jacques, à signaler) :
   - sur l'hôte : `zig` et `lld21` (cross-compilation musl via `cargo-zigbuild`) ;
   - sur la VM ubuntu : `docker.io` (pour la cible du genre `docker`).
6. **Latence de zone** : un agent de zone apparaît « vu » avec jusqu'à 5 min de
   retard (déclaration du relais toutes les 300 s). Observé, documenté, non
   corrigé — comportement défendable et configurable.

---

## Ce qui reste ouvert (non bloquant)

- **Cadence de refresh 300 s** : réactivité lente à une nouvelle assignation et
  à l'apparition d'un agent de zone. Piste : intervalle plus court ou
  déclenchement sur événement. Non corrigé (choix défendable).
- **Logs du relais silencieux** sur l'activité périodique réussie. Un log debug
  de la déclaration de zone aiderait au diagnostic.

---

## Commits de cette mission

- `13817d2` fix(agent): default_path/default_config absolus (XDG)
- points e2e 1→8 : commits `test(e2e): point N` et `docs(tutorial)`
- Le tutoriel : `docs/tutorial.md`

Toutes les preuves brutes sont dans ce dossier (`01-*` à `07-*`,
`resultats.json`).

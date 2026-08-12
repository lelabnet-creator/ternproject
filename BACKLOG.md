# Reste à faire

Établi le 2026-08-12, après la session qui a mené de `v0.1.27` à `v0.1.30` plus
le canal d'ordres non publié. Ordonné par ce qui bloque, puis par ce qui n'a pas
été vérifié, puis par la dette.

## 1. Ce qui manque à ce qui vient d'être écrit

- [x] **Les ordres atteignent les agents de zone.** Le serveur rend
      `zoneCommands` au relais, qui les garde et les remet à chaque machine sur
      son propre sondage ; les réponses remontent par une route du relais, sous
      sa clé, et le serveur ne l'accepte que pour les machines derrière lui.
      Prouvé sur le banc, sur `arch` qui n'a aucune route vers le serveur :
      `logs` est revenu rempli, et `ui-on` a rendu un mot de passe qui ouvre
      réellement sa page (`/login` → 204). Le relais a tracé
      « instructions for the zone waiting=1 ».
      Au passage, `pause`/`stop`/`ui-on` valent aussi pour un relais : la
      logique est partagée par un trait plutôt que recopiée, parce que la copie
      qui dérive est celle qui cesse d'honorer `stop`.

      Ancien texte, pour mémoire : **Les ordres n'atteignent pas les agents de zone.** Le `jobs_route` du
              relais construit sa propre réponse (`tenantSlug`, `jobs`) sans le champ
              `commands`, et il n'a aucune route pour remonter un résultat. La demande
              était « pareil pour les agents derrière les proxy » : elle n'est pas
              satisfaite. À l'écran il n'y a pas de promesse fausse — un agent de zone
              n'a pas de menu — mais le message du commit `83877c0` affirme le
              contraire et se trompe.
              Travail : porter `commands` dans la réponse du relais, ajouter chez lui la
              route de résultat, et faire suivre les deux vers l'amont.

- [ ] **Le canal d'ordres n'a jamais été exercé sur un relais.** Six ordres
      testés sur la VM ubuntu (agent direct), zéro sur rocky. `tern-proxy` a la
      même boucle de rafraîchissement mais pas le même code de démarrage.

- [ ] **L'affichage des retours n'a pas été vu à l'écran.** `CommandTrail` —
      mot de passe montré une fois, bloc de logs, états « en attente / pris /
      répondu » — est écrit et compilé, jamais regardé avec de vrais retours.
      C'est exactement le genre d'endroit où j'ai déjà eu des assertions vraies
      sur une page fausse.

## 2. Publier, et rattraper l'existant

- [ ] **Sortir `v0.1.31`** : canal d'ordres, sous-menu des adresses, déduction
      du rôle dans l'installeur. Rien de tout cela n'est encore chez toi.

- [ ] **Mettre à jour l'agent de `192.168.1.170`.** Il sert encore `Basic
realm` — d'où la popup du navigateur. Procédure prouvée sur les deux VM ;
      il n'y a que l'exécution qui manque, et je n'ai pas d'accès à cette
      machine.

- [ ] **Supprimer les doublons déjà en base.** Ils ont été créés avant
      l'identifiant d'installation et ne se résorbent pas seuls.

## 3. Ce qui rend les ordres pénibles à l'usage

- [ ] **Latence jusqu'à 5 minutes.** C'est l'intervalle de rafraîchissement, et
      c'est l'architecture — les agents interrogent, on ne les joint pas. Pour
      « redémarre » ou « donne-moi tes logs », c'est long. Piste : intervalle
      plus court quand un ordre est en attente, ou un signal sur le heartbeat,
      qui lui bat toutes les minutes.

- [ ] **Le premier battement d'un relais arrive à +300 s.** Sa boucle saute son
      premier tick. Un relais fraîchement installé paraît muet cinq minutes.

- [ ] **L'enum SQL et le `z.enum` de la route sont tenus en phase à la main.**
      C'est ce qui a produit un 400 en pleine session : les genres `ui-on` /
      `ui-off` existaient en base et pas dans le schéma de la route.

## 4. Documentation — rien de tout ceci n'est écrit

- [ ] Les ordres depuis la console, et ce que « pause » et « stop » veulent
      dire l'un par rapport à l'autre.
- [ ] `tern-agent resume`, qui est la seule porte de sortie d'un stop.
- [ ] La page du relais (`tern-proxy ui`), qui n'existait pas avant `0.1.28`.
- [ ] Le chemin de mise à jour : relancer l'installeur sans `--pin`.
- [ ] L'identifiant d'installation, et pourquoi il ne dérive de rien de l'hôte.

## 5. Plus ancien, toujours ouvert

- [ ] **Logs du relais silencieux** sur l'activité périodique réussie : rien ne
      confirme une déclaration de zone qui s'est bien passée.

## Fait dans cette session (pour mémoire)

Le mot de passe de la page se réinitialise désormais depuis la console — c'était
au backlog depuis longtemps et attendait « un canal serveur→agent à concevoir ».
L'ordre `ui-on` est ce canal.

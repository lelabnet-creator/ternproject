# Reste à faire

Établi le 2026-08-12, après la session qui a mené de `v0.1.27` à `v0.1.30` plus
le canal d'ordres non publié. Ordonné par ce qui bloque, puis par ce qui n'a pas
été vérifié, puis par la dette.

## 1. Ce qui manque à ce qui vient d'être écrit

- [x] **Les ordres atteignent les agents de zone.** Le serveur rend
      `zoneCommands` au relais, qui les garde et les remet à chaque machine sur
      son propre sondage ; les réponses remontent sous la clé du relais, que le
      serveur n'accepte que pour les machines derrière lui. Prouvé sur `arch`,
      qui n'a aucune route vers le serveur : `logs` revenu rempli, et `ui-on`
      rendant un mot de passe qui ouvre réellement sa page (`/login` → 204).
      Au passage `pause`, `stop` et `ui-on` valent aussi pour un relais.

- [x] **Le canal d'ordres exercé sur un relais.** Deux défauts trouvés là :
      son binaire n'avait pas le tampon de logs, donc `logs` répondait « fait »
      sur zéro octet — la pire façon d'échouer ; et il n'honorait pas l'état,
      donc « pause » n'était qu'un mot écrit dans un fichier. Corrigés tous
      deux. Prouvé sur rocky : `logs` rend 427 octets, et un point poussé par
      la zone pendant la pause **n'arrive pas** au serveur puis y arrive après
      la reprise. Le libellé de la pause dépend maintenant du rôle — un relais
      ne mesure rien, il retient.

- [x] **L'affichage des retours vu à l'écran, avec de vrais résultats.** Trois
      défauts que seule la capture montrait : le fil n'était jamais chargé à
      l'ouverture de la page (`enabled: false`), donc l'historique disparaissait
      dès qu'on revenait ; le bloc de logs élargissait toute la page au lieu de
      défiler dans sa boîte (1644 px de document dans 1238 px de fenêtre —
      `min-width: auto` d'un élément de grille) ; et le fil s'insérait entre le
      nom et sa légende. Corrigés. Le mot de passe s'affiche avec sa phrase
      « shown once » et son bouton de copie, et un ordre pris sans réponse se
      lit « taken, no answer yet » — distinct de « done ».

## 2. Publier, et rattraper l'existant

- [x] **`v0.1.31` publiée** : canal d'ordres, sous-menu des adresses, déduction
      du rôle dans l'installeur. `Image` et `Release` verts, 13 binaires
      attachés. La CI a d'abord rougi sur un test à moi qui partageait l'anneau
      de logs global et mesurait tout l'instantané — vert seul, rouge à deux.
      La logique sort désormais dans un `Ring` que chaque test instancie.

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

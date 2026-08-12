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

## Ce qui t'attend — je n'y ai pas accès

Ces deux-là ne sont pas des tâches en attente de mon côté : elles demandent la
machine ou l'instance, et je n'ai ni l'un ni l'autre. `ssh 192.168.1.170` refuse
ma clé, et toucher à ton instance est ce que tu m'as demandé de ne pas faire.

- **Mettre à jour l'agent de `192.168.1.170`.** Il sert encore `Basic realm`,
  d'où la popup. Une commande, prouvée sur les deux VM du banc :

  ```sh
  CONF=$(ls ~/.config/tern/agent.toml ~/.config/tern/proxy.toml /etc/tern/*.toml 2>/dev/null | head -1)
  SERVER=$(sed -n 's/^server *= *"\(.*\)"/\1/p' "$CONF")
  curl -fsSL "$SERVER/install.sh" | sh -s -- --server "$SERVER"
  ```

- **Supprimer les doublons déjà en base.** Créés avant l'identifiant
  d'installation, ils ne se résorbent pas seuls. Depuis la console, cases à
  cocher puis Delete.

## 3. Ce qui rend les ordres pénibles à l'usage

- [x] **Latence ramenée de cinq minutes à une.** Le battement est le plus petit
      et le plus fréquent des appels d'un agent ; il rapporte désormais si
      quelque chose attend, et l'agent va le chercher aussitôt au lieu d'à son
      prochain rafraîchissement. Sa période passe à 60 s — exactement la cadence
      pour laquelle la limite d'écriture de `last_seen_at` était déjà réglée.
      Le relais bat sur le même rythme et ne recharge l'assignation qu'à
      `refresh_s`, ou plus tôt si un ordre attend pour lui ou pour sa zone.
      Mesuré sur la VM ubuntu, sans rien redémarrer : **46 s** de bout en bout.

- [x] **Le premier battement d'un relais arrive à +60 s.** Sa boucle saute
      toujours son premier tick, mais ce tick dure maintenant une minute au lieu
      de cinq. Le battement et le chargement de l'assignation sont deux choses
      sur deux périodes, ce qui était le fond du problème.

- [x] **Une seule liste, dans `@tern/shared`.** Il y en avait trois — la
      colonne, le schéma de la route, le type du web — et elles ont dérivé : la
      base connaissait `ui-on`, la route non, d'où un 400 nommant cinq genres
      qu'elle n'avait jamais entendus. Toutes dérivent maintenant de
      `AGENT_COMMAND_KINDS`. Prouvé en ajoutant un genre au seul endroit : le
      compilateur exige aussitôt son libellé ailleurs.
      Au passage, la migration `0026` a révélé que mon édition manuelle du SQL
      de `0025` n'avait pas mis à jour l'instantané — une base neuve aurait
      échoué. Elle est donc en `ADD VALUE IF NOT EXISTS`, et les deux chemins
      sont vérifiés : base existante, et base vierge montée puis supprimée.

## 4. Documentation — écrite

Tout est dans `docs/admin-guide.md`, sous « The agents », en trois sections
nouvelles : **Its own page**, **Asking a machine to do something**, **Updating
an agent**. Vérifié dans le navigateur : les trois figurent dans la navigation
latérale et leurs ancres résolvent.

- [x] Les ordres depuis la console, avec le tableau de ce que chacun fait, les
      trois états du fil (en attente / pris sans réponse / fait) et pourquoi un
      ordre n'est jamais rejoué.
- [x] Ce que « pause » et « stop » veulent dire l'un par rapport à l'autre — ils
      ne diffèrent que par ce qui continue d'écouter — et qu'un relais arrêté
      sert toujours sa zone.
- [x] `tern-agent resume`, nommé comme la seule porte de sortie d'un stop.
- [x] La page du relais et celle de l'agent : `--listen`, le mot de passe montré
      une fois, l'avertissement hors loopback, le formulaire à un champ.
- [x] Le chemin de mise à jour — relancer l'installeur sans `--pin` — et
      l'identifiant d'installation, avec la raison pour laquelle il ne dérive de
      rien de l'hôte.

## 5. Plus ancien, toujours ouvert

- [x] **Le relais dit quand son cycle se passe bien.** Il ne parlait qu'en cas
      d'échec, si bien qu'un relais qui travaillait et un relais dont la boucle
      s'était arrêtée avaient exactement le même journal — le silence. Deux
      lignes en `debug` : le battement, et la déclaration de zone avec le nombre
      de machines. En `debug` et pas en `info`, parce qu'une ligne par minute
      disant que l'ordinaire a eu lieu, au niveau que les gens lisent, est un
      journal qu'on cesse de lire.
      Vérifié sur rocky : rien au niveau par défaut, et les deux lignes
      présentes avec `RUST_LOG=debug` — `declared the zone upstream agents=1`.

## Fait dans cette session (pour mémoire)

Le mot de passe de la page se réinitialise désormais depuis la console — c'était
au backlog depuis longtemps et attendait « un canal serveur→agent à concevoir ».
L'ordre `ui-on` est ce canal.

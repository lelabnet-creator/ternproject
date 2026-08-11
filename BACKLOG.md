# Backlog — validation de bout en bout, sur trois machines réelles

Mission confiée en autonomie : déployer les trois rôles sur les trois VM du
banc, vérifier les battements, exercer **tous** les genres de contrôle par
l'agent, corriger ce qui se révèle défectueux (récupération des jobs, erreurs,
logs), et en tirer un **Tutoriel** pédagogique. À la fin, l'application
fonctionne de bout en bout, preuves à l'appui.

## Le banc

| Machine           | Rôle                            | Accès                                                         |
| ----------------- | ------------------------------- | ------------------------------------------------------------- |
| ubuntu (ssh 2231) | agent direct                    | `.vm-lab/lab.py` : `boot`, `ssh`, `lan_address`, `screenshot` |
| rocky (ssh 2232)  | relais (proxy)                  | idem                                                          |
| arch (ssh 2233)   | agent derrière le relais, isolé | idem + `zone-firewall.sh`                                     |

- Instance offerte : `http://localhost:28999/` (tenant `crisislab`) — depuis les
  VM : `http://<IP-LAN-hôte>:28999`. Si aucun accès admin n'est possible,
  utiliser `tern-lab2` (28994) ou provisionner une instance neuve — le choix et
  sa raison vont dans le bilan.
- Le relais de Jacques sur `192.168.1.170:38787` existe : **ne pas y toucher**.
  Le relais du banc vit sur rocky, port 38787 de _sa_ propre adresse.
- Tout passe par l'API (l'UI consomme la même). Traces dans
  `deploy-tests/e2e-2026-08-11/` : logs, captures, `resultats.json`.

## À faire

- [x] **1. Accès et socle.** Un cookie admin qui fonctionne sur l'instance
      choisie ; l'instance joignable depuis le LAN ; l'IP LAN de l'hôte établie
      et notée. Trace : la réponse d'`instance.json` et du login.

      Fait. Instance de **dev** (API `http://192.168.1.144:3011`, tenant `acme`),
      pas 28999 qui est la prod de Jacques ni 28994 dont le login est cassé.
      Login `admin@acme.example` / `tern-demo-password` (seed du dépôt) → HTTP
      200. IP hôte pour le banc = `192.168.1.144` (bridge br0) ; `.170` porte le
      relais de prod à ne pas toucher. `install.sh` servi en HTTP 200. Trace :
      `deploy-tests/e2e-2026-08-11/01-socle.txt`.

- [x] **2. Les trois VM debout.** `boot` des trois, SSH répond, adresse LAN
      obtenue pour chacune. Trace : `uname -a` et `ip -4 addr` des trois.

      Fait. ubuntu `192.168.1.112` (6.8), rocky `192.168.1.157` (5.14 el9),
      arch `192.168.1.106` (7.1). SSH OK sur 2231/2232/2233. ubuntu et rocky
      joignent l'instance (`instance.json` HTTP 200). Trace :
      `deploy-tests/e2e-2026-08-11/02-vms.txt`.

- [ ] **3. Les trois déploiements.** Agent sur ubuntu (PIN admin → install.sh) ;
      relais sur rocky (`--proxy`, port 38787) ; agent sur arch **isolé**
      (pare-feu bloquant l'instance, install via le relais uniquement). Les
      trois enregistrés en service et démarrés. Vérifier au passage ce que la
      0.1.25 a corrigé : la clé écrite dans un `agent.toml` existant, le
      récapitulatif final, `--force`.

      Fait, et **trois corrections vues en production réelle** : sur ubuntu,
      « Updated /home/tern/.config/tern/agent.toml with the new key » (le fix du
      401 — `doctor` confirme « credential accepté pour tenant acme ») ; le
      cadre d'instructions du relais affiche la bonne adresse
      `192.168.1.157:38787` ; le récapitulatif final encadré « Running now, and
      again after a reboot » sur les trois. Agent ubuntu et relais rocky
      vivants ; agent arch **isolé** (REJECT vers l'instance, HTTP 000)
      installé via le relais uniquement et rattaché à sa zone
      (`parent=27a71778…`). Binaires musl reconstruits depuis le code courant et
      servis par l'API. Traces : `03-*.txt`.

- [x] **4. Trois battements.** Les trois lignes vivantes dans `GET /agents` —
      l'agent, le relais (heartbeat propre depuis ce cycle), et l'agent de zone
      remonté par la déclaration du relais. Trace : la réponse API et les logs
      de chaque machine (`journalctl`).

      Fait. Les trois vivants à <2 min : ubuntu (agent direct), tern-proxy
      (relais — heartbeat ajouté ce cycle), arch (agent de zone, remonté par la
      déclaration du relais). Constat pour le point 6 : `refresh_s=300` fait que
      la zone n'est déclarée que toutes les 5 min, d'où une latence d'apparition
      d'un agent de zone pouvant atteindre 5 min. Trace :
      `deploy-tests/e2e-2026-08-11/04-heartbeats.txt`.

- [ ] **5. Tous les genres de contrôle, par l'agent.** Créer via API un contrôle
      par genre — http, tcp, ping, dns, cert, websocket, docker, file,
      directory, uptime, plus un push nourri par script. Cibles locales au banc
      autant que possible (pas de dépendance à l'extérieur). Assignés à l'agent
      ubuntu. Vérifier que chaque genre produit des points en base via l'API
      (`uptime.json`, liste des contrôles, derniers checks) et que les verdicts
      sont plausibles (un `file` absent doit échouer, un `tcp` ouvert réussir…).

- [ ] **6. Analyse : jobs, erreurs, logs.** Lire les vrais logs des trois rôles.
      Examiner : la récupération de la liste des jobs par l'agent (cadence,
      erreurs réseau, 401, changement d'assignation), la gestion d'erreur
      (messages actionnables ? silences ?), la qualité des logs (niveau, bruit,
      corrélation). Corriger ce qui est défectueux — chaque correction commitée
      seule avec sa preuve. Ne pas améliorer pour améliorer : corriger ce que
      les tests réels ont montré cassé ou trompeur.

- [ ] **7. Le Tutoriel.** `docs/tutorial.md` — du zéro à une page qui monitore,
      dans l'ordre vécu : instance, premier agent, relais, agent isolé, premiers
      contrôles, lecture de la page. Avec les vraies sorties de terminal et
      captures (`screenshot`) prises pendant les points 2–5. Pédagogique :
      chaque étape dit ce qu'on voit et pourquoi. Régénérer le rendu
      (`pnpm docs:build`).

- [ ] **8. Bilan.** `deploy-tests/e2e-2026-08-11/resultats.json` + un
      `RESTITUTION.md` : ce qui marche, ce qui a été corrigé (commits), les
      hypothèses prises, ce qui reste. L'application fonctionne de bout en
      bout ou le bilan dit précisément où elle ne le fait pas.

## Consigne de Jacques (2026-08-11)

Regrouper les corrections de code pour **minimiser** les compilations et les
appels à la CI GitHub. En pratique : accumuler les correctifs, un seul
`cargo build`/`pnpm build` par lot, et ne **pousser** (donc ne déclencher la CI)
qu'une fois en fin de mission — pas à chaque point. Les commits locaux par point
restent, seul le push est différé.

## Règles de la boucle

- Un point à la fois, dans l'ordre, entièrement. Pas de pause longue entre
  les tâches ; enchaîner tant que le point n'est pas prouvé.
- Toute affirmation « ça marche » s'appuie sur une commande réellement exécutée
  et sa sortie conservée dans `deploy-tests/e2e-2026-08-11/`.
- Vérification avant de cocher : `pnpm typecheck`, `lint`, `format`, `test` ;
  et pour l'agent `cargo test`, `cargo fmt --check`,
  `cargo clippy -- -D warnings`. `pnpm format` après la dernière édition.
- Commiter chaque correction seule, **en nommant les chemins**, jamais
  `git add -A` ni un répertoire ; inspecter les hunks des fichiers partagés.
- Ne pas toucher au relais de Jacques (`192.168.1.170:38787`) ni à sa config.
- Si un point repose sur une prémisse fausse (VM qui ne boote pas, bridge
  absent, pas d'accès admin), consigner, choisir le contournement le plus
  simple, le noter en hypothèse — n'arrêter la boucle que si plus rien n'est
  faisable.
- Quand les huit sont cochés : pousser, et la boucle s'arrête sur un rapport.

# Backlog

Deliberately out of scope for the first implementation. Recorded here rather than built, so the
milestone plan stays finishable.

## Deferred to a second iteration

- **SSO (OIDC / SAML)** — the stated requirement is local login plus MFA. The auth plugin keeps a
  provider seam so this can be added without reworking sessions.
- **SMS notifications** (Twilio, Vonage) — cost and per-country compliance make this a decision for
  the operator, not a default.
- **Geographic status maps** — the control group tree already models sites; a map is presentation.
- **Official client SDKs** (Go, Node, PHP, Python, Ruby) — the ten generated script templates and
  the Rust agent cover the same ground with less to maintain.
- **Multiple status pages per tenant** — per-control visibility already covers the public/internal
  split.
- **Custom email sending domain** with dedicated TLS certificates.
- **Free-form grid layout** — placing each component at an arbitrary x/y/width/height for a NOC
  wall. Shipped instead: three densities and an explicit order, which covers arranging a page
  without inventing a second layout model. The free grid needs per-breakpoint coordinates in the
  schema, a responsive strategy for what a hand-placed 4-column wall becomes on a phone, and a
  keyboard equivalent for free placement — dragging in two dimensions has no obvious arrow-key
  analogue, and the reordering screen deliberately never offers a move the keyboard cannot make.

- **Named metrics on the public page.** `metrics` is accepted at ingest, stored, reduced and drawn
  in the editor, but the public page still charts `value` — it reads the daily rollups, and the
  continuous aggregates do not roll up a JSONB map. Doing it properly means either promoting a
  tenant's chosen metrics to columns or adding a public series endpoint with its own caching, and
  neither is a change to make casually on the path every visitor hits.

## Not planned

- **Custom CSS / JavaScript injection.** status.io offers it; it is an XSS vector aimed at every
  visitor of the page. Branding through design tokens gives the same reach without handing out
  script execution.

## Not built yet

- **Hosting more than one status page per instance.** The schema is tenant-scoped everywhere and the
  API resolves a tenant per request, so the foundation is there — but no endpoint creates a tenant,
  and no screen manages a set of them. One instance serves the page provisioning made, and the
  README says so rather than implying otherwise. Building it means tenant CRUD, an owner model above
  the tenant, per-tenant domains, and a plan for what the system tenant supervises. That is a
  product, not a patch.

## Resolved

- **Unsubscribing did not work at all**, and the entry that used to sit here
  described the wrong half of it.

  The recorded defect was "`List-Unsubscribe` does not reach the wire", with the transporter
  singleton as the remaining suspect. That was a misreading. The header does reach the wire and
  always did: once the value runs long it folds onto a continuation line, so the header line really
  is bare and the URL really is on the next line. Any check that greps for lines starting `List-`
  reports a correctly folded header as an empty one. `transports.test.ts` now asserts on the whole
  header block for exactly this reason, and keeps a control case that would fail if the original
  claim were ever true.

  What was genuinely broken went unrecorded: the address the header and the message body both
  pointed at, `${PUBLIC_BASE_URL}/u/<ref>`, **matched no route**. Not in the API, and not in the
  SPA's path matching either — so it fell through to the catch-all and served the landing page. The
  note claiming the body link was "verified working end to end" was wrong; nobody could unsubscribe
  by any path.

  Now: one address, `/api/v1/unsubscribe/<ref>`, built in one place. A GET answers with a
  one-button page — a GET must not unsubscribe anyone, because mail clients and security appliances
  prefetch links. A POST unsubscribes, and accepts the urlencoded body an RFC 8058 provider sends,
  which the API spoke nowhere before. `List-Unsubscribe-Post` is now advertised, because the URL
  genuinely answers a POST.

## Open gaps — installer and its deployment recipe

Relevés pendant la campagne du 8 août 2026 sur trois distributions — Ubuntu
24.04, Rocky 9.8, Arch — qui passent désormais la recette de bout en bout,
redémarrage compris. Ce qui a été corrigé au même passage est dans l'historique
git ; ce qui suit est ce qui reste.

### Dans le crate de l'installateur

- [ ] **`clippy::pedantic` et `nursery` ne sont pas appliqués.** La CI passe
      `-D warnings` sur le jeu par défaut, qui est propre. Les jeux stricts
      remontent des avertissements tous stylistiques : `module_name_repetitions`
      (28) et `format!` ajouté à un `String` (10) en sont l'essentiel. Décider la
      barre, puis la tenir en CI — ou décider de ne pas la tenir, et l'écrire ici.
- [ ] **Deux fonctions dépassent 100 lignes** — `install_docker` et
      `build_and_start`. Les deux sont narratives par construction, et les deux
      sont signalées par `clippy::nursery`.
- [ ] **Dix `expect()` restent des chemins de panique.** Tous portent sur des
      invariants de compilation — un gabarit statique, un littéral d'un
      caractère — mais le profil release pose `panic = "abort"`, donc chacun est
      un abandon sans déroulement de pile. Acceptable tel qu'évalué ; consigné
      parce qu'une barre de sûreté (Ferrocene, ISO/IEC 5055 fiabilité) les compte.

### Ce que la campagne a sorti et que personne n'a chassé

- [ ] **Le repli « ASCII » de cliclack pour `└` est un tiret cadratin.**
      `Emoji("└", "—")` dans `cliclack/src/theme.rs` : le caractère de repli,
      quand la locale ne sait pas encoder l'Unicode, est U+2014 — qui n'est pas
      de l'ASCII non plus. Il atteint l'écran sur Arch, dont l'image cloud n'a
      pas de locale UTF-8. Le cadre que nous dessinons nous-mêmes est corrigé ;
      celui-ci est amont — surcharge du thème, ou correctif chez cliclack.
- [ ] **Dix U+FFFD dans la transcription Rocky.** Le caractère de remplacement,
      donc quelque chose dans le flux n'était pas de l'UTF-8 valide. Sans
      conséquence sur l'installation, qui a réussi, mais c'est soit de la sortie
      dnf que nous relayons, soit un défaut de décodage du harnais, et ni l'un ni
      l'autre n'a été identifié.

### Ce que l'écran dit et qui se lit de travers

- [ ] **« Waiting for `agent.toml` to appear » se lit comme une panne.** C'est
      l'état correct d'une instance dont le compte administrateur et la page
      n'existent pas encore, et c'est la première chose que le journal de l'agent
      affiche après une installation neuve. Le dire dans la ligne, ou le dire
      dans le panneau.

### Portée non couverte

- [ ] **Le TypeScript n'a jamais été audité.** Le travail sur la console n'a
      touché aucun fichier `.ts` : la conformité `typescript-eslint` stricte sur
      `apps/` est _non mesurée_, pas _atteinte_. Consigné pour que personne ne
      lise le rapport Rust comme couvrant le dépôt.

## À reprendre — passé de main le 8 août 2026

Consignées ici plutôt que perdues dans un fil de conversation. Les deux
premières sont faites ; ce qui reste tient à des accès, pas à du travail — et
tout tient au même : sans écriture par SSH, ni le registre, ni l'hôte de la
démonstration, ni le ménage des branches distantes n'avancent.

- [x] **Finir WebSocket et Docker comme genres de contrôle.** Fait. Les trois
      déclarations qui bloquaient — `CONTROL_KINDS` et `strictProbeSchema` dans
      `packages/shared/src/control-import.ts`, le `kind: z.enum([...])` de
      `apps/api/src/routes/controls.ts` — acceptent les deux genres, et l'API
      crée désormais ces contrôles. La route ne réécrit plus la liste : elle
      importe `CONTROL_KINDS`, puisque c'est précisément d'avoir épelé les mêmes
      six genres à trois endroits que venait la panne. Deux tests d'intégration
      couvrent la création, un test de fixture vérifie que le fichier d'exemple
      contient bien tous les genres déclarés, et un autre fige la décision de
      conception : une sonde WebSocket refuse un `send`, parce qu'elle n'envoie
      rien. Deux choses trouvées en chemin et corrigées : la migration `0017`
      n'avait jamais été appliquée, et `schemas/probe.schema.json` — le contrat
      entre l'implémentation TypeScript et l'agent Rust — ignorait les deux
      nouvelles sondes ; il est régénéré. Enfin, ce que le relevé annonçait et
      qui s'est révélé sans objet : `templates.ts` ne produit que des scripts
      push, et les libellés de genres sont en dur dans `AdminApp.tsx` comme ceux
      des six autres — il n'y avait donc ni modèle ni chaîne i18n à ajouter.

- [ ] **Déployer la démonstration sur `demo.qualif.tern-project.eu`.** L'image
      est construite, vérifiée en lecture seule et documentée
      (`docs/demo.md`, `docker/demo/compose.demo.yml`). Il manque deux accès :
      pousser `ghcr.io/lelabnet-creator/ternproject-demo:latest` au registre, et
      l'hôte lui-même. Le proxy devant doit terminer le nom, renvoyer sur
      `127.0.0.1:8088`, envoyer `X-Forwarded-For` et figurer dans
      `TRUSTED_PROXIES` — sans quoi chaque visiteur est journalisé, et limité en
      débit, comme étant le proxy.

- [x] **Intégrer `chore/console-demo-and-incidents`.** Fait, mais pas en
      `--ff-only` comme annoncé ici : `origin/main` avait avancé de son côté, si
      bien que la branche et `main` avaient réellement divergé. Une fusion
      ordinaire, donc, conforme à ce que fait le dépôt depuis toujours. À noter
      pour la prochaine fois : un commit de `main` et un de la branche
      portaient le même patch — un report — que git a réconcilié sans bruit
      parce que les deux côtés avaient le même contenu.

- [ ] **Réparer l'accès en écriture par SSH.** La clé présente est celle de
      `jacquesh82`, qui n'a pas le droit d'écriture sur le dépôt : `git push`
      répond `Permission denied`. `gh` est authentifié sous `lelabnet-creator`
      avec la portée `repo`, ce qui a permis de pousser par HTTPS — mais c'est un
      contournement, pas une configuration. Toujours vrai au 9 août : chaque
      push passe par l'URL HTTPS écrite à la main, et le remote configuré reste
      celui qui échoue.

- [x] **Supprimer les branches distantes fusionnées.** Fait : le distant ne
      porte plus que `main`, et les locales avaient déjà été supprimées. Les
      cinq pointes restent notées ici, parce qu'elles rendent l'opération
      réversible et ne coûtent qu'une ligne — `chore/console-demo-and-incidents`
      (`93349e9`), `feat/auth-and-local-agent` (`9620e23`),
      `feat/docker-install-and-first-run` (`3aae230`),
      `feat/mobile-shell-and-control-activity` (`b7a8f8d`),
      `feat/recovery-onboarding-brand` (`bb79e81`). Toutes vérifiées contenues
      dans `main` avant suppression : rien ne s'est perdu.

## Known limitations to revisit

- Per-tenant retention runs as an application job because TimescaleDB retention policies act per
  hypertable. The 740-day policy on `checks` is only a backstop.
- Seeding 90 days takes about two minutes; if that becomes a nuisance, switch the batched inserts
  to `COPY`.

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

## Tracked gaps — installer on a server console, 8 August 2026

Found while fixing the checklist and the yes/no on `TERM=linux`, and while answering "does the
stack come back after a reboot". Each was measured on a VM, on its real console, not reasoned
about — Ubuntu 24.04 first, then Rocky 9.8 and Arch, all three of which now pass the recipe end to
end including the reboot.

### Still open

- [ ] **`clippy::pedantic` and `nursery` are not enforced.** CI runs `-D warnings` on the default
      lint set, which is clean. The stricter sets report warnings that are all stylistic:
      `module_name_repetitions` (28) and `format!` appended to a `String` (10) are most of them.
      Decide the bar, then hold it in CI — or decide not to, and say so here.
- [ ] **Two functions exceed 100 lines** — `install_docker` and `build_and_start`. Both are
      narrative by design, and both are flagged by `clippy::nursery`.
- [ ] **Ten `expect()` sites remain panic paths.** All are compile-time invariants — a static
      template, a one-character literal — but the release profile sets `panic = "abort"`, so each
      is an abort with no unwinding. Acceptable as assessed; recorded because a safety-critical
      bar (Ferrocene, ISO/IEC 5055 reliability) counts them.
- [ ] **"Waiting for `agent.toml` to appear" reads as a failure.** It is the correct state for an
      instance whose admin account and page do not exist yet, and it is the first thing in the
      agent's log after a fresh install. Say why in the line, or say it in the panel.
- [ ] **The TypeScript side has never been audited.** The console work touched no `.ts` file, so
      `typescript-eslint` strict conformance across `apps/` is unmeasured rather than met. Recorded
      so nobody reads the Rust report as covering the repository.

### Found on Rocky and Arch, not yet chased

- [ ] **cliclack's own ASCII fallback for `└` is an em dash.** `Emoji("└", "—")` in
      `cliclack/src/theme.rs`: the character it falls back to when the locale cannot encode
      Unicode is U+2014, which is not ASCII either. It reaches the screen on Arch, whose cloud
      image has no UTF-8 locale — visible as `—` closing every prompt in the transcripts. Ours is
      the frame we draw ourselves, so this is upstream's; the options are a theme override or a
      patch to cliclack.
- [ ] **Ten U+FFFD in the Rocky transcript.** The replacement character, meaning something in the
      stream was not valid UTF-8. Harmless to the install, which passed, but it is either dnf
      output we relay or a decoding fault in the harness, and neither has been identified.

### Resolved by this pass

- [x] **Three checklist states that a console drew identically.** `✓`, `○` and the spinner are one
      substitution glyph on `TERM=linux`. State now travels on colour and weight — green, bold,
      grey — with an ASCII mark as reinforcement; the charset is decided from what the terminal
      declares, with `TERN_ASCII` as the escape hatch. Verified on the real console of all three
      distributions.
- [x] **A yes/no whose selection could not be read.** `● Yes / ○ No` became `[ Yes ]` in reverse
      video against a grey `No`: brackets, reverse and grey are three independent channels, and
      the brackets survive a screen with no attributes at all.
- [x] **The box frame was invisible on a console.** Painted in `\e[38;5;8m`, which the Linux
      console renders as near-black on black. `rule_for` now returns blue on a restricted charset,
      and `bar_color(Submit)` goes through it, so cliclack's gutter and the checklist's own frame
      cannot disagree. Confirmed on the Arch console, where the box is legible for the first time.
- [x] **Docker was not guaranteed to start with the machine, and the panel said it did.** The
      installer only ran `systemctl enable --now docker` when it had installed Docker itself.
      Measured three ways: service enabled, back in 20 s; service and socket disabled, nothing at
      all; service disabled and socket enabled, **worse** — nothing starts at boot and the whole
      stack springs up on the first Docker command anyone types, so it looks healthy to whoever
      logs in to investigate and stays down for everyone who only opens the page.
      `ensure_docker_at_boot` detects it, explains what it costs, and asks.
- [x] **The closing panel promised a restart it had not arranged.** The answer to that question is
      now carried to the panel, which has two wordings — one that claims the restart and one that
      says plainly it will not happen and gives the command. A test asserts only one of them can
      contain the promise.
- [x] **The deployment recipe never rebooted.** `.vm-lab/run.py` now reboots and requires `/health`
      to answer, and it does so **before any Docker command of the session** — without that
      ordering the test passes on socket activation and proves nothing. The reasoning is in the
      code, where it will be read.
- [x] **`—` and `…` in catalogue prose.** Both sit outside Latin-1, which is what a kernel console
      font carries. Replaced with `-` and `...` in every user-visible string, in both languages;
      the doc comments keep their typography. A test now walks the catalogues and fails on any
      character above U+00FF.
- [x] **No `#![forbid(unsafe_code)]`.** The crate had no `unsafe` and nothing kept it that way.
      It does now.
- [x] **No `rust-toolchain.toml`.** The musl target needed to build for a server lives in the
      rustup toolchain, not in a distribution's Rust; without a pin the cross build fails with
      "can't find crate for `core`", which sends the reader looking for a missing dependency.
      Pinned, with both musl targets and the two components CI uses.
- [x] **`#[must_use]` absent crate-wide.** Applied as one sweep through
      `clippy::must_use_candidate`, which is the only way it is worth doing — a half-annotated API
      is worse than an unannotated one.

## Known limitations to revisit

- Per-tenant retention runs as an application job because TimescaleDB retention policies act per
  hypertable. The 740-day policy on `checks` is only a backstop.
- Seeding 90 days takes about two minutes; if that becomes a nuisance, switch the batched inserts
  to `COPY`.

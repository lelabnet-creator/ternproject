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

## Known limitations to revisit

- Per-tenant retention runs as an application job because TimescaleDB retention policies act per
  hypertable. The 740-day policy on `checks` is only a backstop.
- Seeding 90 days takes about two minutes; if that becomes a nuisance, switch the batched inserts
  to `COPY`.

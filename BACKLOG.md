# Backlog

Deliberately out of scope for the first implementation. Recorded here rather than built, so the
milestone plan stays finishable.

## Deferred to a second iteration

- **SSO (OIDC / SAML)** — the stated requirement is local login plus MFA. The auth plugin keeps a
  provider seam so this can be added without reworking sessions.
- **Passkeys / WebAuthn / YubiKey** as a second factor alongside TOTP.
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

## Not planned

- **Custom CSS / JavaScript injection.** status.io offers it; on a multi-tenant instance it is an
  XSS vector aimed at every visitor of a tenant's page. Branding through design tokens gives the
  same reach without handing out script execution.

## Open defects

- **`List-Unsubscribe` header does not reach the wire.** Nodemailer generates it
  correctly when called directly — verified against MailHog over real SMTP with several value
  shapes — but the same `sendEmail` invoked from the notification worker produces mail without it.
  Ruled out: stale processes, a stale build, the value's length, the `list` option form, and the
  co-present `List-Unsubscribe-Post` header. Not yet ruled out: something in the long-lived
  transporter singleton.

  Mitigation in place, and deliberate: `List-Unsubscribe-Post` is **not** sent either. Advertising
  one-click unsubscribe without an address is worse than advertising neither — the mail client
  renders a button that silently does nothing. The unsubscribe link is in the message body and
  HTML, verified working end to end, and that is the path most readers use.

  Worth resolving before any deployment sending real volume: bulk senders increasingly require the
  header.

## Known limitations to revisit

- Per-tenant retention runs as an application job because TimescaleDB retention policies act per
  hypertable. The 740-day policy on `checks` is only a backstop.
- Seeding 90 days takes about two minutes; if that becomes a nuisance, switch the batched inserts
  to `COPY`.

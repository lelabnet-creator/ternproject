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

## Not planned

- **Custom CSS / JavaScript injection.** status.io offers it; on a multi-tenant instance it is an
  XSS vector aimed at every visitor of a tenant's page. Branding through design tokens gives the
  same reach without handing out script execution.

## Known limitations to revisit

- Per-tenant retention runs as an application job because TimescaleDB retention policies act per
  hypertable. The 740-day policy on `checks` is only a backstop.
- Seeding 90 days takes about two minutes; if that becomes a nuisance, switch the batched inserts
  to `COPY`.

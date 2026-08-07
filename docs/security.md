# Security model

What is protected, how, and — the more useful question — what an attacker gets
from each thing they manage to steal.

Reporting a vulnerability: [`SECURITY.md`](../SECURITY.md).

## Identities

| Identity      | Proves it with                           | Can do                                                      |
| ------------- | ---------------------------------------- | ----------------------------------------------------------- |
| User          | Password (Argon2id) + TOTP, or a passkey | Whatever their role allows, in tenants they are a member of |
| API key       | `Authorization: Bearer tern_…`           | Push measurements, within its control scope                 |
| Pairing code  | A short-lived PIN                        | Exchange itself for exactly one API key                     |
| Viewer device | A token from a QR code                   | Read one tenant's status. Nothing else                      |
| Receiver      | An opaque URL token                      | Post to one inbound webhook endpoint                        |

None of these can be used in place of another. An API key cannot read the admin;
a session cannot ingest.

## Roles

Three, mapping to permissions in `apps/api/src/rbac.ts` — the only place the
mapping exists.

| Role      | Holds                                                                  |
| --------- | ---------------------------------------------------------------------- |
| `visitor` | `status:read`, `history:read`, `subscribe`                             |
| `user`    | visitor, plus `status:read:all`, `incident:write`, `maintenance:write` |
| `admin`   | everything                                                             |

The shape worth noticing: a `user` can communicate during an incident but cannot
reconfigure what is monitored, add an agent, or read the audit log. That is the
role for the people who actually run the incident.

MFA is mandatory for admins. A session that has passed the password but not TOTP
carries `mfa_satisfied = false` and can do nothing except complete MFA.

## Passkeys

A passkey is an **additional** way into an account, never a replacement for its
password. `users.password_hash` stays mandatory, which is what keeps every
account recoverable through a channel that does not depend on a physical device.

A passkey sign-in issues a fully satisfied session even where the account has
TOTP enabled. That is deliberate: the gesture is already two factors — the
authenticator, plus the biometric or PIN it demands — and it is phishing
resistant in a way a typed code is not. A magic link would **not** get this
treatment, for the opposite reason: a mailbox is not a second factor.

Three consequences worth knowing before deploying:

- **Passkeys are bound to the hostname.** The RP ID comes from
  `PUBLIC_BASE_URL`. Move an instance from `status.example.com` to
  `status.example.net` and every registered passkey stops working there. This is
  the guarantee, not a defect — it is what stops a lookalike domain replaying
  one. The password and the emailed reset link are the way back in afterwards.
- **They need a secure context.** https, or http on `localhost`. An instance
  reached over plain http by IP will not offer them, and the interface hides the
  button rather than showing one that throws.
- **Nothing stored is secret.** A public key is public. A dump of
  `webauthn_credentials` yields nothing replayable — unlike a password hash,
  which at least invites cracking.

The signature counter is stored and moved forward, and a _decrease_ from a
non-zero counter is refused as a clone signal. It is not required to increase:
synced passkeys commonly report a constant `0`, and a strict rule would reject
every legitimate sign-in from one.

## What each stolen thing gets an attacker

This is the table worth reading.

| Stolen                                   | They get                                                        | They do not get                                                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| A session cookie                         | That user's role until it expires or is revoked                 | The password. There is **no** step-up re-authentication: a stolen admin session can do anything an admin can, until it is revoked |
| An **API key**                           | The ability to push measurements to the controls in its scope   | Any read of the admin, any other tenant, any history                                                                              |
| An `agent.toml`                          | The same as an API key                                          | Nothing more — it holds no session and no user identity                                                                           |
| A **proxy** config                       | The zone's upstream key, and hashes of the local keys it issued | The local keys themselves; a stolen proxy config cannot impersonate its agents                                                    |
| A **PIN**                                | One key, if used within its window before the intended agent    | Anything, once used or expired — five wrong guesses kill it                                                                       |
| A database dump **without** `APP_SECRET` | Structure, and measurements                                     | Subscriber addresses, webhook secrets, sessions — all encrypted or hashed with it                                                 |
| A database dump **with** `APP_SECRET`    | Everything except passwords                                     | Passwords remain Argon2id hashes                                                                                                  |

The consequence for operations: back up `APP_SECRET` separately from the dump,
and never in the same place.

## Storage of secrets

| Thing                   | How                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| Passwords               | Argon2id                                                                                                |
| Passkey public keys     | Stored as-is, base64url. Public by design; a signature cannot be forged from one                        |
| Session tokens          | SHA-256 of the token; the cookie holds the token                                                        |
| API keys                | SHA-256, plus a 12-character prefix so a key can be _identified_ in a list without being usable         |
| Pairing codes           | SHA-256                                                                                                 |
| Subscriber addresses    | AES-GCM with `APP_SECRET`, plus a blind index so "already subscribed?" is answerable without decrypting |
| Webhook signing secrets | AES-GCM                                                                                                 |
| Proxy-issued keys       | SHA-256, in the proxy's config                                                                          |

Every secret TERN generates is displayed **exactly once**. There is no "show
key" anywhere, because there is nothing to show.

## Tenant isolation

Enforced in the query layer, not by row-level security. Every tenant-scoped
route runs `app.requireTenant()`, which resolves `:slug` and checks membership,
then filters every query on `tenant_id`.

The honest statement of the trade: RLS would make isolation a property of the
database rather than of every query, and a missed `where` clause would fail
closed instead of leaking. It is not in place. What is in place instead:

- Every tenant-scoped route goes through the same guard, so the filter is not
  optional per handler.
- Cross-tenant access is tested explicitly — a control belonging to another
  tenant answers 404, and the layout, webhook and agent routes each have a test
  proving a foreign id is refused.
- Bulk operations validate **every** id before opening a transaction, so a
  rejected request cannot leave half the change applied.

## Choices that are easy to get wrong

**An unknown slug answers 404 rather than distinguishing cases.** Confirming
that a page exists is exactly what an attacker enumerating slugs wants.

**Pairing answers identically for wrong, expired and used-up codes.**
Distinguishing them tells a guesser which codes exist.

**Auto-registration is off by default.** A key with it enabled creates a control
for an unknown key; a typo on a fleet-wide key would otherwise put a new
component on a customer-facing page. Auto-created controls start internal.

**Probe dry-run never returns the response body.** Discovering a probe is
misconfigured during an outage is the worst possible moment, so the dry run
exists — but it must not become a way to read an internal endpoint through the
admin.

**Outbound webhook URLs are checked before they are saved.** Loopback, RFC 1918
and the cloud metadata address are refused: a webhook is a request this server
makes on an admin's behalf, which is the shape of an SSRF. This is not complete
— DNS can still resolve inward — and it is written down here rather than
implied.

**Webhook signatures cover `<timestamp>.<body>`.** Signing the body alone leaves
a captured payload replayable forever.

**No custom CSS or JavaScript injection**, ever. status.io offers it; it is an
XSS vector aimed at every visitor of the page, and the page is the thing people
open when they already suspect something is wrong. Branding goes through design
tokens, which reach as far without handing out script execution.

**Simulation data is flagged and excluded from every aggregate.** A demo can
never become a published SLA number — a correctness property that is also an
honesty one.

## The audit log

Sign-ins, pairings, revocations, control edits, layout changes, mail tests,
webhook changes. Actor, target, IP, and a JSONB `meta`.

Written on the same connection as the change it records, not queued: a change
that happened without a trail is worse than a change that failed.

## Transport

The Rust clients refuse plain HTTP for anything but localhost — pairing hands
over a long-lived credential, and a quick-start guide is exactly where that
mistake gets made. rustls rather than native TLS, so the binary drops onto a
host with no OpenSSL of the right vintage and simply runs.

## Supply chain

Dependencies are deliberately few, and each non-obvious one earns its place:
`@dnd-kit` for a keyboard-capable drag, `axum` for the proxy's server, `socket2`
for ICMP, `x509-parser` for certificate expiry. CI runs gitleaks on every push;
a secret has never been committed to this repository, and `.gitignore` blocks
`.env*` and `*.credentials`.

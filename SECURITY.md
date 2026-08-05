# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/lelabnet-creator/ternproject/security/advisories/new)
rather than opening a public issue. We aim to acknowledge within 72 hours.

Please include what you did, what happened, and what you expected — a working proof of concept
helps, but a clear description is enough to start.

## What TERN protects, and how

| Value                                                                     | At rest                                                           |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| User passwords                                                            | Argon2id (19 MiB, t=2, p=1)                                       |
| Session cookies, API keys, viewer tokens, pairing PINs, unsubscribe links | SHA-256 of a 256-bit random value — never stored in plaintext     |
| TOTP secrets, subscriber addresses, webhook secrets, probe auth headers   | AES-256-GCM under `APP_SECRET`                                    |
| Subscriber address lookup                                                 | HMAC blind index, so duplicates are detectable without decryption |

Notes on the design:

- **`APP_SECRET` is not recoverable.** Rotating it makes every encrypted value unreadable. Generate
  it once per deployment (`openssl rand -hex 32`) and back it up with your database.
- **Sessions are opaque and server-side**, not JWTs: revoking a viewer device or disabling an admin
  has to take effect immediately, and a stateless token cannot do that honestly.
- **A pairing PIN grants nothing on its own.** It can only be exchanged, once and within minutes,
  for an ingest-scoped API key.
- **Viewer sessions never map to a user account.** They carry a virtual read-only role.
- **Private tenants return 404, not 403**, so their existence is not disclosed.
- **`TRUSTED_PROXIES` is empty by default.** IP allowlists are only as good as the
  `X-Forwarded-For` handling behind them; trusting a header nobody sets is how they get bypassed.

## Supported versions

TERN is in early development. Until a 1.0 release, only `main` receives security fixes.

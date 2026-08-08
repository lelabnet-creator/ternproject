# The demonstration

`demo.qualif.tern-project.eu` is one container. It has no database beside it, no
volume, and nothing to back up: the image carries its own Postgres, already
seeded, and a restart puts it back exactly where it started.

## What a visitor gets

The seeded tenant is `acme` — twelve controls in five groups, ninety days of
history, incidents and maintenance windows, and the seven widget kinds on a
custom wall. It is the same seed a developer gets from `pnpm db:seed`, with one
difference: `TERN_DEMO=1`, which sets two columns on the tenant.

- **`isDemo`** walks an unauthenticated visitor straight into the admin. That is
  the point — the product can be looked at rather than described — and it is
  only defensible next to the second one.
- **`readOnly`** makes the API refuse every permission outside
  `READ_ONLY_PERMISSIONS`, for everyone, including a signed-in admin. The check
  sits in `apps/api/src/plugins/context.ts`, before the role is even resolved,
  because a check repeated at forty call sites is a check missing from the
  forty-first.

A demo visitor gets the role `demo`, whose permissions are an allowlist
(`apps/api/src/rbac.ts`). It deliberately stops short of subscriber addresses,
the audit trail's visitor IPs, the ingest key and the SMTP settings. Those
screens answer "insufficient permissions", which is the honest outcome: a demo
that leaks is not a demo.

## Three locks, not one

Read-only is asserted at three levels, and they fail independently:

| Level       | Mechanism                                            | What it stops                             |
| ----------- | ---------------------------------------------------- | ----------------------------------------- |
| Tenant      | `readOnly` enforced in `context.ts`                   | Every write, through any route or session |
| Filesystem  | `read_only: true`, cluster on a tmpfs                 | Anything the container writes to itself   |
| Time        | The image is the state; a restart discards the rest   | Drift, and anything the first two missed  |

The first is the real one. The other two are what make it hard to undo by
accident.

## Rebuilding it

```sh
scripts/demo-image.sh                 # build
scripts/demo-image.sh --run           # build, then serve it on :8088
scripts/demo-image.sh --days 30       # a smaller history for a smaller host
scripts/demo-image.sh --push          # build and push to the registry
```

The build runs the migrations and the seed **inside `docker build`**, so it
takes a few minutes and produces something that needs no database beside it.
It builds on top of the published application image rather than rebuilding the
sources — what a demo is for is showing the artefact people install.

### When to rebuild

Not on every commit. The ninety days the demo shows are the ninety days before
the build, so an image left alone for a season starts presenting a page whose
most recent incident is from last spring. That is a decision somebody makes by
looking at it. Rebuild when the product has moved somewhere a visitor would
notice, or when the history has drifted far enough to be distracting.

## Deploying it

```sh
docker compose -f docker/demo/compose.demo.yml up -d
```

The compose file publishes on `127.0.0.1:8088` only. TLS and the name belong to
the reverse proxy in front of it, which must:

- terminate `demo.qualif.tern-project.eu` and proxy to `127.0.0.1:8088`;
- send `X-Forwarded-For` and `X-Forwarded-Proto`, and appear in
  `TRUSTED_PROXIES` — otherwise every visitor is logged, and rate-limited, as
  the proxy;
- be the only route in. A demo also reachable by IP on `:8088` is a second
  address serving the same page, which is how a canonical URL stops being
  canonical.

`PUBLIC_BASE_URL` must be the external address. Everything the product generates
from it — the links in the page, the install snippets, the agent's idea of where
it reports — reuses it as it stands.

### Resetting it

```sh
docker restart tern-demo
```

That is the whole mechanism. There is no reset endpoint and no scheduled job,
because there is no state to reset: the container copies a pristine cluster out
of the image at boot and works on a tmpfs from then on.

## What the image costs

The seeded cluster lives in RAM while the container runs — a tmpfs sized at 1 GB
in the compose file. Ninety days of twelve controls at one sample per five
minutes is roughly 311k rows in `checks`, plus the continuous aggregates. If the
host is small, reduce the history (`--days 30`) rather than the tmpfs: a tmpfs
that fills up looks exactly like a corrupt database.

## The secret

The image contains an `APP_SECRET`, generated at build time, because the seed
encrypts with it — probe authentication headers, TOTP secrets, subscriber
addresses. Regenerating it at boot would leave every one of those unreadable.

It protects nothing: the whole database is public by construction and is thrown
away on restart. It must not be reused anywhere that is not this demo.

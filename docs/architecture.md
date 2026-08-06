# Architecture

## The pieces

```
                         ┌──────────────────────────────────┐
   browser ──────────────│  apps/web    Vite + React 19      │
   (public + admin)      │  public page · admin · PWA        │
                         └───────────────┬──────────────────┘
                                         │ HTTP, same origin
                         ┌───────────────┴──────────────────┐
   agents ───────────────│  apps/api    Fastify 5 + Zod      │
   scripts ──────────────│  auth · RBAC · ingest · probes    │
   webhooks ─────────────│  notifications · feeds            │
                         └───────────────┬──────────────────┘
                                         │
                         ┌───────────────┴──────────────────┐
                         │  PostgreSQL + TimescaleDB         │
                         │  hypertable + continuous aggs     │
                         └──────────────────────────────────┘

   clients/agent    Rust: tern-agent (probes) and tern-proxy (relay)
   packages/shared  Zod contracts, probe spec, script templates, sizing
   packages/db      Drizzle schema, migrations, seed
```

One process serves the API. The web app is static files. There is no message
broker, no cache tier and no worker fleet — the scheduled work runs as a plugin
inside the API process (`apps/api/src/plugins/jobs.ts`), and TimescaleDB does
the aggregation that would otherwise need one.

That is a deliberate ceiling, not an oversight: it is the shape that a single
administrator can run, and the [operations page](./operations.md) says where it
stops being enough.

## Why these boundaries

**`packages/shared` holds contracts, not utilities.** Zod schemas, the probe
specification, the assertion engine, the script templates, the sizing
arithmetic. Everything in it is something both ends must agree about. It is
imported by the API, the web app, and — by contract rather than by compilation —
the Rust agent.

The barrel (`src/index.ts`) re-exports `crypto.ts`, which pulls in native
Argon2. Browser code must import subpaths (`@tern/shared/mock`,
`@tern/shared/status`) instead; importing the barrel from the web app breaks the
dev server with an esbuild error about a WASM package, which is a confusing way
to learn this.

**The assertion engine is implemented twice**, in TypeScript and in Rust, and
neither imports the other. Both replay `schemas/conformance/*.json`. That suite
is the contract — see [probes](./probes.md).

**The web app owns no business rules.** It renders what the API returns. The one
thing it holds alone is the widget registry (`apps/web/src/charts/registry.ts`),
because it maps to React components; the _payload shape_ each widget implies
lives in `packages/shared` so the API can generate matching scripts.

## How a measurement travels

1. **Something measures.** An agent running a probe, a generated script, or a
   third-party system posting to a receiver endpoint.
2. **`POST /api/v1/ingest`** authenticates the API key, resolves control keys to
   ids within that key's scope, clamps the timestamp, and inserts rows into
   `checks`.
3. **TimescaleDB aggregates.** Continuous aggregate policies roll `checks` into
   `checks_1m`, `checks_5m` and `checks_1h`. Rows flagged `synthetic` are
   excluded, so simulation data can never become a published uptime figure.
4. **The public page reads the aggregates** through
   `/api/v1/public/:slug/summary.json` and `/uptime.json`, both cacheable.
5. **The admin reads raw points** through `/api/v1/:slug/controls/:id/series`,
   which includes synthetic rows — it is the only path that can show a
   simulation.

## How a request is authorised

Three separate credentials, deliberately not interchangeable:

| Caller                | Credential                          | Where it is checked                |
| --------------------- | ----------------------------------- | ---------------------------------- |
| A person in the admin | Session cookie, opaque, server-side | `apps/api/src/plugins/context.ts`  |
| An agent or script    | `Authorization: Bearer tern_…`      | `apps/api/src/services/apikeys.ts` |
| A viewer device (QR)  | Viewer token, read-only             | `viewerTokens` / `viewerDevices`   |

Route-level guards are `app.requireTenant()` (resolves `:slug` and checks
membership) followed by `app.requirePermission(...)`. The permission list is in
`apps/api/src/rbac.ts`; roles map to sets of permissions there and nowhere else.

## The scheduled work

`apps/api/src/plugins/jobs.ts` runs inside the API process:

- **Staleness sweep** — controls with an `expectedIntervalS` that have not
  reported within it are marked `unknown`. Without this a control that stops
  pushing looks healthy forever.
- **Notification delivery** — pending rows in `notifications` are delivered to
  subscribers and outbound webhooks, with retries.
- **Retention** — per-tenant deletion of raw points older than the tenant's
  `retentionDays`. TimescaleDB's own retention policy acts per hypertable, so it
  is only a 740-day backstop.
- **Aggregate refresh** on demand after a simulation, so the editor does not
  show an empty chart for two minutes.

If the API process is not running, none of this happens — including the
staleness sweep, which means a status page left up by a dead API shows the last
state it knew. The `/health` endpoint exists to be watched by something else.

## The Rust clients

`clients/agent` builds two binaries from one crate, so the two ends of the same
protocol cannot drift:

- **`tern-agent`** pairs, receives its probes from the server, runs them on a
  schedule, and pushes results. It buffers on disk when the server is
  unreachable.
- **`tern-proxy`** relays for a network with no egress. It serves the _same_
  API endpoints, so an agent cannot tell the difference. See
  [data exchange](./data-exchange.md#the-proxy).

## The platform surface

One tenant may carry `is_system`. Its admins reach `/app/system/platform` and
`/api/v1/system/*`, which report load per tenant and whether the shared
machinery is keeping up — the aggregates, the notification queue, mail, agents
reporting.

A flag rather than a reserved slug: a magic string would let a customer signing
up as `system` inherit the instance by typing. Non-members get **404**, not 403;
probing the path should not reveal that the surface exists.

It is deliberately supervision only. No incidents, no subscribers, no
measurements — an operator able to read every customer's incident history has an
access level nobody agreed to, and an integration test asserts the response
shape so that does not drift.

## Where the frontend state lives

TanStack Query owns everything fetched. There is no client-side store and no
router library: `apps/web/src/main.tsx` matches the path to one of two roots
(`/s/:slug` public, `/app/:slug` admin) and the admin's sections use
`pushState` + `popstate` directly. That was a size judgement, and the comment in
`main.tsx` says a router goes in when nested routes justify it.

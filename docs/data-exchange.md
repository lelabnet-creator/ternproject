# Data exchange

Every way data enters or leaves TERN. Paths are as mounted; the API is served
under `/api/v1`.

## Ingestion

### `POST /api/v1/ingest`

The hot path. Authenticated with an ingest-scoped API key.

```http
POST /api/v1/ingest
Authorization: Bearer tern_…
Content-Type: application/json

{ "controlKey": "api-gateway", "status": "operational", "latencyMs": 142 }
```

A single object or an array of up to 500. Fields:

| Field        | Required | Notes                                                                     |
| ------------ | -------- | ------------------------------------------------------------------------- |
| `controlKey` | yes      | Resolved within the key's scope                                           |
| `status`     | no*      | One of the six statuses                                                   |
| `latencyMs`  | no       | Integer, 0 … 3 600 000                                                    |
| `value`      | no*      | A measurement                                                             |
| `metrics`    | no*      | `{ name: number }`, ≤ 25 entries, names match `^[a-zA-Z][a-zA-Z0-9_.-]*$` |
| `message`    | no       | ≤ 2000 characters                                                         |
| `ts`         | no       | ISO 8601. Defaults to arrival, and is clamped                             |
| `meta`       | no       | Free-form JSON, not charted                                               |

\* At least one of `status`, `value` or `metrics` must be present. A point
carrying none of them says nothing, and storing it as `operational` would invent
a claim nobody made. When only a measurement is sent, `status` defaults to
`operational` — receiving the number _is_ the evidence that the thing is
reporting.

The response names what it could not accept rather than failing the batch:

```json
{
  "accepted": 4,
  "rejected": [{ "controlKey": "typo", "reason": "unknown or out-of-scope control" }]
}
```

Rate limited per `Authorization` header — `INGEST_RATE_LIMIT_MAX`, default 600 a
minute. The admin's Capacity screen computes what a given fleet needs.

### `POST /api/v1/heartbeat/:controlKey`

The simplest possible client: no body, no JSON, no dependency.

```sh
curl -XPOST https://status.example.com/api/v1/heartbeat/nightly-backup \
     -H 'Authorization: Bearer tern_…'
```

Optional query parameters `status`, `latencyMs`, `value`, `message` cover
reporting a failure without a different endpoint.

### Receivers — inbound webhooks

`POST /api/v1/receivers/:id/:token` accepts a payload from Alertmanager, Grafana,
UptimeRobot, Zabbix, PagerDuty, Healthchecks, or a generic shape, and normalises
it into checks — optionally opening and closing incidents from the source's
resolved flag. The mapping is stored per receiver.

## The agent protocol

Pairing, the assignment poll, the heartbeat, the instruction channel, the
relay and its zone, the version header, the error format and the DEV trace
all live on their own page now: [The agent protocol](./protocol.md). The exact
message shapes are defined once in `packages/shared/src/agent-protocol.ts`
and exported under `schemas/agent-protocol/`.

What remains here is everything that is not agent-shaped: the ingest surface
above (shared by agents and hand-written clients), receivers, the read
endpoints, and what leaves.

## Reading

### Public, cacheable

| Endpoint                                          | Contents                                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/public/:slug/summary.json`           | Tenant, overall status, groups, components, open incidents and maintenances. `cache-control: public, max-age=5, stale-while-revalidate=30` |
| `GET /api/v1/public/:slug/uptime.json?period=90d` | Daily uptime per control, from the aggregates                                                                                              |
| `GET /badge/:slug.svg`                            | A status badge for the page as a whole — the worst status across every public control                                                      |
| `GET /badge/:slug/:key.svg`                       | A status badge for one control                                                                                                             |
| `GET /api/v1/public/:slug/feed.rss` / `.atom`     | Incident history                                                                                                                           |

All of these are readable without authentication — a status page is public.

#### Badge styles

Both badge routes take `?style=` and `?label=`. A control badge defaults its
label to the control's name; the page badge defaults to `status`.

| `style`       | Shape                                                                         |
| ------------- | ----------------------------------------------------------------------------- |
| `flat`        | The shields.io two-part pill. The default.                                    |
| `plastic`     | The same pill with a gloss.                                                   |
| `circle`      | A status dot with the word beside it, compact enough to sit inside a sentence |
| `alert-block` | A callout with a coloured rule, for the top of a page or a docs section       |
| `status-bar`  | A strip that spans a column, with the state in a chip on the right            |

Every style spells the status out in words as well as colour, and carries it in
`role="img"` plus a `<title>`, so none of them depends on the reader
distinguishing green from red. The list lives in `@tern/shared/badges` and is
read by both the renderer and the admin screen that offers them.

Badges are cached for 60s with `stale-while-revalidate=300`, so a CDN or
GitHub's camo proxy keeps serving the last render rather than a broken image
while it refreshes. A badge for a control that does not exist — or that the
caller may not see — renders as `no data` rather than 404, for the same reason.

### Admin, authenticated

| Endpoint                                 | Contents                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /:slug/controls`                    | Every control, including internal ones                                                            |
| `GET /:slug/controls/:id/series?days=30` | Raw points, downsampled, **including simulation data** — the only path that can show a simulation |
| `GET /:slug/controls/:id/scripts`        | The ten generated scripts plus the agent config                                                   |
| `GET /:slug/agents`                      | The fleet, with per-agent job counts and key scope                                                |
| `GET /:slug/capacity`                    | Effective HTTP limits beside what this fleet needs                                                |
| `POST /:slug/probe/run`                  | Runs a probe once and reports what each assertion saw, without saving it                          |

The series endpoint downsamples **worst-case**: the worst status and the slowest
latency in each bucket survive, because a five-minute outage inside an hour must
still be visible. Measurements are the exception and are averaged — a queue
depth is a level, and taking its maximum would draw spikes that never happened.

## Leaving

### Outbound webhooks

Every incident and maintenance update is POSTed to each webhook subscriber,
signed:

```http
POST /your/endpoint
X-Tern-Timestamp: 1767225600
X-Tern-Signature: sha256=…
```

The signature covers `<timestamp>.<body>`, and the timestamp travels in its own
header so a receiver can reject anything older than a few minutes. Signing the
body alone leaves a captured payload replayable forever.

Endpoints on loopback, the RFC 1918 ranges and the cloud metadata address are
refused when added: a webhook URL is a request this server makes on an admin's
behalf.

### Email

Sent through the SMTP configured for the deployment. Double opt-in for
self-service subscribers; the unsubscribe link is in the body.

Every notification carries `List-Unsubscribe` and `List-Unsubscribe-Post`, so a
mail client's own unsubscribe button works and bulk senders that now require
one-click are satisfied. Both point at
`GET|POST /api/v1/unsubscribe/<ref>` — a GET answers a one-button page and a
POST does the work, because mail clients prefetch links and a GET that
unsubscribed would remove readers who never clicked.

This entry used to record the header as broken. It was not: once the value runs
long it folds onto a continuation line, and a check that greps for lines
beginning `List-` reads a correctly folded header as an empty one. What _was_
broken was the address it pointed at. See `BACKLOG.md`.

## Generated scripts

`GET /:slug/controls/:id/scripts` returns the same push in ten languages —
Python, PowerShell, Bash, Go, Node.js, Ruby, PHP, Perl, C#, Lua — plus the Rust
agent's `agent.toml`.

The **widget chosen for the control decides the payload**. A control drawn as a
measurement gets a script that measures and sends `value`; one drawn as a state
gets a script that times a check and classifies it against the control's
thresholds. They cannot disagree, because both the editor's preview and the
generator read the same map in `packages/shared`.

Every script reads `TERN_API_KEY` from the environment first, so the file itself
is safe to commit.

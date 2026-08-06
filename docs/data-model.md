# Data model

Defined in `packages/db/src/schema/`, one file per area, with Drizzle. Migrations
are generated (`pnpm --filter @tern/db generate`) and applied
(`pnpm --filter @tern/db migrate`); the TimescaleDB objects that Drizzle cannot
express live in `packages/db/sql/0001_timescale.sql` and are applied by the same
command, idempotently.

Every table with tenant data carries `tenant_id` and cascades from `tenants`.
There is no row-level security: isolation is enforced in the query layer, by
route guards that resolve `:slug` to a tenant and filter on it. That is a
deliberate trade — see [security](./security.md#tenant-isolation).

## The shape at a glance

```
tenants ─┬─ control_groups ──┬─ controls ─── checks (hypertable)
         │                   │                 └─ checks_1m / _5m / _1h (aggregates)
         ├─ memberships ── users ── sessions
         ├─ api_keys ── agents ── pairing_codes
         ├─ incidents ── incident_updates / incident_impacts
         ├─ maintenances ── maintenance_updates / maintenance_controls
         ├─ subscribers · notifications · receivers · templates
         ├─ viewer_tokens ── viewer_devices
         ├─ ip_allowlist · domains
         └─ audit_log
```

## Tenancy

### `tenants`

One client, one status page. The columns that change behaviour rather than
appearance:

| Column                | Why it exists                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `visibility`          | `public` or `private`. A private tenant answers 404 rather than 403 — a 403 confirms the page exists                   |
| `retention_mode`      | `live` or `historical`. Decides whether the page streams current state or draws history, and which widgets are offered |
| `raw_retention_hours` | Raw points kept in `live` mode. Default 168 (7 days)                                                                   |
| `retention_days`      | History kept in `historical` mode. 7 → 730                                                                             |
| `rollups_enabled`     | Whether the continuous aggregates are read at all                                                                      |
| `layout`              | `list`, `grid` or `compact` — the public page's density                                                                |
| `branding`            | Design-token overrides. Not CSS: see [security](./security.md)                                                         |

`domains` holds custom hostnames with their verification token and certificate
state. `ip_allowlist` restricts who may read a private page.

## Monitoring

### `control_groups`

A tree (`parent_id` self-reference). `status_rollup` decides how a group's status
is computed from its children: `worst` (default), `majority`, or `manual`.

### `controls`

One thing being monitored.

| Column                                        | Notes                                                                                                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`                                         | Stable identifier used in URLs, scripts and alert labels. Constrained to `^[a-z0-9][a-z0-9._-]*$` — a space or quote in any of those places is a bug somewhere |
| `kind`                                        | `push` (fed by a script) or `http`/`tcp`/`ping`/`dns`/`cert` (a probe)                                                                                         |
| `config`                                      | The probe definition when `kind` is not `push`. Validated against `probeSchema`                                                                                |
| `expected_interval_s`                         | Silence longer than this makes the control `unknown`                                                                                                           |
| `degraded_threshold_ms` / `down_threshold_ms` | Latency classification. The first must be below the second, or the degraded state is unreachable                                                               |
| `value_unit` / `value_label`                  | What a measurement means, when the control reports one                                                                                                         |
| `widget` / `widget_options`                   | Which chart draws it. Resolved against the web app's registry; an unknown id falls back rather than throwing                                                   |
| `is_public`                                   | Internal controls never appear on the public page                                                                                                              |
| `position`                                    | Order on the public page, set from the layout screen                                                                                                           |

`(tenant_id, key)` is unique. A duplicate is reported as a conflict, not as a
constraint error.

### `checks` — the hypertable

Every measurement. Partitioned on `ts` by TimescaleDB.

| Column                | Notes                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ts`                  | Clamped on ingest: more than 5 minutes in the future becomes now, more than 7 days old becomes 7 days old. A machine with a broken clock would otherwise write into a chunk nobody queries |
| `status`              | `operational`, `degraded`, `partial`, `down`, `maintenance`, `unknown`                                                                                                                     |
| `latency_ms`, `value` | Have their own columns because the continuous aggregates roll them up                                                                                                                      |
| `metrics`             | Named numbers beyond those two. JSONB, bounded at 25 keys per point, names must start with a letter                                                                                        |
| `message`             | Cites the failing assertion, not "check failed"                                                                                                                                            |
| `synthetic`           | Marks simulation rows. **Excluded from every continuous aggregate**, so a demo can never become an SLA figure                                                                              |

Indexes: `(control_id, ts desc)` and `(tenant_id, ts desc)`.

### The aggregates

`checks_1m`, `checks_5m`, `checks_1h` are continuous aggregates with refresh
policies. They carry counts per status, latency percentiles via
`percentile_agg`, and value averages. `percentile_agg` comes from
`timescaledb_toolkit` — the plain `timescaledb` image does not have it, which is
why the compose file pins `timescaledb-ha`.

Compression after 1 day; a 740-day retention policy as a backstop under the
per-tenant retention job.

## Identity and access

### `users`, `memberships`, `sessions`

Passwords are Argon2id. `memberships` maps a user to a tenant with a role —
`admin`, `user`, `visitor` — and roles map to permissions in
`apps/api/src/rbac.ts`, which is the only place that mapping exists.

Sessions are opaque server-side rows; the cookie holds a token whose SHA-256 is
`token_hash`. `mfa_satisfied` distinguishes a session that has passed TOTP from
one that has only passed a password — the second can do nothing but complete MFA.

### `api_keys`

| Column              | Notes                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `key_hash`          | SHA-256. The key itself is returned once, at creation, and is unrecoverable                                                        |
| `key_prefix`        | First 12 characters, so a key can be _identified_ in a list without being usable                                                   |
| `scopes`            | `ingest`, `read`                                                                                                                   |
| `scope_control_ids` | Empty means every control. This is what the fleet screen reads to say whether an agent already covers a control                    |
| `auto_register`     | Whether an unknown control key creates a control. Off by default: a typo would otherwise add a component to a customer-facing page |

### `pairing_codes` and `agents`

A PIN is `code_hash` plus an expiry, a use count and a failed-attempt count.
Five wrong guesses kill it. `scope_control_ids` on the code becomes the agent's
assignment — that is the whole assignment mechanism, and no second one exists.

`agents` records what paired: hostname, OS, architecture, version, `site` (free
text, set in the fleet screen), `last_seen_at`, and the `api_key_id` it was
issued. Revoking an agent revokes that key in the same transaction; revoking the
record alone would be a revocation in name only.

### `viewer_tokens`, `viewer_devices`

Read-only mobile access granted by QR code. A viewer session can read one
tenant's status and nothing else.

## Communication

### `incidents`, `incident_updates`, `incident_impacts`

An incident has a severity and a status timeline; updates are append-only, so
the public history cannot be quietly rewritten. `incident_impacts` links it to
the controls affected and at what impact level.

### `maintenances`, `maintenance_updates`, `maintenance_controls`

Same shape, scheduled rather than reactive.

### `subscribers`, `notifications`

A subscriber has a `channel` (`email`, `webhook`, `slack`, `teams`) and:

- `address_enc` — encrypted. An admin cannot read their subscribers' email
  addresses; a compromised admin account does not hand over a customer list.
- `address_hash` — a blind index, so "is this address already subscribed" is
  answerable without decrypting anything.
- `webhook_secret_enc` — the signing secret, encrypted.
- `confirmed_at` — double opt-in for email. Webhooks added by an admin are
  confirmed on creation, because entering the URL _is_ the consent.

`notifications` is the outbound queue with a delivery status per row.

### `receivers`

**Inbound** webhooks: Alertmanager, Grafana, UptimeRobot, Zabbix, PagerDuty,
Healthchecks, or generic. Each has a token (hashed) and a `mapping` describing
how to turn that source's payload into a control key and status.

Not to be confused with outbound webhooks, which are subscribers.

### `templates`

Per-tenant message templates for incidents, maintenances and updates.

## `audit_log`

Every state change worth explaining afterwards: sign-ins, pairings, revocations,
control edits, layout changes, mail tests. Carries the actor (a user id, or a
label when there is no user — a pairing agent, for instance), the target, an IP,
and a JSONB `meta`.

It is written on the same connection as the change it records, not on a queue: a
change that happened without a trail is worse than a change that failed.

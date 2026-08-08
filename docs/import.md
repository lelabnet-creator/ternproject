# Importing controls from a file

The editor is the right way to build one control. It is the wrong way to build
forty. Someone migrating off another tool, or standing up a second environment,
already has the list — so TERN reads the list.

The file is YAML, it is applied on top of what already exists, and it is applied
as a unit: either every control in it lands, or none does.

Canonical schema: `packages/shared/src/control-import.ts`. The endpoint that
applies it: `apps/api/src/routes/controls-import.ts`.

## The endpoint

```
POST /api/v1/<tenant>/controls/import
```

Authenticated like every other control write: a session cookie, and the
`control:write` permission — which means an **admin** of the tenant. A user who
can post incident updates cannot reconfigure what is monitored.

The body is JSON, not a multipart upload; the admin app reads the file and sends
its text:

```json
{ "yaml": "version: 1\ncontrols:\n  - key: api\n    name: API\n", "dryRun": false }
```

`dryRun: true` validates the file, resolves the groups, reports exactly what
would change — and writes nothing. It takes the same code path as a real import
rather than a read-only imitation of it, because a preview computed by different
code is a preview that can disagree with the import.

A successful import answers:

```json
{
  "dryRun": false,
  "created": 12,
  "updated": 3,
  "groupsCreated": 2,
  "controls": [{ "key": "api", "action": "created" }]
}
```

## What the file looks like

```yaml
version: 1
controls:
  - key: api
    name: Public API
```

Two keys at the top level, and nothing else is accepted:

| Key        | Required | Notes                                                                     |
| ---------- | -------- | ------------------------------------------------------------------------- |
| `version`  | no       | Must be `1` when present. It exists so a later format can announce itself |
| `controls` | yes      | A list, at least one entry, at most 500                                   |

## A control

`key` and `name` are required. Everything else is optional, and **an omitted
field is left as it is** — see [Absent, null, and default](#absent-null-and-default).

| Field                 | Type                     | Accepted values                                                                       |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------- |
| `key`                 | string, 1–200            | Lowercase letters, digits, `.`, `-`, `_`; must start with a letter or a digit         |
| `name`                | string, 1–200            | Free text. What the public page shows                                                 |
| `description`         | string, ≤ 1000           | Free text                                                                             |
| `group`               | string, 1–200, or `null` | A group name. Created if it does not exist; `null` removes the control from its group |
| `groupId`             | UUID, or `null`          | The escape hatch when two groups share a name. Not with `group`                       |
| `kind`                | enum                     | `push`, `http`, `tcp`, `ping`, `dns`, `cert`. Defaults to `push` on a new control     |
| `config`              | mapping                  | The probe. Required when `kind` is not `push`, refused when it is                     |
| `expectedIntervalS`   | integer, or `null`       | 10 – 86 400. Silence past twice this marks the control `unknown`                      |
| `degradedThresholdMs` | integer > 0, or `null`   | Must be **below** `downThresholdMs`, or the degraded state can never occur            |
| `downThresholdMs`     | integer > 0, or `null`   |                                                                                       |
| `valueUnit`           | string, ≤ 30, or `null`  | `ms`, `GB`, `requests/s` — whatever the chart should print                            |
| `valueLabel`          | string, ≤ 60, or `null`  |                                                                                       |
| `slaTarget`           | integer, or `null`       | 0 – 10 000, in hundredths of a percent: `9995` is 99.95 %                             |
| `widget`              | string, ≤ 60             | A widget id from the web app's registry. Unknown ids fall back to the ribbon          |
| `widgetOptions`       | mapping                  | Passed to the widget as-is                                                            |
| `isPublic`            | boolean                  | On the public page, or only for members. Defaults to `true` on a new control          |
| `enabled`             | boolean                  | A disabled control is not probed and is not swept                                     |
| `position`            | integer ≥ 0              | Order on the page                                                                     |

### `config`, by kind

`config` is a [probe specification](./probes.md) with its `type` left out — the
`kind` says which one it is. The fields, the assertions and their semantics are
documented once, there; this page only says how they are spelled in the file.

| `kind` | Required in `config` | Also accepted                                                      |
| ------ | -------------------- | ------------------------------------------------------------------ |
| `push` | —                    | Nothing. A push control is reported to, not probed                 |
| `http` | `url`                | `method`, `headers`, `body`, `followRedirects`, `tlsVerify`        |
| `tcp`  | `host`, `port`       |                                                                    |
| `ping` | `host`               | `count` (1–10, default 3)                                          |
| `dns`  | `name`               | `recordType` (`A`, `AAAA`, `CNAME`, `MX`, `TXT`, `NS`), `resolver` |
| `cert` | `host`               | `port` (default 443)                                               |

All of them also take `timeoutMs` (default 10 000) and `assertions`.

Unknown fields are **rejected**, inside `config` as well as outside it. A
`timeout_ms` that was quietly ignored would be a probe timing out at ten seconds
forever, and a person certain they had configured it otherwise.

## Absent, null, and default

The file is a description of what should be true, applied on top of what is
already there. Three different things:

- **The field is absent.** Nothing changes. On a control being created, the
  database's own default applies (`push`, public, enabled, position 0, the
  uptime ribbon).
- **The field is `null`.** The value is cleared, where the column allows it —
  `slaTarget: null` removes the target, `group: null` takes the control out of
  its group.
- **The field has a value.** It is set.

This is why a partial file is a legitimate thing to write. A file that carries
only keys and thresholds adjusts thresholds and touches nothing else; re-running
a file that never mentioned `isPublic` will not publish a control somebody
deliberately made internal.

## Applying twice

Controls are matched on `key`, which is already the identity scripts and agents
push against. Importing the same file twice creates nothing the second time: the
first run reports them as `created`, the second as `updated`, and the result is
the same rows.

The key is the only thing that could serve here. Matching on `name` would
rename-and-duplicate the first time somebody fixed a typo, and matching on an id
would mean the file could not be written by hand.

## All or nothing

The whole file is applied in one transaction. If the eleventh control is refused
— by the schema, or by the database because it names a group that does not exist
— the ten before it are rolled back and the import reports the problem.

A half-applied file is worse than a rejected one: the reader has to work out
which controls landed before they can safely try again, and a monitoring
configuration that is partly the old one and partly the new one is exactly the
state nobody can reason about during an incident.

## Limits

| Limit             | Value  | Why                                                |
| ----------------- | ------ | -------------------------------------------------- |
| File size         | 256 KB | A few hundred controls at a generous kilobyte each |
| Controls per file | 500    | Split a larger fleet into several imports          |

The size is refused twice: once at the connection, before a large body is
buffered, and once on the YAML text itself, which is where the readable message
comes from.

## When something is wrong

The answer is a `400` with **every** problem in the file, not the first one:

```json
{
  "message": "2 problems in the file. Nothing was imported.",
  "issues": [
    {
      "line": 7,
      "column": 11,
      "path": "controls[0].kind",
      "key": "api",
      "message": "Not one of the accepted values",
      "received": "\"htp\"",
      "expected": "push, http, tcp, ping, dns, cert",
      "detail": "line 7 · controls[0].kind — Not one of the accepted values (found \"htp\", expected push, http, tcp, ping, dns, cert)"
    }
  ]
}
```

Every issue carries where it is — line, column, and a path in the file's own
vocabulary — what was found, and what would have been accepted. `detail` is the
same thing on one line, for a terminal or a log.

This is the point of the feature rather than a detail of it. A file of forty
controls is rejected as a unit, so the only thing that matters when it fails is
whether the reader can find the problem without bisecting the file by hand.

Three cases are reported on their own, because mixing them in helps nobody:

- **The file is not YAML.** One issue, with the line the parser stopped on.
  Nothing else is checked: a document that did not parse has no trustworthy
  contents, and twenty complaints derived from a half-read file bury the one
  line that needs fixing.
- **The file is empty.** Said as "the file is empty", not as "controls is
  required".
- **The file is too large.** A `413`, before anything is parsed.

Duplicate keys inside one file are reported alongside everything else, and name
the line of the first use:

```
line 14 · controls[3].key — Duplicate control key "api", already used on line 2.
A key identifies one control, so two entries sharing one would import as a single control.
```

## A complete example

Every probe kind, and a push control, with the fields that are worth setting.

```yaml
version: 1

controls:
  # ── An HTTP check, the common case ────────────────────────────────────────
  - key: api
    name: Public API
    description: The customer-facing API, from the outside
    group: Platform # created if this tenant has no group by that name
    kind: http
    expectedIntervalS: 60
    slaTarget: 9995 # 99.95 %
    widget: uptime-ribbon
    config:
      url: https://api.example.com/health
      method: GET
      timeoutMs: 5000
      headers:
        User-Agent: tern
      assertions:
        - type: status_code
          range: [200, 299]
        # Two latency assertions, two severities. This is how three states are
        # reached without writing any conditional logic.
        - type: latency
          ms: 800
          severity: degraded
        - type: latency
          ms: 3000
          severity: down
        # `capture: true` records the extracted number as the control's value,
        # which is what lets a queue depth be charted without a script.
        - type: json_path
          path: $.queue.depth
          comparator: lt
          value: 100
          as: number
          capture: true

  # ── A port that must answer ───────────────────────────────────────────────
  - key: db.port
    name: Database port
    group: Platform
    kind: tcp
    expectedIntervalS: 60
    config:
      host: db.internal
      port: 5432
      timeoutMs: 2000

  # ── Reachability ──────────────────────────────────────────────────────────
  - key: gateway
    name: Site gateway
    group: Network
    kind: ping
    config:
      host: 10.0.0.1
      count: 4
      assertions:
        - type: latency
          ms: 50
          severity: degraded

  # ── A DNS record that must keep resolving ─────────────────────────────────
  - key: dns.apex
    name: Apex record
    group: Network
    kind: dns
    expectedIntervalS: 300
    config:
      name: example.com
      recordType: A
      resolver: 1.1.1.1
      assertions:
        - type: dns_record
          comparator: contains
          value: 203.0.113.10

  # ── A certificate, watched for expiry ─────────────────────────────────────
  - key: tls.www
    name: www certificate
    group: Platform
    kind: cert
    expectedIntervalS: 3600
    config:
      host: www.example.com
      port: 443
      assertions:
        - type: cert_expires_in
          days: 21
          severity: degraded
        - type: cert_expires_in
          days: 7
          severity: down

  # ── A control nothing probes: a job reports to it ─────────────────────────
  - key: nightly-backup
    name: Nightly backup
    description: Pushes a heartbeat when the dump completes
    # No `kind`, so `push` — and therefore no `config`.
    expectedIntervalS: 86400 # silence past 48 h marks it unknown
    isPublic: false
    valueLabel: Dump size
    valueUnit: GB
    widget: stat-tile

  # ── Off for now, and staying off ──────────────────────────────────────────
  - key: legacy-billing
    name: Legacy billing
    enabled: false
    isPublic: false
```

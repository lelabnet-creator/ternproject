# The probe specification

A probe is a declarative description of a check: what to reach, and what has to
be true of the answer. It is the one part of TERN that exists twice — once in
TypeScript, once in Rust — so it is also the part with the strictest contract.

Canonical schema: `packages/shared/src/probe.ts`, exported as JSON Schema at
`schemas/probe.schema.json`.

## Anatomy

```json
{
  "type": "http",
  "url": "https://api.example.com/health",
  "method": "GET",
  "timeoutMs": 5000,
  "assertions": [
    { "type": "status_code", "range": [200, 299] },
    { "type": "latency", "ms": 800, "severity": "degraded" },
    {
      "type": "json_path",
      "path": "$.queue.depth",
      "comparator": "lt",
      "value": 100,
      "capture": true
    }
  ]
}
```

Two halves, and they are separated on purpose:

- **The target** — how to obtain an observation. Sockets and TLS. Easy to check
  by hand.
- **The assertions** — what the observation means. "Does `$.queue.depth < 100`
  mean the same thing in both languages" is not easy to check by hand, so it is
  what the conformance suite tests.

## Targets

| Type        | Fields                                                             | Notes                                                                                                   |
| ----------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `http`      | `url`, `method`, `headers`, `body`, `followRedirects`, `tlsVerify` | The body is read before the clock stops: a server that sends headers fast then stalls is slow           |
| `tcp`       | `host`, `port`                                                     | Connect only                                                                                            |
| `ping`      | `host`, `count`                                                    | Real ICMP in the agent; a TCP connect to port 7 on the server                                           |
| `dns`       | `name`, `recordType`, `resolver`                                   | Uses the host's own resolver, so it measures what an application beside it would experience             |
| `cert`      | `host`, `port`                                                     | Completes a real handshake against the trust store, then reads the expiry                               |
| `websocket` | `url` (`ws://`/`wss://`), `subprotocol`, `headers`                 | The opening handshake only. A `101` is success, so `status_code` and `latency` assert on it unchanged   |
| `docker`    | `container`, `requireHealthcheck`                                  | **Agent only.** Reads `GET /containers/<name>/json`; the JSON is the body, so `json_path` asserts on it |

All carry `timeoutMs` (default 10 000) and `assertions`.

**`websocket` has no `send`/`expect`.** The handshake answers the question a
status page asks — is the endpoint accepting connections, and how quickly. A
frame worth sending is specific to the application riding on top, which makes it
a different feature rather than a field on this one. It also has no `tlsVerify`,
unlike `http`: an endpoint whose certificate does not verify is a broken
endpoint, and neither implementation carries a permissive TLS verifier to say
otherwise.

**`docker` is agent-only, and off by default.** The server refuses the type
outright — running it would mean handing the API process a Docker socket, which
is root on the host. The agent needs `TERN_DOCKER_SOCKET` set explicitly, and
`tern-agent doctor` reports whether the path exists and is readable. Mount the
socket read-only. The observation is the container's own JSON, so
`$.State.Health.Status == "healthy"` is an ordinary `json_path` assertion rather
than a special case in the engine; a container that is not running fails as
unreachable, because an absent service is not a slow one.

**Why ping differs between the two implementations.** A web process must not
hold a raw socket, so the server approximates reachability with a TCP connect.
An agent may be granted `CAP_NET_RAW` — it tries an unprivileged ICMP datagram
socket first, since many distributions already allow that, and falls back to the
server's approximation _and says so_ when it is not permitted. `tern-agent
doctor` reports which mode is available.

## Assertions

Each carries a `severity` of `degraded` or `down`, defaulting to `down`.

| Type              | Checks                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| `status_code`     | `eq`, `in`, or `range`                                                                                      |
| `latency`         | `ms` with a comparator, default `lt`                                                                        |
| `body`            | Substring or regular expression                                                                             |
| `header`          | A named header against a value                                                                              |
| `json_path`       | A JSONPath expression, compared with `eq`/`ne`/`lt`/`lte`/`gt`/`gte`/`contains`/`matches`/`exists`/`absent` |
| `json_search`     | Find a value anywhere in the document                                                                       |
| `cert_expires_in` | Days remaining                                                                                              |
| `dns_record`      | A record present, absent, or matching                                                                       |

### Severity per assertion is the point

It is what produces three states without an if/else:

```json
[
  { "type": "latency", "ms": 800, "severity": "degraded" },
  { "type": "latency", "ms": 3000, "severity": "down" }
]
```

"Slower than 800 ms is degraded, slower than 3 s is down" is two assertions.
The result takes the worst severity among the failures.

### `capture`

A `json_path` assertion with `"capture": true` also _records_ the number it
found as the point's `value`. That is how a probe feeds a numeric widget. A
control drawn as a measurement whose probe captures nothing is the failure where
everything reports success and the chart stays empty — the agent names it at
pairing time, when it is cheap to fix.

## Evaluation order

1. **An unreachable target short-circuits.** If the observation carries an
   `error`, the result is `down` with that message and _no assertion results_.
   Assertions about a response that never arrived would report misleading detail
   like "expected 200, got nothing".
2. Otherwise every assertion is evaluated, all of them, even after one fails —
   the point of the detail is to say which things were wrong, not the first.
3. The status is the worst severity among failures; `operational` if none.
4. The message cites the failing assertion and the actual value.

## The conformance suite is the contract

`schemas/conformance/*.json` holds inputs and expected outputs. Both
implementations replay it:

- TypeScript: `packages/shared/src/probe.test.ts`
- Rust: `clients/agent/tests/conformance.rs`

Neither codebase is the reference. If they disagree, the fixture decides; if the
fixture is wrong, it is changed first and both follow.

**Adding an assertion type** means, in this order: extend `probe.ts`, add
fixtures, implement in TypeScript until they pass, implement in `probe.rs` until
they pass. Skipping the fixtures produces two implementations that agree on the
cases their author thought of.

The suite also asserts that failure _messages_ name the assertion and the actual
value. A conformant engine that says "check failed" is useless during an
incident, so that is part of the contract too.

## Trying one

`POST /api/v1/:slug/probe/run` runs a probe once and reports what each assertion
saw, without saving anything:

```json
{
  "status": "degraded",
  "latencyMs": 941,
  "value": null,
  "message": "latency 941 ms is not < 800 ms",
  "assertions": [
    { "type": "status_code", "passed": true, "severity": "down", "detail": "200 is in [200, 299]" },
    {
      "type": "latency",
      "passed": false,
      "severity": "degraded",
      "detail": "941 ms is not < 800 ms"
    }
  ]
}
```

The response never includes the raw body. Discovering a probe is misconfigured
during an actual outage is the worst possible moment, so this exists — but a
probe against an internal endpoint must not become a way to read that endpoint
through the admin.

Locally the same thing without the server:

```sh
tern-agent test --probe fixture.json     # exits non-zero when the verdict is not operational
```

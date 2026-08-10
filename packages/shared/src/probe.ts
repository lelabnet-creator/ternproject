import { z } from 'zod'
import { checkStatusSchema } from './status.js'

/**
 * Declarative probe specification.
 *
 * This is the contract between two independent implementations: the TypeScript
 * evaluator in the API (for targets reachable from the server) and the Rust
 * agent (for targets behind a firewall). Neither can import the other, so the
 * schema here is exported to `schemas/probe.schema.json` and both are held to
 * the same conformance fixtures.
 *
 * The point of the design is that monitoring something simple — a ping, an HTTP
 * code, a value buried in a JSON body — should not require writing a script.
 */

// ── Assertions ──────────────────────────────────────────────────────────────

/**
 * Severity is carried per assertion, which is what yields three states without
 * anyone writing conditional logic: "slower than 500 ms is degraded, slower
 * than 3 s is down" is two assertions, not an if/else.
 */
export const assertionSeveritySchema = z.enum(['degraded', 'down'])
export type AssertionSeverity = z.infer<typeof assertionSeveritySchema>

export const comparatorSchema = z.enum([
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'contains',
  'matches',
  'exists',
  'absent',
])
export type Comparator = z.infer<typeof comparatorSchema>

const severity = assertionSeveritySchema.default('down')

export const statusCodeAssertionSchema = z.object({
  type: z.literal('status_code'),
  severity,
  /** `eq: 200`, `in: [200, 204]`, or `range: [200, 299]`. */
  eq: z.number().int().optional(),
  in: z.array(z.number().int()).optional(),
  range: z.tuple([z.number().int(), z.number().int()]).optional(),
})

export const latencyAssertionSchema = z.object({
  type: z.literal('latency'),
  severity,
  comparator: z.enum(['lt', 'lte']).default('lt'),
  ms: z.number().int().positive(),
})

export const bodyAssertionSchema = z.object({
  type: z.literal('body'),
  severity,
  comparator: z.enum(['contains', 'matches', 'ne']).default('contains'),
  value: z.string(),
})

export const headerAssertionSchema = z.object({
  type: z.literal('header'),
  severity,
  name: z.string(),
  comparator: comparatorSchema.default('eq'),
  value: z.string().optional(),
})

export const jsonPathAssertionSchema = z.object({
  type: z.literal('json_path'),
  severity,
  /** JSONPath expression, e.g. `$.data.queue.depth`. */
  path: z.string(),
  comparator: comparatorSchema.default('eq'),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /**
   * Explicit coercion. Comparing "5" to 5 silently is how a threshold quietly
   * stops firing, so the intended type is stated rather than guessed.
   */
  as: z.enum(['string', 'number', 'bool']).default('string'),
  /**
   * Record the extracted value as the control's measurement. This is what lets
   * a queue depth or a session count be charted without writing any script.
   */
  capture: z.boolean().default(false),
})

/**
 * Finds a value anywhere in the document rather than at a fixed path — for APIs
 * whose response shape varies between versions or between error and success.
 */
export const jsonSearchAssertionSchema = z.object({
  type: z.literal('json_search'),
  severity,
  /** Only consider values under keys matching this name, if given. */
  key: z.string().optional(),
  comparator: z.enum(['eq', 'contains', 'matches', 'exists', 'absent']).default('exists'),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
})

export const certExpiryAssertionSchema = z.object({
  type: z.literal('cert_expires_in'),
  severity,
  days: z.number().int().positive(),
})

export const dnsAssertionSchema = z.object({
  type: z.literal('dns_record'),
  severity,
  comparator: z.enum(['eq', 'contains', 'exists']).default('contains'),
  value: z.string().optional(),
})

export const assertionSchema = z.discriminatedUnion('type', [
  statusCodeAssertionSchema,
  latencyAssertionSchema,
  bodyAssertionSchema,
  headerAssertionSchema,
  jsonPathAssertionSchema,
  jsonSearchAssertionSchema,
  certExpiryAssertionSchema,
  dnsAssertionSchema,
])
export type Assertion = z.infer<typeof assertionSchema>

// ── Targets ─────────────────────────────────────────────────────────────────

const baseProbe = {
  timeoutMs: z.number().int().positive().default(10_000),
  assertions: z.array(assertionSchema).default([]),
}

export const pingProbeSchema = z.object({
  type: z.literal('ping'),
  host: z.string().min(1),
  count: z.number().int().min(1).max(10).default(3),
  ...baseProbe,
})

export const tcpProbeSchema = z.object({
  type: z.literal('tcp'),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  ...baseProbe,
})

export const httpProbeSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  /** Values are encrypted at rest and masked in the UI and audit log. */
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().optional(),
  followRedirects: z.boolean().default(true),
  /**
   * Defaults to verifying TLS. Turning it off is occasionally necessary for
   * internal appliances, and is surfaced as an explicit, visible choice.
   */
  tlsVerify: z.boolean().default(true),
  ...baseProbe,
})

export const dnsProbeSchema = z.object({
  type: z.literal('dns'),
  name: z.string().min(1),
  recordType: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS']).default('A'),
  resolver: z.string().optional(),
  ...baseProbe,
})

export const certProbeSchema = z.object({
  type: z.literal('cert'),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(443),
  ...baseProbe,
})

/**
 * A WebSocket endpoint, measured by its opening handshake.
 *
 * The handshake and nothing more: connect, send the `Upgrade` request, and stop
 * the clock on the server's status line. That answers the question a status
 * page asks — is the endpoint accepting connections, and how quickly — and it
 * answers it without holding a socket open or inventing an application-level
 * message that would be wrong for every protocol riding on top.
 *
 * So there is no `send`/`expect` pair here. It was considered and left out: a
 * frame worth sending is specific to the application, which makes it a
 * different feature (a scripted probe) rather than a field on this one.
 *
 * The result reuses the assertions that already exist. A successful handshake
 * is `101`, so `status_code` and `latency` work unchanged and the conformance
 * suite needs no new assertion type — the whole point of separating targets
 * from assertions.
 */
export const websocketProbeSchema = z.object({
  type: z.literal('websocket'),
  /**
   * `ws://` or `wss://`. The scheme decides whether TLS is used.
   *
   * Checked, not merely described. The agent refuses any other scheme at probe
   * time; the server treated everything that was not `wss:` as plaintext, so an
   * `https://` typed here connected to port 443 without TLS, read whatever came
   * back and reported it. The control was green and had never opened a
   * websocket. Refusing it here means the file, or the form, says so first.
   */
  url: z
    .string()
    .url()
    .refine((url) => /^wss?:\/\//i.test(url), 'Must start with ws:// or wss://'),
  /** Sent as `Sec-WebSocket-Protocol`, when the server requires one. */
  subprotocol: z.string().optional(),
  headers: z.record(z.string(), z.string()).default({}),
  /*
   * No `tlsVerify`, deliberately, and it used to be here.
   *
   * The field existed on this schema and was honoured by the server alone. The
   * agent refuses to carry a certificate verifier that accepts everything —
   * see the block comment in `observe_websocket` — so the same control returned
   * `operational` when the server ran it and `down` when an agent did. A
   * control that means two things depending on who executes it is worse than
   * one that cannot express the case at all.
   *
   * Removed rather than implemented in Rust: a `wss://` endpoint whose
   * certificate does not verify is a broken endpoint, which is the line
   * `docs/probes.md` already took. Removing it also turns a setting that was
   * silently ignored into an import that says `Unknown field "tlsVerify"`,
   * which is the whole reason the file schema is strict.
   */
  ...baseProbe,
})

/**
 * A container on the machine the agent runs on.
 *
 * ── Agent only, and deliberately ──────────────────────────────────────────
 * There is no server-side implementation of this target and there will not be.
 * The API process would have to be handed a Docker socket to run it, and the
 * Docker socket is root on the host: an HTTP service that can create a
 * privileged container bind-mounting `/` is not a monitoring feature, it is a
 * remote root shell with extra steps. `probe-transport.ts` refuses this type
 * with a message that says so.
 *
 * The agent asks for it explicitly. `TERN_DOCKER_SOCKET` is unset by default,
 * `tern-agent doctor` reports whether the socket is readable, and the operator
 * mounts it read-only if they want this. An opt-in that has to be taken twice —
 * once in the agent's environment and once on the control — is the right shape
 * for a capability this sharp.
 *
 * ── What it observes ──────────────────────────────────────────────────────
 * `GET /containers/<name>/json`, from which it takes `State.Running`,
 * `State.Health.Status` where a healthcheck is defined, and `RestartCount`. The
 * observation is JSON, so `json_path` asserts on it exactly as it does on an
 * HTTP body — `$.State.Health.Status == "healthy"` is an ordinary assertion,
 * not a special case in the engine.
 */
export const dockerProbeSchema = z.object({
  type: z.literal('docker'),
  /** Container name or ID, as `docker ps` prints it. */
  container: z.string().min(1),
  /**
   * Treat a container with no healthcheck defined as healthy.
   *
   * Most images define none, and the alternative default — everything without
   * a healthcheck is unknown — would make the first check of most containers
   * fail for a reason that is not about the service.
   */
  requireHealthcheck: z.boolean().default(false),
  ...baseProbe,
})

/*
 * ── The three host targets below ────────────────────────────────────────────
 *
 * They observe the filesystem and the process table of the machine the agent
 * runs on, which puts them in the same category as `docker`: agent only, and
 * refused by the server rather than merely unimplemented there.
 *
 * The reason is the same one, and it is worth stating once for all three. The
 * API process runs as the instance; a control is editable by anyone with write
 * access to the tenant. A `file` target the server executed would turn that
 * into "read any path on the TERN host, one existence bit and one size at a
 * time" — `/etc/shadow` exists, `/root/.ssh/id_ed25519` is 411 bytes — and a
 * `directory` target would list it. That is a filesystem oracle reachable from
 * a web form, which is not a monitoring feature. `probe-transport.ts` refuses
 * all three by name and says why.
 *
 * On an agent the same capability is ordinary: the operator installed the
 * binary, chose the user it runs as, and can read those paths already. The
 * boundary is the machine, and the agent is on the right side of it.
 */

/**
 * Whether a path is there, and what state it is in.
 *
 * The plainest question in operations and the one nothing else here could ask:
 * a lock file that should be gone, a certificate that should be present, a
 * `/var/run` pidfile, an export that should have been written overnight.
 *
 * ── What it observes ──────────────────────────────────────────────────────
 * `{ exists, kind, sizeBytes, modifiedSecondsAgo }`, as JSON, so `json_path`
 * asserts on it exactly as it does on an HTTP body: `$.sizeBytes gt 0` catches
 * the file that was created but never written, `$.modifiedSecondsAgo lt 86400`
 * catches the export that stopped being refreshed. `sizeBytes` and
 * `modifiedSecondsAgo` are null when the path is absent, and an assertion
 * against null fails rather than passing quietly.
 */
export const fileProbeSchema = z.object({
  type: z.literal('file'),
  /** Absolute path on the agent's machine. */
  path: z.string().min(1),
  /**
   * Which answer is the healthy one.
   *
   * Both directions are wanted often enough that neither can be the only one:
   * a certificate must exist, a maintenance flag or a stale lock must not. This
   * decides the verdict when the control carries no assertions at all, which is
   * how most of these will be written.
   */
  mustExist: z.boolean().default(true),
  ...baseProbe,
})

/**
 * Whether a directory is still being written to.
 *
 * The question behind "is the backup still running" and "is the spool
 * draining", neither of which any network target can answer: the service
 * answers on its port, and has been writing nothing for two days.
 *
 * ── What it observes ──────────────────────────────────────────────────────
 * `{ exists, entries, bytes, newestSecondsAgo, newestName }`, as JSON. One
 * level, not a recursive walk — a deep tree would make the cost of a check
 * depend on something the operator did not choose, and the timeout would be the
 * first thing to notice.
 *
 * `newestSecondsAgo` is the age of the most recently modified entry, and null
 * when the directory is empty. Both readings of "activity" are then ordinary
 * assertions: `$.newestSecondsAgo lt 3600` for a drop folder that must keep
 * receiving, `$.entries eq 0` for a dead-letter folder that must stay empty.
 */
export const directoryProbeSchema = z.object({
  type: z.literal('directory'),
  /** Absolute path on the agent's machine. */
  path: z.string().min(1),
  /**
   * Only count entries whose name contains this, when given.
   *
   * A substring rather than a glob, deliberately: a glob is a small language,
   * and it would have to mean the same thing in Rust and in TypeScript for the
   * conformance suite to hold. `.sql.gz` is the case people actually have.
   */
  contains: z.string().min(1).optional(),
  /**
   * Fail when nothing in the directory has changed for this long.
   *
   * The one-field form of the common case, so a backup drop needs no assertion
   * written. Left unset, the target only observes and the assertions decide —
   * which is how the opposite expectation is written.
   */
  maxQuietSeconds: z.number().int().positive().optional(),
  ...baseProbe,
})

/**
 * How long the machine, or one process on it, has been up.
 *
 * A restart is invisible to every other target here: the machine reboots, the
 * service comes back in twenty seconds, and a one-minute interval sees an
 * unbroken green line. What was lost was not availability, it was continuity —
 * the in-memory queue, the warmed cache, the session table. This is the target
 * that notices.
 *
 * ── What it observes ──────────────────────────────────────────────────────
 * `{ of, uptimeSeconds, restarted, process, pid }`, as JSON. `restarted` is
 * only a claim when `minSeconds` is set — it is `uptimeSeconds < minSeconds`,
 * and null otherwise, because "has this restarted" has no answer without
 * saying since when.
 *
 * ── Linux only, and it says so ────────────────────────────────────────────
 * Process start time and machine uptime come from `/proc`. macOS and Windows
 * expose both, by different means, and neither is reachable without adding a
 * platform crate to a binary built for size. On those hosts the target fails
 * with a message naming the limitation, following `docker`: a control that is
 * not being run has to say so, or "nothing happened" becomes the way somebody
 * finds out.
 */
export const uptimeProbeSchema = z
  .object({
    type: z.literal('uptime'),
    of: z.enum(['machine', 'process']).default('machine'),
    /**
     * Process name as `/proc/<pid>/comm` reports it — `nginx`, `postgres`.
     *
     * Matched against the command name, not the full command line: the full line
     * carries arguments that change between restarts, which is the one thing this
     * target must not be sensitive to. When several match, the oldest wins, since
     * the question is when the service started and workers come and go.
     */
    process: z.string().min(1).optional(),
    /**
     * Below this many seconds of uptime, the control fails.
     *
     * Set it a little above the check interval and the control goes down for
     * exactly one check after a restart, which is what makes a reboot show up as
     * an incident instead of disappearing between two green points.
     */
    minSeconds: z.number().int().positive().optional(),
    ...baseProbe,
  })
  /*
   * Caught here rather than at probe time, because it is a definition error and
   * not an observation: `of: process` with nothing named cannot be measured on
   * any host, so an import that says it should be told at import, and the form
   * should not be able to save it.
   */
  .refine(
    (probe) => probe.of !== 'process' || Boolean(probe.process),
    'A process uptime control must name the process',
  )

export const probeSchema = z.discriminatedUnion('type', [
  pingProbeSchema,
  tcpProbeSchema,
  httpProbeSchema,
  dnsProbeSchema,
  certProbeSchema,
  websocketProbeSchema,
  dockerProbeSchema,
  fileProbeSchema,
  directoryProbeSchema,
  uptimeProbeSchema,
])
export type Probe = z.infer<typeof probeSchema>

// ── Results ─────────────────────────────────────────────────────────────────

export const assertionResultSchema = z.object({
  type: z.string(),
  passed: z.boolean(),
  severity: assertionSeveritySchema,
  /** Human-readable, and specific: what was expected, what was found. */
  detail: z.string(),
})
export type AssertionResult = z.infer<typeof assertionResultSchema>

export const probeResultSchema = z.object({
  status: checkStatusSchema,
  latencyMs: z.number().int().nullable(),
  /** Value from the assertion marked `capture`, if any. */
  value: z.number().nullable(),
  message: z.string().nullable(),
  assertions: z.array(assertionResultSchema),
  /** Raw response detail, shown by "Run now" in the editor. Never persisted. */
  debug: z.record(z.string(), z.unknown()).optional(),
})
export type ProbeResult = z.infer<typeof probeResultSchema>

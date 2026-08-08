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
  /** `ws://` or `wss://`. The scheme decides whether TLS is used. */
  url: z.string().url(),
  /** Sent as `Sec-WebSocket-Protocol`, when the server requires one. */
  subprotocol: z.string().optional(),
  headers: z.record(z.string(), z.string()).default({}),
  /** As `http`: off is occasionally necessary, and always an explicit choice. */
  tlsVerify: z.boolean().default(true),
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

export const probeSchema = z.discriminatedUnion('type', [
  pingProbeSchema,
  tcpProbeSchema,
  httpProbeSchema,
  dnsProbeSchema,
  certProbeSchema,
  websocketProbeSchema,
  dockerProbeSchema,
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

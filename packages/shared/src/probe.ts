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

export const probeSchema = z.discriminatedUnion('type', [
  pingProbeSchema,
  tcpProbeSchema,
  httpProbeSchema,
  dnsProbeSchema,
  certProbeSchema,
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

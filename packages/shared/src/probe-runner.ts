import type {
  Assertion,
  AssertionResult,
  AssertionSeverity,
  Comparator,
  ProbeResult,
} from './probe.js'
import type { CheckStatusValue } from './status.js'

/**
 * The assertion engine — the half of probe evaluation that has no I/O.
 *
 * Kept separate from the transports on purpose: this is the part the Rust agent
 * and the TypeScript evaluator must agree on exactly, and it is the part the
 * shared conformance fixtures exercise. Sockets are easy to test by hand;
 * "does `$.queue.depth < 100` mean the same thing in both implementations" is
 * not.
 */

/** What a transport hands to the engine after doing the actual network work. */
export interface ProbeObservation {
  /** Set when the target could not be reached at all. */
  error?: string
  latencyMs?: number
  statusCode?: number
  headers?: Record<string, string>
  body?: string
  /** Days until the TLS certificate expires, for `cert` probes. */
  certExpiresInDays?: number
  /** Resolved records, for `dns` probes. */
  dnsRecords?: string[]
}

export function evaluateAssertions(
  assertions: readonly Assertion[],
  observation: ProbeObservation,
): ProbeResult {
  // An unreachable target short-circuits: assertions about a response that never
  // arrived would report misleading detail ("expected 200, got undefined").
  if (observation.error) {
    return {
      status: 'down',
      latencyMs: observation.latencyMs ?? null,
      value: null,
      message: observation.error,
      assertions: [],
    }
  }

  const results: AssertionResult[] = []
  let captured: number | null = null
  let parsedBody: unknown
  let bodyParsed = false

  const json = (): unknown => {
    if (!bodyParsed) {
      bodyParsed = true
      try {
        parsedBody = observation.body ? JSON.parse(observation.body) : undefined
      } catch {
        parsedBody = undefined
      }
    }
    return parsedBody
  }

  for (const assertion of assertions) {
    const outcome = evaluateOne(assertion, observation, json)
    results.push(outcome.result)
    if (outcome.captured !== undefined) captured = outcome.captured
  }

  const failed = results.filter((r) => !r.passed)
  const down = failed.find((r) => r.severity === 'down')
  const degraded = failed.find((r) => r.severity === 'degraded')

  const status: CheckStatusValue = down ? 'down' : degraded ? 'degraded' : 'operational'

  return {
    status,
    latencyMs: observation.latencyMs ?? null,
    value: captured,
    // Naming the failing assertion and its actual value is the whole difference
    // between a status page you can act on and one that says "check failed".
    message: (down ?? degraded)?.detail ?? null,
    assertions: results,
  }
}

interface OneOutcome {
  result: AssertionResult
  captured?: number
}

function evaluateOne(
  assertion: Assertion,
  observation: ProbeObservation,
  json: () => unknown,
): OneOutcome {
  const severity: AssertionSeverity = assertion.severity ?? 'down'
  const make = (passed: boolean, detail: string): OneOutcome => ({
    result: { type: assertion.type, passed, severity, detail },
  })

  switch (assertion.type) {
    case 'status_code': {
      const code = observation.statusCode
      if (code === undefined) return make(false, 'no HTTP status code in response')
      if (assertion.eq !== undefined) {
        return make(code === assertion.eq, `status ${code}, expected ${assertion.eq}`)
      }
      if (assertion.in) {
        return make(
          assertion.in.includes(code),
          `status ${code}, expected one of ${assertion.in.join(', ')}`,
        )
      }
      if (assertion.range) {
        const [lo, hi] = assertion.range
        return make(code >= lo && code <= hi, `status ${code}, expected ${lo}–${hi}`)
      }
      // No bound given: any response at all satisfies it.
      return make(true, `status ${code}`)
    }

    case 'latency': {
      const ms = observation.latencyMs
      if (ms === undefined) return make(false, 'no latency measured')
      const ok = assertion.comparator === 'lte' ? ms <= assertion.ms : ms < assertion.ms
      return make(ok, `latency ${ms} ms, threshold ${assertion.ms} ms`)
    }

    case 'body': {
      const body = observation.body ?? ''
      const ok =
        assertion.comparator === 'contains'
          ? body.includes(assertion.value)
          : assertion.comparator === 'matches'
            ? safeMatch(body, assertion.value)
            : !body.includes(assertion.value)
      return make(ok, `body ${assertion.comparator} ${JSON.stringify(assertion.value)}`)
    }

    case 'header': {
      // HTTP header names are case-insensitive; comparing them literally is a
      // bug that only shows up against some servers.
      const headers = observation.headers ?? {}
      const key = Object.keys(headers).find((k) => k.toLowerCase() === assertion.name.toLowerCase())
      const actual = key ? headers[key] : undefined
      const ok = compare(actual, assertion.comparator, assertion.value)
      return make(
        ok,
        `header ${assertion.name}: ${actual ?? '(absent)'} ${assertion.comparator} ${
          assertion.value ?? ''
        }`.trim(),
      )
    }

    case 'json_path': {
      const raw = queryJsonPath(json(), assertion.path)
      const actual = coerce(raw, assertion.as)
      const expected =
        assertion.value === undefined ? undefined : coerce(assertion.value, assertion.as)
      const ok = compare(actual, assertion.comparator, expected)
      const outcome = make(
        ok,
        `${assertion.path} = ${format(raw)} ${assertion.comparator} ${format(assertion.value)}`,
      )
      if (assertion.capture && typeof actual === 'number' && Number.isFinite(actual)) {
        outcome.captured = actual
      }
      return outcome
    }

    case 'json_search': {
      const matches = searchJson(json(), assertion.key)
      const found = matches.some((candidate) =>
        assertion.comparator === 'exists' || assertion.comparator === 'absent'
          ? true
          : compare(String(candidate), assertion.comparator, assertion.value),
      )
      const ok = assertion.comparator === 'absent' ? !found : found
      return make(
        ok,
        `search ${assertion.key ? `key "${assertion.key}"` : 'any key'} ${
          assertion.comparator
        } ${format(assertion.value)}`,
      )
    }

    case 'cert_expires_in': {
      const days = observation.certExpiresInDays
      if (days === undefined) return make(false, 'no certificate observed')
      return make(
        days >= assertion.days,
        `certificate expires in ${days} d, want ≥ ${assertion.days} d`,
      )
    }

    case 'dns_record': {
      const records = observation.dnsRecords ?? []
      const ok =
        assertion.comparator === 'exists'
          ? records.length > 0
          : records.some((r) => compare(r, assertion.comparator, assertion.value))
      return make(
        ok,
        `dns [${records.join(', ')}] ${assertion.comparator} ${format(assertion.value)}`,
      )
    }
  }
}

// ── Comparison ──────────────────────────────────────────────────────────────

function compare(actual: unknown, comparator: Comparator, expected: unknown): boolean {
  switch (comparator) {
    case 'exists':
      return actual !== undefined && actual !== null
    case 'absent':
      return actual === undefined || actual === null
    case 'eq':
      return actual === expected
    case 'ne':
      return actual !== expected
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      /*
       * Ordering comparisons are only meaningful on numbers. Falling back to
       * string ordering here would make "9" > "10" and silently break a
       * threshold, so a non-numeric operand fails the assertion instead.
       *
       * Absent is not zero, and this is the line that used to say otherwise.
       * `Number(null)` is `0` — not `NaN` — so a missing field slipped past the
       * finite check and was ordered as if it had been measured at zero. Half
       * the comparators then passed on nothing at all: `$.modifiedSecondsAgo lt
       * 86400` reported a file refreshed within the day when the file was not
       * there. The targets that observe a host make this ordinary rather than
       * exotic — an absent path reports `sizeBytes: null` by design — but the
       * hole was never specific to them, and `$.queue.depth lt 100` over a
       * response that omitted the field has always read as an empty queue.
       */
      if (actual === undefined || actual === null) return false
      if (expected === undefined || expected === null) return false
      const a = Number(actual)
      const b = Number(expected)
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false
      if (comparator === 'lt') return a < b
      if (comparator === 'lte') return a <= b
      if (comparator === 'gt') return a > b
      return a >= b
    }
    case 'contains':
      return String(actual ?? '').includes(String(expected ?? ''))
    case 'matches':
      return safeMatch(String(actual ?? ''), String(expected ?? ''))
  }
}

/**
 * A user-supplied pattern must never take the process down, and an invalid
 * regex is a configuration mistake — reported as a failed assertion, not as a
 * crash mid-probe.
 */
function safeMatch(value: string, pattern: string): boolean {
  try {
    return new RegExp(pattern).test(value)
  } catch {
    return false
  }
}

function coerce(value: unknown, as: 'string' | 'number' | 'bool'): unknown {
  if (value === undefined || value === null) return value
  switch (as) {
    case 'number': {
      const n = Number(value)
      return Number.isFinite(n) ? n : undefined
    }
    case 'bool':
      return value === true || value === 'true' || value === 1 || value === '1'
    case 'string':
      return typeof value === 'string' ? value : JSON.stringify(value)
  }
}

function format(value: unknown): string {
  if (value === undefined) return '(absent)'
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

// ── JSONPath ────────────────────────────────────────────────────────────────

/**
 * A deliberately small JSONPath subset: `$.a.b[0]`, `$['a b'].c`, and `[*]` to
 * take the first match.
 *
 * A full JSONPath library would be a dependency the Rust agent has to match
 * expression-for-expression. Keeping the grammar small keeps the two
 * implementations honestly equivalent, and covers what a health endpoint
 * actually needs.
 */
export function queryJsonPath(document: unknown, path: string): unknown {
  const tokens = tokenisePath(path)
  let current: unknown = document

  for (const token of tokens) {
    if (current === undefined || current === null) return undefined

    if (token === '*') {
      if (!Array.isArray(current)) return undefined
      current = current[0]
      continue
    }

    if (Array.isArray(current)) {
      const index = Number(token)
      if (!Number.isInteger(index)) return undefined
      current = current.at(index)
      continue
    }

    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[token]
  }

  return current
}

function tokenisePath(path: string): string[] {
  const tokens: string[] = []
  const cleaned = path.startsWith('$') ? path.slice(1) : path
  const pattern = /\.([^.[\]]+)|\['([^']*)'\]|\["([^"]*)"\]|\[(\*|-?\d+)\]|^([^.[\]]+)/g

  let match: RegExpExecArray | null
  while ((match = pattern.exec(cleaned)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]
    if (token !== undefined) tokens.push(token)
  }
  return tokens
}

/**
 * Collects every value in the document, optionally restricted to a key name.
 * For APIs whose response shape moves between versions — the alternative is a
 * probe that breaks on an upgrade nobody told you about.
 */
export function searchJson(document: unknown, key?: string): unknown[] {
  const found: unknown[] = []

  const walk = (node: unknown, currentKey?: string) => {
    if (node !== null && typeof node === 'object') {
      const entries = Array.isArray(node)
        ? node.map((v, i) => [String(i), v] as const)
        : Object.entries(node as Record<string, unknown>)
      for (const [k, v] of entries) walk(v, k)
      return
    }
    if (key === undefined || currentKey === key) found.push(node)
  }

  walk(document)
  return found
}

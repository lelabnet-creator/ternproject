import { queryJsonPath, type CheckStatusValue } from '@tern/shared'

/**
 * Normalises third-party alert payloads into TERN's own vocabulary.
 *
 * Most teams already run monitoring. Making them replace it to publish a status
 * page is a non-starter, so the realistic path is to accept what they already
 * emit. Each adapter is a pure function over the parsed body — no I/O — so the
 * mapping can be exercised against recorded payloads.
 */

export interface NormalisedAlert {
  /** Matched against a control key, or against a mapping rule. */
  key: string
  status: CheckStatusValue
  message?: string
  /** True when the source says the alert has cleared. */
  resolved: boolean
  latencyMs?: number
  value?: number
}

export type ReceiverKind =
  'alertmanager' | 'grafana' | 'uptimerobot' | 'zabbix' | 'pagerduty' | 'healthchecks' | 'generic'

export interface GenericMapping {
  /** JSONPath to the value identifying which control this is about. */
  keyPath?: string
  statusPath?: string
  messagePath?: string
  resolvedPath?: string
  /** Value of `statusPath` that means healthy. */
  okValue?: string
  /** Maps a source severity onto a TERN status. */
  statusMap?: Record<string, CheckStatusValue>
}

/**
 * Severity words used by the tools we adapt.
 *
 * Deliberately conservative: an unrecognised severity becomes `degraded`, not
 * `down`. Guessing high turns an unfamiliar label into a public major outage,
 * which is the expensive direction to be wrong in.
 */
const SEVERITY_WORDS: Record<string, CheckStatusValue> = {
  ok: 'operational',
  up: 'operational',
  resolved: 'operational',
  healthy: 'operational',
  success: 'operational',
  warning: 'degraded',
  warn: 'degraded',
  minor: 'degraded',
  degraded: 'degraded',
  average: 'degraded',
  high: 'partial',
  major: 'partial',
  error: 'partial',
  critical: 'down',
  disaster: 'down',
  down: 'down',
  firing: 'down',
}

export function severityToStatus(value: string | undefined): CheckStatusValue {
  if (!value) return 'degraded'
  return SEVERITY_WORDS[value.trim().toLowerCase()] ?? 'degraded'
}

export function normalise(
  kind: ReceiverKind,
  body: unknown,
  mapping: GenericMapping = {},
): NormalisedAlert[] {
  switch (kind) {
    case 'alertmanager':
      return fromAlertmanager(body)
    case 'grafana':
      return fromGrafana(body)
    case 'uptimerobot':
      return fromUptimeRobot(body)
    case 'zabbix':
      return fromZabbix(body)
    case 'pagerduty':
      return fromPagerDuty(body)
    case 'healthchecks':
      return fromHealthchecks(body)
    case 'generic':
      return fromGeneric(body, mapping)
  }
}

/** Prometheus Alertmanager posts a batch, each alert carrying its own status. */
function fromAlertmanager(body: unknown): NormalisedAlert[] {
  const alerts = asArray(get(body, 'alerts'))

  return alerts.flatMap((alert) => {
    const labels = get(alert, 'labels') as Record<string, string> | undefined
    // `tern_control` first so a team can point an alert at a specific component
    // without renaming the alert itself.
    const key = labels?.tern_control ?? labels?.service ?? labels?.job ?? labels?.alertname
    if (!key) return []

    const resolved = String(get(alert, 'status') ?? '').toLowerCase() === 'resolved'
    const annotations = get(alert, 'annotations') as Record<string, string> | undefined

    return [
      {
        key,
        resolved,
        status: resolved ? 'operational' : severityToStatus(labels?.severity ?? 'firing'),
        message: annotations?.summary ?? annotations?.description,
      },
    ]
  })
}

function fromGrafana(body: unknown): NormalisedAlert[] {
  // Grafana 9+ speaks the Alertmanager shape.
  if (get(body, 'alerts')) return fromAlertmanager(body)

  const state = String(get(body, 'state') ?? '')
  const key = String(get(body, 'ruleName') ?? get(body, 'title') ?? '')
  if (!key) return []

  const resolved = state.toLowerCase() === 'ok'
  return [
    {
      key,
      resolved,
      status: resolved ? 'operational' : severityToStatus(state),
      message: asString(get(body, 'message')),
    },
  ]
}

function fromUptimeRobot(body: unknown): NormalisedAlert[] {
  const key = asString(get(body, 'monitorFriendlyName') ?? get(body, 'monitorID'))
  if (!key) return []

  // UptimeRobot sends alertType 1 = down, 2 = up.
  const up = String(get(body, 'alertType') ?? '') === '2'
  return [
    {
      key,
      resolved: up,
      status: up ? 'operational' : 'down',
      message: asString(get(body, 'alertDetails')),
    },
  ]
}

function fromZabbix(body: unknown): NormalisedAlert[] {
  const key = asString(get(body, 'host') ?? get(body, 'trigger_name'))
  if (!key) return []

  const status = String(get(body, 'status') ?? '').toLowerCase()
  const resolved = status === 'ok' || status === 'resolved'
  return [
    {
      key,
      resolved,
      status: resolved ? 'operational' : severityToStatus(asString(get(body, 'severity'))),
      message: asString(get(body, 'message') ?? get(body, 'trigger_name')),
    },
  ]
}

function fromPagerDuty(body: unknown): NormalisedAlert[] {
  const event = get(body, 'event') ?? body
  const data = get(event, 'data')
  const key = asString(get(data, 'service.summary') ?? get(get(data, 'service'), 'summary'))
  if (!key) return []

  const type = String(get(event, 'event_type') ?? '')
  const resolved = type.endsWith('resolved')
  return [
    {
      key,
      resolved,
      status: resolved ? 'operational' : severityToStatus(asString(get(data, 'urgency'))),
      message: asString(get(data, 'title')),
    },
  ]
}

function fromHealthchecks(body: unknown): NormalisedAlert[] {
  const check = get(body, 'check') ?? body
  const key = asString(get(check, 'slug') ?? get(check, 'name'))
  if (!key) return []

  const status = String(get(check, 'status') ?? '').toLowerCase()
  const resolved = status === 'up'
  return [{ key, resolved, status: resolved ? 'operational' : 'down' }]
}

/**
 * Anything else, driven by JSONPath rules configured in the UI — the escape
 * hatch that keeps an unlisted tool from being a blocker.
 */
function fromGeneric(body: unknown, mapping: GenericMapping): NormalisedAlert[] {
  const key = asString(mapping.keyPath ? queryJsonPath(body, mapping.keyPath) : undefined)
  if (!key) return []

  const rawStatus = asString(
    mapping.statusPath ? queryJsonPath(body, mapping.statusPath) : undefined,
  )
  const rawResolved = mapping.resolvedPath ? queryJsonPath(body, mapping.resolvedPath) : undefined

  const resolved =
    rawResolved === true ||
    rawResolved === 'true' ||
    (mapping.okValue !== undefined && rawStatus === mapping.okValue)

  const mapped = rawStatus ? mapping.statusMap?.[rawStatus] : undefined

  return [
    {
      key,
      resolved,
      status: resolved ? 'operational' : (mapped ?? severityToStatus(rawStatus)),
      message: asString(mapping.messagePath ? queryJsonPath(body, mapping.messagePath) : undefined),
    },
  ]
}

// ── Small helpers ───────────────────────────────────────────────────────────

function get(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  return (value as Record<string, unknown>)[key]
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  return typeof value === 'string' ? value : String(value)
}

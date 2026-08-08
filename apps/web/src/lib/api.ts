import type { CheckStatusValue } from '@tern/shared/status'

/**
 * Typed client for the public API.
 *
 * Hand-written rather than generated: the public surface is small, deliberately
 * stable, and the point of writing the types out is that a change to the API
 * shape breaks the build here instead of rendering a blank card at runtime.
 */

export interface StatusComponent {
  id: string
  key: string
  name: string
  description: string | null
  groupId: string | null
  status: CheckStatusValue
  lastCheckAt: string | null
  latencyMs: number | null
  value: number | null
  valueUnit: string | null
  valueLabel: string | null
  slaTarget: number | null
  widget: string
  widgetOptions: Record<string, unknown>
}

export interface StatusGroup {
  id: string
  parentId: string | null
  name: string
  position: number
  status: CheckStatusValue
}

export interface StatusSummary {
  tenant: {
    slug: string
    name: string
    retentionMode: 'live' | 'historical'
    retentionDays: number
    defaultLocale: string
    defaultTimezone: string
    subscriberDisclaimer: string | null
    layout: 'list' | 'grid' | 'compact' | 'custom'
    /** Synthetic data, said out loud rather than left to be discovered. */
    isDemo: boolean
    readOnly: boolean
    /** The document a `custom` layout renders; null for every other layout. */
    custom: { html: string; css: string; js: string } | null
    /** Blocks on a grid. Non-empty is what makes them win over the document. */
    customBlocks: unknown[]
    branding: Record<string, unknown>
  }
  overall: { status: CheckStatusValue; affectedCount: number }
  groups: StatusGroup[]
  components: StatusComponent[]
  incidents: {
    id: string
    title: string
    severity: string
    status: string
    startedAt: string
    resolvedAt: string | null
    /** The newest thing said about it, which is what a reader wants first. */
    latestUpdate: { status: string; body: string; createdAt: string } | null
    impacts: { controlId: string; impact: string }[]
  }[]
  maintenances: {
    id: string
    title: string
    body: string | null
    status: string
    scheduledStart: string
    scheduledEnd: string
    controlIds: string[]
  }[]
  generatedAt: string
}

export interface UptimeResponse {
  period: string
  days: {
    controlId: string
    day: string
    uptimePct: number | null
    samples: number
    worstStatus: CheckStatusValue
  }[]
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    // The session cookie has to travel for private tenants and viewer devices.
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })

  if (!response.ok) {
    // A private tenant answers 404 by design, so the message must not claim the
    // page does not exist — the caller decides how to phrase it.
    throw new ApiError(`Request failed: ${response.status}`, response.status)
  }

  return (await response.json()) as T
}

/** The page this instance serves, or null when that is not unambiguous. */
export interface InstanceInfo {
  tenant: { slug: string; name: string } | null
}

export const api = {
  instance: () => get<InstanceInfo>('/api/v1/public/instance.json'),
  summary: (slug: string) => get<StatusSummary>(`/api/v1/public/${slug}/summary.json`),
  uptime: (slug: string, period: string) =>
    get<UptimeResponse>(`/api/v1/public/${slug}/uptime.json?period=${period}`),
}

import { ApiError } from './api'

/**
 * Authenticated client for the admin surface.
 *
 * Separate from the public client because these calls carry a session and can
 * write. Keeping them apart makes it obvious at the call site which surface a
 * screen is talking to.
 */

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (!response.ok) {
    // The API answers with a message worth showing — a rejected threshold or a
    // taken key reads far better than "request failed".
    let message = `Request failed (${response.status})`
    try {
      const parsed = (await response.json()) as { message?: string }
      if (parsed.message) message = parsed.message
    } catch {
      // Non-JSON error body; the status line is all there is.
    }
    throw new ApiError(message, response.status)
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export interface Control {
  id: string
  key: string
  name: string
  description: string | null
  groupId: string | null
  kind: string
  /** The probe spec — empty for a `push` control. */
  config: Record<string, unknown>
  isPublic: boolean
  enabled: boolean
  expectedIntervalS: number | null
  degradedThresholdMs: number | null
  downThresholdMs: number | null
  valueUnit: string | null
  valueLabel: string | null
  slaTarget: number | null
  widget: string
  widgetOptions: Record<string, unknown>
  position: number
}

export interface TenantSettings {
  name: string
  slug: string
  retentionMode: 'live' | 'historical'
  retentionDays: number
  rawRetentionHours: number
  auditRetentionDays: number
  defaultLocale: string
  defaultTimezone: string
  subscriberDisclaimer: string | null
  layout: 'list' | 'grid' | 'compact'
  accent: string
  logoUrl: string | null
  sizingAssumptions: { intervalS: number; concurrentViewers: number }
  syslog: {
    host: string
    port: number
    protocol: 'udp' | 'tcp'
    facility: number
    format: 'rfc5424' | 'json'
    appName: string
  } | null
  smtp: {
    host: string
    port: number
    secure: boolean
    user: string | null
    from: string
    hasPassword: boolean
  } | null
  instanceSmtp: { host: string; port: number; secure: boolean; from: string }
}

/** What a PATCH may carry. The password is write-only and never read back. */
export type TenantSettingsPatch = Partial<
  Omit<TenantSettings, 'slug' | 'smtp' | 'instanceSmtp' | 'layout'>
> & {
  smtp?: {
    host: string
    port: number
    secure: boolean
    user?: string
    password?: string
    from: string
  } | null
  /**
   * Write-only, and only the first-run wizard sends it. It stamps a timestamp
   * into branding rather than storing a boolean, so it has no counterpart in
   * `TenantSettings` to be `Partial`'d out of.
   */
  setupCompleted?: boolean
}

export interface Agent {
  id: string
  name: string
  hostname: string | null
  os: string | null
  arch: string | null
  agentVersion: string | null
  site: string | null
  status: string
  lastSeenAt: string | null
  pairedAt: string
  jobCount: number
  controls: { id: string; key: string; name: string }[]
  scopeControlIds: string[]
}

export interface ScriptBundle {
  languages: { id: string; label: string; extension: string; syntax: string }[]
  scripts: Record<string, string>
  agent: { config: string; pairCommand: string; runCommand: string }
}

export interface ProbeRunResult {
  status: string
  latencyMs: number | null
  value: number | null
  message: string | null
  assertions: { type: string; passed: boolean; severity: string; detail: string }[]
}

export const adminApi = {
  /**
   * Whether this instance still has no account at all.
   *
   * Asked before the sign-in form is drawn, because on a fresh install there is
   * nothing to sign in to and a password field is a dead end.
   */
  setupState: () =>
    request<{
      needsSetup: boolean
      tenant: { slug: string; name: string } | null
    }>('GET', '/api/v1/setup/state.json'),

  /** Creates the first administrator and signs them in. Answers 409 afterwards. */
  createFirstAccount: (body: {
    email: string
    name: string
    password: string
    /** Only when the instance has no page yet — see setup.ts. */
    tenantName?: string
    tenantSlug?: string
    locale?: string
    timezone?: string
  }) =>
    request<{
      user: { id: string; email: string; name: string }
      tenant: { slug: string; name: string }
    }>('POST', '/api/v1/setup/account', body),

  me: () =>
    request<{
      user: { id: string; email: string; name: string; mfaEnabled: boolean }
      memberships: {
        tenantId: string
        slug: string
        name: string
        role: string
        isSystem: boolean
      }[]
    }>('GET', '/api/v1/auth/me'),

  login: (email: string, password: string) =>
    request<{ mfaRequired: boolean }>('POST', '/api/v1/auth/login', { email, password }),

  verifyMfa: (code: string, backupCode = false) =>
    request<{ backupCodesRemaining: number }>('POST', '/api/v1/auth/mfa/verify', {
      code,
      backupCode,
    }),

  logout: () => request<{ ok: boolean }>('POST', '/api/v1/auth/logout'),

  /** Always resolves, for any address — the API refuses to say which exist. */
  forgotPassword: (email: string) =>
    request<{ sent: boolean }>('POST', '/api/v1/auth/password/forgot', { email }),

  resetPassword: (token: string, newPassword: string) =>
    request<{ ok: boolean }>('POST', '/api/v1/auth/password/reset', { token, newPassword }),

  controls: (slug: string) => request<Control[]>('GET', `/api/v1/${slug}/controls`),

  createControl: (slug: string, body: Partial<Control> & { key: string; name: string }) =>
    request<{ id: string; key: string }>('POST', `/api/v1/${slug}/controls`, body),

  updateControl: (slug: string, id: string, body: Partial<Control>) =>
    request<{ ok: boolean }>('PATCH', `/api/v1/${slug}/controls/${id}`, body),

  deleteControl: (slug: string, id: string) =>
    request<{ ok: boolean }>('DELETE', `/api/v1/${slug}/controls/${id}`),

  series: (slug: string, id: string, days = 30) =>
    request<{
      synthetic: boolean
      points: {
        ts: string
        status: string
        latencyMs: number | null
        value: number | null
        metrics?: Record<string, number>
      }[]
    }>('GET', `/api/v1/${slug}/controls/${id}/series?days=${days}`),

  simulate: (slug: string, id: string, body: Record<string, unknown>) =>
    request<{ inserted: number }>('POST', `/api/v1/${slug}/controls/${id}/simulate`, body),

  purgeSimulation: (slug: string, id: string) =>
    request<{ deleted: number }>('DELETE', `/api/v1/${slug}/controls/${id}/simulate`),

  scripts: (slug: string, id: string, apiKey?: string) =>
    request<ScriptBundle>(
      'GET',
      `/api/v1/${slug}/controls/${id}/scripts${apiKey ? `?apiKey=${encodeURIComponent(apiKey)}` : ''}`,
    ),

  runProbe: (slug: string, probe: unknown) =>
    request<ProbeRunResult>('POST', `/api/v1/${slug}/probe/run`, { probe }),

  createPairingCode: (slug: string) =>
    request<{ pin: string; expiresAt: string; pairCommand: string }>(
      'POST',
      `/api/v1/${slug}/pairing-codes`,
      {},
    ),

  updateLayout: (
    slug: string,
    body: { layout: 'list' | 'grid' | 'compact'; order: { controlId: string }[] },
  ) => request<{ ok: boolean; reordered: number }>('PATCH', `/api/v1/${slug}/layout`, body),

  agents: (slug: string) => request<Agent[]>('GET', `/api/v1/${slug}/agents`),

  receivers: (slug: string) =>
    request<
      { id: string; name: string; kind: string; enabled: boolean; lastReceivedAt: string | null }[]
    >('GET', `/api/v1/${slug}/receivers`),

  createReceiver: (slug: string, body: { name: string; kind: string }) =>
    request<{ id: string; url: string }>('POST', `/api/v1/${slug}/receivers`, body),

  settings: (slug: string) => request<TenantSettings>('GET', `/api/v1/${slug}/settings`),

  logs: (slug: string, filters: { q?: string; action?: string } = {}) => {
    const query = new URLSearchParams()
    if (filters.q) query.set('q', filters.q)
    if (filters.action) query.set('action', filters.action)
    return request<{
      entries: {
        id: string
        ts: string
        action: string
        actor: string
        target: string | null
        ip: string | null
        meta: Record<string, unknown>
      }[]
      actions: string[]
    }>('GET', `/api/v1/${slug}/logs?${query.toString()}`)
  },

  dangerSummary: (slug: string) =>
    request<{
      controls: number
      checks: number
      agents: number
      incidents: number
      maintenances: number
      subscribers: number
      receivers: number
    }>('GET', `/api/v1/${slug}/danger/summary`),

  emptyTenant: (slug: string, confirm: string) =>
    request<{ emptied: boolean; deleted: Record<string, number> }>(
      'POST',
      `/api/v1/${slug}/danger/empty`,
      { confirm, understood: true },
    ),

  testSyslog: (slug: string) =>
    request<{ sent: boolean; detail: string }>('POST', `/api/v1/${slug}/logs/syslog/test`),

  updateSettings: (slug: string, body: TenantSettingsPatch) =>
    request<{ ok: boolean }>('PATCH', `/api/v1/${slug}/settings`, body),

  systemOverview: () =>
    request<{
      instance: {
        tenants: number
        controls: number
        agents: number
        activeAgents: number
        pointsLastHour: number
        pointsLastDay: number
        checksBytes: number | null
      }
      tenants: {
        id: string
        slug: string
        name: string
        isSystem: boolean
        retentionMode: string
        retentionDays: number
        controls: number
        agents: number
        pointsLastHour: number
        pointsPerMinute: number
        lastPointAt: string | null
      }[]
    }>('GET', '/api/v1/system/overview'),

  systemHealth: () =>
    request<{
      checks: { id: string; label: string; state: 'ok' | 'warn' | 'fail'; detail: string }[]
      limits: {
        ingestRateLimitPerMinute: number
        dbPoolMax: number
        authRateLimitPerMinute: number
      }
      uptimeS: number
    }>('GET', '/api/v1/system/health'),

  systemLoad: (hours = 24) =>
    request<{ buckets: { ts: string; points: number }[] }>(
      'GET',
      `/api/v1/system/load?hours=${hours}`,
    ),

  assignment: (slug: string, controlId: string) =>
    request<{
      policy: 'single' | 'all'
      pinned: string[]
      runners: string[]
      candidates: {
        id: string
        name: string
        site: string | null
        status: string
        lastSeenAt: string | null
        eligible: boolean
      }[]
    }>('GET', `/api/v1/${slug}/controls/${controlId}/assignment`),

  setAssignment: (
    slug: string,
    controlId: string,
    body: { policy: 'single' | 'all'; agentIds: string[] },
  ) =>
    request<{ ok: boolean; runners: string[] }>(
      'PUT',
      `/api/v1/${slug}/controls/${controlId}/assignment`,
      body,
    ),

  capacity: (
    slug: string,
    what: {
      intervalS?: number
      concurrentViewers?: number
      agents?: number
      probesPerAgent?: number
    },
  ) => {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(what)) {
      if (value !== undefined && Number.isFinite(value)) query.set(key, String(value))
    }
    return request<{
      measured: { agents: number; probes: number; retentionDays: number }
      effective: {
        ingestRateLimitPerMinute: number
        dbPoolMax: number
        authRateLimitPerMinute: number
      }
      sizing: {
        pointsPerMinute: number
        ingestRequestsPerMinute: number
        readRequestsPerMinute: number
        rawPointsRetained: number
        rawStorageMb: number
        recommended: { ingestRateLimitPerMinute: number; dbPoolMax: number }
        notes: string[]
      }
    }>('GET', `/api/v1/${slug}/capacity?${query.toString()}`)
  },

  mailSettings: (slug: string) =>
    request<{
      host: string
      port: number
      secure: boolean
      from: string
      authenticated: boolean
      source: string
    }>('GET', `/api/v1/${slug}/notifications/mail`),

  testMail: (slug: string, to: string) =>
    request<{ sent: boolean; detail: string }>('POST', `/api/v1/${slug}/notifications/mail/test`, {
      to,
    }),

  webhooks: (slug: string) =>
    request<{ id: string; url: string; confirmed: boolean; hasSecret: boolean }[]>(
      'GET',
      `/api/v1/${slug}/notifications/webhooks`,
    ),

  addWebhook: (slug: string, url: string) =>
    request<{ id: string; secret: string }>('POST', `/api/v1/${slug}/notifications/webhooks`, {
      url,
    }),

  testWebhook: (slug: string, id: string) =>
    request<{ sent: boolean; detail: string }>(
      'POST',
      `/api/v1/${slug}/notifications/webhooks/${id}/test`,
    ),

  removeWebhook: (slug: string, id: string) =>
    request<{ ok: boolean }>('DELETE', `/api/v1/${slug}/notifications/webhooks/${id}`),

  updateAgent: (slug: string, id: string, body: { name?: string; site?: string | null }) =>
    request<{ ok: boolean }>('PATCH', `/api/v1/${slug}/agents/${id}`, body),

  bulkAgents: (slug: string, ids: string[], action: 'revoke' | 'delete') =>
    request<{ ok: boolean; affected: number }>('POST', `/api/v1/${slug}/agents/bulk`, {
      ids,
      action,
    }),

  revokeAgent: (slug: string, id: string) =>
    request<{ ok: boolean }>('DELETE', `/api/v1/${slug}/agents/${id}`),
}

export { ApiError }

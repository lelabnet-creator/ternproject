import type { Block } from '@tern/shared/blocks'
import type { IncidentImpactValue } from '@tern/shared/status'
import { ApiError } from './api'
import { sandboxOn } from './sandbox-flag'

/**
 * Authenticated client for the admin surface.
 *
 * Separate from the public client because these calls carry a session and can
 * write. Keeping them apart makes it obvious at the call site which surface a
 * screen is talking to.
 */

/**
 * The one seam the development sandbox needs.
 *
 * Every admin call goes through `request`, so a demo made writable in the
 * browser can be a single condition here rather than a branch on forty methods.
 * Both halves are inside `import.meta.env.DEV`, which is a constant at build
 * time: the condition folds away and `sandbox.ts` — never statically imported
 * anywhere — is left out of the production bundle entirely. The flag it reads
 * lives in a module of its own so that asking the question costs nothing.
 */
async function fromSandbox(
  method: string,
  path: string,
  body: unknown,
): Promise<{ handled: false } | { handled: true; value: unknown }> {
  if (!sandboxOn()) return { handled: false }

  const sandbox = await import('./sandbox')
  const value = await sandbox.answer(method, path, body, (where) => transmit<unknown>('GET', where))
  return value === sandbox.PASS ? { handled: false } : { handled: true, value }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (import.meta.env.DEV) {
    const answered = await fromSandbox(method, path, body)
    if (answered.handled) return answered.value as T
  }
  return transmit<T>(method, path, body)
}

async function transmit<T>(method: string, path: string, body?: unknown): Promise<T> {
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
    // Kept whole and handed on: a refusal that carries more than a sentence —
    // the import's list of issues — has nowhere else to survive.
    let body: unknown
    try {
      const parsed = (await response.json()) as { message?: string }
      body = parsed
      if (parsed.message) message = parsed.message
    } catch {
      // Non-JSON error body; the status line is all there is.
    }
    throw new ApiError(message, response.status, body)
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
  /** ISO. Null on a control that has never reported. */
  lastCheckAt: string | null
  lastCheckStatus: string | null
  /** Why that status — the scheduler's staleness note, or a failing assertion. */
  lastCheckMessage: string | null
  /** ISO. Last `operational`, and last `down`/`partial`, within retention. */
  lastSuccessAt: string | null
  lastFailureAt: string | null
}

/**
 * A folder controls are filed under.
 *
 * `parentId` makes this a tree rather than a flat list, so a page can be filed
 * the way the estate is actually shaped — "Europe > Paris > API". The API
 * refuses a cycle and a sixth level; nothing here needs to re-check that, but a
 * screen that walks down from the roots does have to expect an id it has never
 * seen, because the two lists are fetched separately and can be a moment apart.
 */
export interface ControlGroup {
  id: string
  name: string
  description: string | null
  /** Null at the top level. */
  parentId: string | null
  position: number
  /** How the folder's own status is derived: `worst`, `majority` or `manual`. */
  statusRollup: string
  collapsedByDefault: boolean
  /** Controls filed directly here. A child folder's own are counted under it. */
  controlCount: number
}

/** What a folder PATCH may carry. Creation is the same shape with a name. */
export interface ControlGroupPatch {
  name?: string
  description?: string | null
  parentId?: string | null
  position?: number
  statusRollup?: 'worst' | 'majority' | 'manual'
  collapsedByDefault?: boolean
}

/**
 * What an import did, or what it would have done.
 *
 * `dryRun` is echoed back rather than remembered by the caller: the screen
 * shows two different things for the two answers, and reading it off the
 * response means it can never show the wrong one for a request in flight.
 */
export interface ImportOutcome {
  dryRun: boolean
  created: number
  updated: number
  groupsCreated: number
  controls: { key: string; action: 'created' | 'updated' }[]
}

/**
 * One problem with an imported file, as the API sends it.
 *
 * Mirrors the 400 body in `apps/api/src/routes/controls-import.ts`. `null` where
 * the shared parser uses `undefined`, because JSON has no absent — the two are
 * reconciled in `features/control-import/issues.ts`.
 */
export interface ImportIssueWire {
  line: number | null
  column: number | null
  path: string
  key: string | null
  message: string
  received: string | null
  expected: string | null
  /** The same issue on one line, already formatted. */
  detail: string
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
  layout: 'list' | 'grid' | 'compact' | 'custom'
  accent: string
  /** Chosen typeface id. `fontById` in lib/fonts.ts turns it into a stack. */
  font: string
  logoUrl: string | null
  /**
   * When the setup wizard was answered, or null.
   *
   * Read from here rather than from the public summary's `branding`, which is
   * cached — see the note beside this field in `apps/api/src/routes/settings.ts`.
   */
  setupCompletedAt: string | null
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
    /** Accept a handshake OpenSSL refuses as too weak. See the settings panel. */
    allowWeakTls: boolean
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
    allowWeakTls?: boolean
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
  /** `agent`, or `proxy` when it relays for a zone with no route out. */
  role: string
  /** The proxy this one reports through. Null when it reaches the server itself. */
  parentAgentId: string | null
  /** The address it paired from. Null for an agent known only through a proxy. */
  pairedIp: string | null
  /**
   * Where a relay serves its zone, as the relay itself reports. Null for
   * anything that is not a relay, and for a relay too old to say.
   */
  zoneAddress: string | null
  /** Every address a relay says it can be dialled on. Empty if it never said. */
  zoneAddresses: string[]
  status: string
  lastSeenAt: string | null
  pairedAt: string
  jobCount: number
  controls: { id: string; key: string; name: string }[]
  scopeControlIds: string[]
  /** The instance's own agent — `Agent-local-tern`. Never revocable. */
  isLocal: boolean
  /**
   * Which network the local agent measures from — `service:app` or `host`, and
   * the difference decides whether `localhost` in a check means this machine or
   * the agent's own container. Null for a remote agent, whose network is its
   * own host's business.
   */
  networkMode: string | null
}

export interface ScriptBundle {
  languages: { id: string; label: string; extension: string; syntax: string }[]
  scripts: Record<string, string>
  agent: { config: string; pairCommand: string; runCommand: string }
}

export type IncidentSeverity = 'minor' | 'major' | 'critical'
export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved'

export interface IncidentImpact {
  controlId: string
  impact: IncidentImpactValue
}

/** One row of the list. The body of each update is included; the postmortem is not. */
export interface Incident {
  id: string
  title: string
  severity: IncidentSeverity
  status: IncidentStatus
  startedAt: string
  resolvedAt: string | null
  hasPostmortem: boolean
  impacts: IncidentImpact[]
  updates: { id: string; status: IncidentStatus; body: string; createdAt: string }[]
}

export type MaintenanceStatus = 'scheduled' | 'in_progress' | 'completed' | 'cancelled'

export interface Maintenance {
  id: string
  title: string
  body: string | null
  status: MaintenanceStatus
  scheduledStart: string
  scheduledEnd: string
  actualStart: string | null
  actualEnd: string | null
  autoTransition: boolean
  suppressAlerts: boolean
  isPublic: boolean
  /** Minutes before the window at which subscribers are reminded. */
  remindersBeforeMin: number[]
  /** Which of those marks have already gone out. */
  remindersSentAt: number[]
  controlIds: string[]
  updates: { id: string; status: MaintenanceStatus; body: string; createdAt: string }[]
}

/** What a PATCH may carry. What the API accepts narrows as the window advances. */
export interface MaintenancePatch {
  title?: string
  body?: string | null
  scheduledStart?: string
  scheduledEnd?: string
  controlIds?: string[]
  autoTransition?: boolean
  suppressAlerts?: boolean
  isPublic?: boolean
  remindersBeforeMin?: number[]
}

export interface ClassFigures {
  requests: number
  perMinute: number
  rateLimited: number
  failed: number
  /** Null when nothing was measured, or when every sample overflowed the histogram. */
  p50Ms: number | null
  p95Ms: number | null
}

export interface Monitoring {
  instance: { name: string; startedAt: string; minutesCovered: number }
  agents: {
    id: string
    name: string
    site: string | null
    status: string
    requests: number
    perMinute: number
  }[]
  /** Null unless the caller administers the system tenant. */
  platform: {
    inFlight: number
    byClass: Record<string, ClassFigures>
    perMinute: { minute: string; requests: number; rateLimited: number }[]
    limits: {
      ingestRateLimitPerMinute: number
      authRateLimitPerMinute: number
      dbPoolMax: number
    }
    pool: { open: number; active: number; max: number }
    unattributedRequests: number
  } | null
}

/**
 * An upgrade in flight, as the updater container reports it.
 *
 * `unavailable` and `idle` are both "nothing is happening" and mean different
 * things to the reader: one has no updater to ask, the other has one waiting.
 */
export interface UpdateProgress {
  state: 'unavailable' | 'idle' | 'running' | 'succeeded' | 'failed'
  target: string | null
  steps: {
    id: 'pull' | 'verify' | 'restart'
    label: string
    state: 'pending' | 'running' | 'done' | 'failed'
    /** 0–100, and only meaningful on the running step. */
    percent: number
    detail: string
  }[]
  startedAt: string | null
  updatedAt: string | null
  detail: string
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

  /**
   * Passkeys.
   *
   * The `options` calls return the WebAuthn payload untyped on purpose: it goes
   * straight into `@simplewebauthn/browser`, which owns that contract and types
   * it. Restating it here would be a copy free to drift.
   */
  passkeys: () =>
    request<
      {
        id: string
        name: string
        deviceType: string | null
        backedUp: boolean
        lastUsedAt: string | null
        createdAt: string
      }[]
    >('GET', '/api/v1/auth/passkeys'),

  passkeyRegisterOptions: () =>
    request<Record<string, unknown>>('POST', '/api/v1/auth/passkeys/register/options'),

  registerPasskey: (response: unknown, name: string) =>
    request<{ id: string; name: string; createdAt: string }>(
      'POST',
      '/api/v1/auth/passkeys/register',
      { response, name },
    ),

  removePasskey: (id: string) => request<{ ok: boolean }>('DELETE', `/api/v1/auth/passkeys/${id}`),

  passkeyLoginOptions: () =>
    request<Record<string, unknown>>('POST', '/api/v1/auth/passkeys/login/options'),

  passkeyLogin: (response: unknown) =>
    request<{ user: { id: string; email: string; name: string } }>(
      'POST',
      '/api/v1/auth/passkeys/login',
      { response },
    ),

  me: () =>
    request<{
      user: {
        id: string
        email: string
        name: string
        mfaEnabled: boolean
        /** Null while this person has never been walked through the admin. */
        tourSeenAt: string | null
      }
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

  /** `false` asks to be walked through the admin again. Stored on the account. */
  setTourSeen: (seen: boolean) =>
    request<{ tourSeenAt: string | null }>('PUT', '/api/v1/auth/me/tour', { seen }),

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

  /**
   * Applies a YAML file, or works out what it would do.
   *
   * `dryRun` takes the same code path on the server, which is what makes the
   * preview worth showing: a number computed by different code is a number that
   * can disagree with the import it precedes.
   *
   * A rejected file answers 400 with a list rather than a message; the list
   * arrives on `ApiError.body` and is read back by
   * `features/control-import/issues.ts`.
   */
  importControls: (slug: string, yaml: string, dryRun: boolean) =>
    request<ImportOutcome>('POST', `/api/v1/${slug}/controls/import`, { yaml, dryRun }),

  controlGroups: (slug: string) => request<ControlGroup[]>('GET', `/api/v1/${slug}/control-groups`),

  createControlGroup: (slug: string, body: ControlGroupPatch & { name: string }) =>
    request<ControlGroup>('POST', `/api/v1/${slug}/control-groups`, body),

  /** Renames and moves. A move that would close a loop is refused with a sentence. */
  updateControlGroup: (slug: string, id: string, body: ControlGroupPatch) =>
    request<ControlGroup>('PATCH', `/api/v1/${slug}/control-groups/${id}`, body),

  /**
   * Removes the folder.
   *
   * `unfile` — the default — keeps everything it held: children move up to its
   * parent, its controls are unfiled and still monitored. Deleting a folder is
   * a filing decision, so it must never *silently* be a decision about what is
   * monitored.
   *
   * `delete` is the other intention said out loud, for a service being
   * dismantled rather than a page being tidied. One transaction on the server,
   * because a folder half emptied is nobody's intention.
   */
  deleteControlGroup: (slug: string, id: string, controls: 'unfile' | 'delete' = 'unfile') =>
    request<{ deleted: number; unfiled: number }>(
      'DELETE',
      `/api/v1/${slug}/control-groups/${id}?controls=${controls}`,
    ),

  /**
   * Files a whole selection at once.
   *
   * One request rather than one per control: the gesture is a selection and a
   * destination, and N requests would leave the selection half moved behind the
   * first refusal, with no way to tell which half.
   */
  moveControls: (slug: string, controlIds: string[], groupId: string | null) =>
    request<{ moved: number }>('POST', `/api/v1/${slug}/controls/move`, { controlIds, groupId }),

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

  /** Runs this control's probe now and records the result, unlike `probeRun`. */
  checkNow: (slug: string, id: string) =>
    request<{
      at: string
      status: string
      latencyMs: number | null
      value: number | null
      message: string | null
    }>('POST', `/api/v1/${slug}/controls/${id}/check`),

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

  /**
   * One code, two possible verbs.
   *
   * The code does not carry a role: the server infers it from the version the
   * binary announces when it pairs. So both commands come back, and the screen
   * shows whichever the operator is adding — changing their mind costs a click,
   * not another PIN.
   */
  createPairingCode: (slug: string) =>
    request<{
      pin: string
      expiresAt: string
      pairCommand: string
      proxyPairCommand: string
    }>('POST', `/api/v1/${slug}/pairing-codes`, {}),

  updateLayout: (
    slug: string,
    body: {
      layout: 'list' | 'grid' | 'compact' | 'custom'
      order: { controlId: string }[]
      customHtml?: string
      customCss?: string
      customJs?: string
      customBlocks?: Block[]
    },
  ) => request<{ ok: boolean; reordered: number }>('PATCH', `/api/v1/${slug}/layout`, body),

  incidents: (slug: string, limit = 50) =>
    request<Incident[]>('GET', `/api/v1/${slug}/incidents?limit=${limit}`),

  /**
   * The detail, which the list does not carry.
   *
   * `postmortemBody` comes back `null` while the postmortem is an unpublished
   * draft — the API refuses to hand out a draft before its author published it.
   * A screen that lets someone save a draft has to say so, or they will come
   * back expecting to find their text.
   */
  incident: (slug: string, id: string) =>
    request<{
      id: string
      title: string
      severity: IncidentSeverity
      status: IncidentStatus
      startedAt: string
      resolvedAt: string | null
      postmortemBody: string | null
      postmortemPublishedAt: string | null
    }>('GET', `/api/v1/${slug}/incidents/${id}`),

  openIncident: (
    slug: string,
    body: {
      title: string
      severity: IncidentSeverity
      body: string
      impacts?: IncidentImpact[]
      isPublic?: boolean
      notify?: boolean
      startedAt?: string
    },
  ) => request<{ id: string }>('POST', `/api/v1/${slug}/incidents`, body),

  /**
   * Posting an update is also how an incident changes status, including how it
   * is resolved — there is no separate resolve call, because resolving without
   * saying anything is the thing this shape is meant to prevent.
   */
  addIncidentUpdate: (
    slug: string,
    id: string,
    body: {
      status: IncidentStatus
      body: string
      notify?: boolean
      impacts?: IncidentImpact[]
    },
  ) =>
    request<{ id: string; status: IncidentStatus }>(
      'POST',
      `/api/v1/${slug}/incidents/${id}/updates`,
      body,
    ),

  savePostmortem: (slug: string, id: string, body: { body: string; publish: boolean }) =>
    request<{ published: boolean }>('PUT', `/api/v1/${slug}/incidents/${id}/postmortem`, body),

  maintenances: (slug: string) => request<Maintenance[]>('GET', `/api/v1/${slug}/maintenances`),

  scheduleMaintenance: (
    slug: string,
    body: {
      title: string
      body?: string
      scheduledStart: string
      scheduledEnd: string
      controlIds?: string[]
      autoTransition?: boolean
      suppressAlerts?: boolean
      isPublic?: boolean
      remindersBeforeMin?: number[]
      notify?: boolean
    },
  ) => request<{ id: string }>('POST', `/api/v1/${slug}/maintenances`, body),

  updateMaintenance: (slug: string, id: string, body: MaintenancePatch) =>
    request<{ ok: boolean }>('PATCH', `/api/v1/${slug}/maintenances/${id}`, body),

  /** Also how the window is moved by hand when auto-transition is off. */
  addMaintenanceUpdate: (
    slug: string,
    id: string,
    body: { status: MaintenanceStatus; body: string; notify?: boolean },
  ) =>
    request<{ id: string; status: MaintenanceStatus }>(
      'POST',
      `/api/v1/${slug}/maintenances/${id}/updates`,
      body,
    ),

  /**
   * Cancels an announced window, deletes an unannounced one — the API decides
   * which, and says which it did.
   */
  cancelMaintenance: (slug: string, id: string, notify = true) =>
    request<{ deleted: boolean; cancelled: boolean }>(
      'DELETE',
      `/api/v1/${slug}/maintenances/${id}?notify=${notify}`,
    ),

  monitoring: (slug: string, minutes = 60) =>
    request<Monitoring>('GET', `/api/v1/${slug}/monitoring?minutes=${minutes}`),

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

  /**
   * Which build this is, and whether the registry has a newer one.
   *
   * `unknown` is a real answer and not a failure: an image built by hand
   * carries no version, and an instance that cannot reach the registry has not
   * learned that it is up to date. Both must read differently from `current`,
   * or the notice becomes reassurance nobody can rely on.
   */
  systemRelease: () =>
    request<{
      state: 'current' | 'update' | 'unknown'
      current: string | null
      latest: string | null
      revision: string | null
      image: string
      checkedAt: string
      detail: string
    }>('GET', '/api/v1/system/release'),

  /**
   * How an upgrade is going.
   *
   * `unavailable` is the ordinary answer: it means no updater container is
   * deployed beside the instance, so an upgrade is two commands on the host
   * rather than a button. Polled every couple of seconds while a bar is moving,
   * and cheap enough for that — it reads two small files.
   */
  updateProgress: () => request<UpdateProgress>('GET', '/api/v1/system/release/update'),

  /**
   * Asks the updater to apply the newest published release.
   *
   * No body: the target is whatever the registry says is newest, decided by the
   * API. 409 when there is nothing to apply or one is already running, 412 when
   * no updater is deployed.
   */
  applyUpdate: () =>
    request<{ id: string; target: string }>('POST', '/api/v1/system/release/update'),

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

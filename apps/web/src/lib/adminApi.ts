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

export interface ScriptBundle {
  languages: { id: string; label: string; extension: string; syntax: string }[]
  scripts: Record<string, string>
}

export interface ProbeRunResult {
  status: string
  latencyMs: number | null
  value: number | null
  message: string | null
  assertions: { type: string; passed: boolean; severity: string; detail: string }[]
}

export const adminApi = {
  me: () =>
    request<{
      user: { id: string; email: string; name: string; mfaEnabled: boolean }
      memberships: { tenantId: string; slug: string; name: string; role: string }[]
    }>('GET', '/api/v1/auth/me'),

  login: (email: string, password: string) =>
    request<{ mfaRequired: boolean }>('POST', '/api/v1/auth/login', { email, password }),

  verifyMfa: (code: string, backupCode = false) =>
    request<{ backupCodesRemaining: number }>('POST', '/api/v1/auth/mfa/verify', {
      code,
      backupCode,
    }),

  logout: () => request<{ ok: boolean }>('POST', '/api/v1/auth/logout'),

  controls: (slug: string) => request<Control[]>('GET', `/api/v1/${slug}/controls`),

  createControl: (slug: string, body: Partial<Control> & { key: string; name: string }) =>
    request<{ id: string; key: string }>('POST', `/api/v1/${slug}/controls`, body),

  updateControl: (slug: string, id: string, body: Partial<Control>) =>
    request<{ ok: boolean }>('PATCH', `/api/v1/${slug}/controls/${id}`, body),

  deleteControl: (slug: string, id: string) =>
    request<{ ok: boolean }>('DELETE', `/api/v1/${slug}/controls/${id}`),

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

  agents: (slug: string) =>
    request<
      { id: string; name: string; os: string | null; status: string; lastSeenAt: string | null }[]
    >('GET', `/api/v1/${slug}/agents`),
}

export { ApiError }

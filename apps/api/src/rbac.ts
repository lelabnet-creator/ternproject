/**
 * The permission matrix.
 *
 * Deliberately a table in code rather than rows in the database: three roles do
 * not need runtime configurability, and an auditor reading this file can see
 * every capability of every role at once. A permissions table would put that
 * answer behind a query and make it drift per tenant.
 */

export const ROLES = ['admin', 'user', 'visitor'] as const
export type Role = (typeof ROLES)[number]

export const PERMISSIONS = [
  /** Read controls marked public. */
  'status:read',
  /** Read every control, including internal ones. */
  'status:read:all',
  /** Read historical series beyond the current state. */
  'history:read',
  /** Subscribe to notifications. */
  'subscribe',

  'incident:write',
  'maintenance:write',

  'control:write',
  'receiver:manage',

  'tenant:settings',
  'domain:manage',
  'member:manage',
  'apikey:manage',
  'agent:manage',
  'viewer:manage',
  'subscriber:manage',
  'audit:read',
  'audit:export',
] as const
export type Permission = (typeof PERMISSIONS)[number]

const VISITOR: readonly Permission[] = ['status:read', 'history:read', 'subscribe']

const USER: readonly Permission[] = [
  ...VISITOR,
  'status:read:all',
  'incident:write',
  'maintenance:write',
]

/** Admin holds everything; listing it explicitly would only invite drift. */
const ADMIN: readonly Permission[] = PERMISSIONS

const MATRIX: Record<Role, readonly Permission[]> = {
  visitor: VISITOR,
  user: USER,
  admin: ADMIN,
}

/**
 * Anonymous callers on a public tenant are treated as visitors. They are given a
 * strict subset — no `subscribe` here, because subscribing writes a row and is
 * rate-limited separately on its own route.
 */
const ANONYMOUS: readonly Permission[] = ['status:read', 'history:read']

/**
 * What survives on a read-only tenant.
 *
 * An allowlist, not a list of things to block. A denylist answers "is this one
 * of the dangerous ones", which is the question that goes wrong when a
 * permission is added later and nobody remembers to classify it; an allowlist
 * answers "is this known to be safe", and a new permission is refused until
 * someone says otherwise. On a page anonymous visitors can open, that is the
 * direction the mistake has to fall.
 */
export const READ_ONLY_PERMISSIONS: readonly Permission[] = [
  'status:read',
  'status:read:all',
  'history:read',
]

/**
 * What an unauthenticated visitor gets on a demo tenant.
 *
 * Enough to walk through Controls, Incidents, Maintenance and the page layout —
 * the substance of the product — and nothing more. Deliberately short of
 * `subscriber:manage` (real addresses), `audit:read` (visitor IP addresses),
 * `apikey:manage` (an ingest key on a public URL) and `tenant:settings` (the
 * SMTP host and user). Those screens answer "insufficient permissions" to a
 * demo visitor, which is the honest outcome: a demo that leaks is not a demo.
 */
export const DEMO_PERMISSIONS: readonly Permission[] = [
  'status:read',
  'status:read:all',
  'history:read',
]

export function permissionsFor(role: Role | 'anonymous' | 'demo'): readonly Permission[] {
  if (role === 'anonymous') return ANONYMOUS
  if (role === 'demo') return DEMO_PERMISSIONS
  return MATRIX[role]
}

export function can(role: Role | 'anonymous' | 'demo', permission: Permission): boolean {
  return permissionsFor(role).includes(permission)
}

/**
 * Viewer sessions created by redeeming a QR token. Never map to a real account
 * and never gain a real role — a read-only device is exactly a visitor, minus
 * anything that writes.
 */
export const VIEWER_ROLE: Role = 'visitor'

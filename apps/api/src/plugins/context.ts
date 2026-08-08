import { and, eq, isNull } from 'drizzle-orm'
import fp from 'fastify-plugin'
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify'
import { schema } from '@tern/db'
import { can, READ_ONLY_PERMISSIONS, VIEWER_ROLE, type Permission, type Role } from '../rbac.js'
import { SESSION_COOKIE, findSession, viewerSessionIsLive } from '../services/sessions.js'

/**
 * Resolves who is calling and which tenant they are acting on, once per
 * request, and exposes the permission check every route uses.
 *
 * Deliberately one plugin rather than three: identity, tenant and authorisation
 * are a single question — "may this caller do this here" — and splitting them
 * invites a route that resolves one and forgets another.
 */

export interface RequestActor {
  kind: 'user' | 'viewer' | 'anonymous'
  userId?: string
  sessionId?: string
  mfaSatisfied: boolean
  /** Controls this caller may see; empty means "no restriction". */
  scopeControlIds: string[]
}

export interface TenantContext {
  id: string
  slug: string
  retentionMode: 'live' | 'historical'
  retentionDays: number
  rawRetentionHours: number
  defaultLocale: string
  defaultTimezone: string
  /** Carries synthetic data, and says so. Its admin opens without a session. */
  isDemo: boolean
  /** Refuses every write, whoever is asking. */
  readOnly: boolean
}

declare module 'fastify' {
  interface FastifyRequest {
    actor: RequestActor
    tenant: TenantContext | null
    role: Role | 'anonymous' | 'demo'
    can(permission: Permission): boolean
  }
  interface FastifyInstance {
    requirePermission(permission: Permission): (req: FastifyRequest) => Promise<void>
    requireTenant(): (req: FastifyRequest) => Promise<void>
  }
}

const ANONYMOUS: RequestActor = { kind: 'anonymous', mfaSatisfied: false, scopeControlIds: [] }

const plugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest('actor', undefined as unknown as RequestActor)
  app.decorateRequest('tenant', null as TenantContext | null)
  app.decorateRequest('role', 'anonymous')

  app.decorateRequest('can', function (this: FastifyRequest, permission: Permission) {
    return can(this.role, permission)
  })

  app.addHook('onRequest', async (req) => {
    req.actor = ANONYMOUS
    req.tenant = null
    req.role = 'anonymous'

    const token = req.cookies[SESSION_COOKIE]
    if (!token) return

    const session = await findSession(app.db, token)
    if (!session) return

    if (session.viewerTokenId) {
      // Re-checked every request: a revoked device or an expired token has to
      // lose access immediately, not at the end of the session's lifetime.
      const live = await viewerSessionIsLive(app.db, session.viewerTokenId)
      if (!live) return

      const [viewerToken] = await app.db
        .select({ scopeControlIds: schema.viewerTokens.scopeControlIds })
        .from(schema.viewerTokens)
        .where(eq(schema.viewerTokens.id, session.viewerTokenId))
        .limit(1)

      req.actor = {
        kind: 'viewer',
        sessionId: session.id,
        mfaSatisfied: true,
        scopeControlIds: viewerToken?.scopeControlIds ?? [],
      }
      return
    }

    if (!session.userId) return

    const [user] = await app.db
      .select({ id: schema.users.id, disabledAt: schema.users.disabledAt })
      .from(schema.users)
      .where(and(eq(schema.users.id, session.userId), isNull(schema.users.disabledAt)))
      .limit(1)
    if (!user) return

    req.actor = {
      kind: 'user',
      userId: session.userId,
      sessionId: session.id,
      mfaSatisfied: session.mfaSatisfied,
      scopeControlIds: [],
    }
  })

  /**
   * Resolves the tenant from the route and decides the caller's role in it.
   *
   * A private tenant the caller may not see returns 404, not 403: 403 confirms
   * the tenant exists, which is exactly what a private page is meant not to
   * disclose.
   */
  app.decorate('requireTenant', () => async (req: FastifyRequest) => {
    const params = req.params as { slug?: string }
    if (!params.slug) throw app.httpErrors.badRequest('Missing tenant slug')

    const [tenant] = await app.db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, params.slug))
      .limit(1)

    if (!tenant) throw app.httpErrors.notFound('Not found')

    req.tenant = {
      id: tenant.id,
      slug: tenant.slug,
      retentionMode: tenant.retentionMode,
      retentionDays: tenant.retentionDays,
      rawRetentionHours: tenant.rawRetentionHours,
      defaultLocale: tenant.defaultLocale,
      defaultTimezone: tenant.defaultTimezone,
      isDemo: tenant.isDemo,
      readOnly: tenant.readOnly,
    }

    // A status page is readable by whoever has its address. There is no gate
    // here: `anonymous` is a role with public-read permissions, and every
    // endpoint that needs more asks for it through `requirePermission`.
    req.role = await resolveRole(app, req, tenant.id, tenant.isDemo)
  })

  app.decorate('requirePermission', (permission: Permission) => async (req: FastifyRequest) => {
    if (!req.tenant) throw app.httpErrors.internalServerError('Tenant not resolved')

    /*
     * Read-only is settled before the role is, and for everyone.
     *
     * Here rather than in the permission matrix because it is a property of the
     * page, not of the caller: an admin of a read-only tenant is still refused,
     * which is what makes the demo safe to leave open. And here rather than at
     * each route because a check repeated at forty call sites is a check
     * missing from the forty-first.
     */
    if (req.tenant.readOnly && !READ_ONLY_PERMISSIONS.includes(permission)) {
      throw app.httpErrors.forbidden('This page is read-only')
    }

    if (!can(req.role, permission)) {
      throw req.role === 'anonymous'
        ? app.httpErrors.unauthorized('Authentication required')
        : app.httpErrors.forbidden('Insufficient permissions')
    }

    // A session that has passed the password but not the second factor must not
    // reach anything beyond the MFA routes themselves.
    if (req.actor.kind === 'user' && !req.actor.mfaSatisfied) {
      throw app.httpErrors.unauthorized('Second factor required')
    }
  })
}

async function resolveRole(
  app: FastifyInstance,
  req: FastifyRequest,
  tenantId: string,
  isDemo: boolean,
): Promise<Role | 'anonymous' | 'demo'> {
  if (req.actor.kind === 'viewer') return VIEWER_ROLE

  if (req.actor.kind === 'user' && req.actor.userId) {
    const [membership] = await app.db
      .select({ role: schema.memberships.role })
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.userId, req.actor.userId),
          eq(schema.memberships.tenantId, tenantId),
        ),
      )
      .limit(1)
    if (membership) return membership.role
  }

  /*
   * A demo page lets a stranger into its admin.
   *
   * That is the whole point of a demo: the product can be looked at rather than
   * described. It is only defensible next to `readOnly`, which the seeded
   * tenant also sets — the two are meant to travel together, and a demo tenant
   * that is writable would be a public page anyone could edit.
   */
  if (isDemo) return 'demo'

  // No membership: `anonymous`, which grants public read and nothing more.
  // What that is enough for is each endpoint's decision, expressed as the
  // permission it requires.
  return 'anonymous'
}

export default fp(plugin, { name: 'context', dependencies: ['db'] })

import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { schema } from '@tern/db'

/**
 * Membership of a system tenant, with the admin role.
 *
 * Checked here rather than through the permission table because this is not a
 * per-tenant permission — it is a property of the instance. Shared so that every
 * surface exposing instance-wide figures asks the same question; a second copy
 * of this test is a second place for it to be relaxed.
 */
export async function isPlatformAdmin(
  app: FastifyInstance,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!userId) return false

  const [membership] = await app.db
    .select({ tenantId: schema.memberships.tenantId })
    .from(schema.memberships)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.memberships.tenantId))
    .where(
      and(
        eq(schema.memberships.userId, userId),
        eq(schema.memberships.role, 'admin'),
        eq(schema.tenants.isSystem, true),
      ),
    )
    .limit(1)

  return membership !== undefined
}

/**
 * The same test, as a guard.
 *
 * 404 rather than 403: an ordinary admin probing this path should not learn that
 * a platform surface exists.
 */
export async function requirePlatformAdmin(
  app: FastifyInstance,
  userId: string | null | undefined,
): Promise<void> {
  if (!userId) throw app.httpErrors.unauthorized('Sign in required')
  if (!(await isPlatformAdmin(app, userId))) throw app.httpErrors.notFound()
}

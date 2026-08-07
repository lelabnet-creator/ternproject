import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { schema } from '@tern/db'

/**
 * Rejects control ids that belong to another tenant.
 *
 * Without this an admin could attach a competitor's component to their own
 * incident or maintenance window by guessing a uuid — the row would then be
 * readable through the public summary of that other tenant.
 *
 * Shared by every route that accepts a caller-supplied list of control ids, so
 * that the check cannot drift between them. A copy per route is a copy that
 * eventually gets one condition fewer.
 */
export async function assertControlsBelong(
  app: FastifyInstance,
  tenantId: string,
  controlIds: string[],
): Promise<void> {
  if (controlIds.length === 0) return
  const unique = [...new Set(controlIds)]

  const found = await app.db
    .select({ id: schema.controls.id })
    .from(schema.controls)
    .where(and(eq(schema.controls.tenantId, tenantId), inArray(schema.controls.id, unique)))

  if (found.length !== unique.length) {
    throw app.httpErrors.badRequest('One or more controls do not belong to this tenant')
  }
}

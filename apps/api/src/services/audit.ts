import type { FastifyInstance } from 'fastify'
import { schema } from '@tern/db'

export interface AuditEntry {
  action: string
  tenantId?: string
  actorId?: string
  /** For non-user actors: an agent name, a receiver, an attempted email. */
  actorLabel?: string
  target?: string
  meta?: Record<string, unknown>
  ip?: string
}

/**
 * Appends to the audit trail.
 *
 * Never rejects. An audit write failing must not turn a successful login into a
 * 500 — losing one trail entry is bad, refusing service because of it is worse.
 * The failure is logged so the gap is visible rather than silent.
 */
export async function audit(app: FastifyInstance, entry: AuditEntry): Promise<void> {
  try {
    await app.db.insert(schema.auditLog).values({
      tenantId: entry.tenantId ?? null,
      actorId: entry.actorId ?? null,
      actorLabel: entry.actorLabel ?? null,
      action: entry.action,
      target: entry.target ?? null,
      meta: entry.meta ?? {},
      ip: entry.ip ?? null,
    })
  } catch (error) {
    app.log.error({ err: error, action: entry.action }, 'failed to write audit entry')
  }
}

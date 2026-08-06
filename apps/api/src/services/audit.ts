import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { schema } from '@tern/db'
import { render, send, type SyslogTarget } from './syslog.js'

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
/**
 * A tenant's collector, remembered briefly.
 *
 * The mirror must not add a settings read to every audited action. Sixty
 * seconds is short enough that turning forwarding off takes effect while
 * someone is still looking at the screen, and long enough that a burst of
 * changes costs one query rather than twenty.
 */
const collectors = new Map<string, { target: SyslogTarget | null; readAt: number }>()
const COLLECTOR_TTL_MS = 60_000

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

  // After the row, never before, and never awaited into the caller's failure
  // path: the local trail is the record, and a collector that is down must not
  // fail the action that produced the entry.
  void mirror(app, entry)
}

async function mirror(app: FastifyInstance, entry: AuditEntry): Promise<void> {
  if (!entry.tenantId) return

  try {
    const cached = collectors.get(entry.tenantId)
    let target = cached?.target ?? null

    if (!cached || Date.now() - cached.readAt > COLLECTOR_TTL_MS) {
      const [tenant] = await app.db
        .select({ slug: schema.tenants.slug, syslog: schema.tenants.syslog })
        .from(schema.tenants)
        .where(eq(schema.tenants.id, entry.tenantId))
        .limit(1)

      target = (tenant?.syslog as SyslogTarget | null) ?? null
      collectors.set(entry.tenantId, { target, readAt: Date.now() })
      if (tenant) slugs.set(entry.tenantId, tenant.slug)
    }

    if (!target) return

    await send(
      render(
        {
          timestamp: new Date(),
          tenantSlug: slugs.get(entry.tenantId) ?? entry.tenantId,
          action: entry.action,
          actor: await actorName(app, entry),
          target: entry.target,
          ip: entry.ip,
          meta: entry.meta,
        },
        target,
      ),
      target,
    )
  } catch (error) {
    // Logged, not raised. The audit row is already written; this is a copy.
    app.log.warn({ err: error, action: entry.action }, 'could not mirror audit entry to syslog')
  }
}

const slugs = new Map<string, string>()

/**
 * Actor emails, cached like the collectors.
 *
 * Without this the mirrored line reads "revoked by 3f2b8c…", which a collector
 * cannot act on and a person cannot recognise. The audit *table* resolves it
 * with a join; a syslog line has to carry it.
 */
const actors = new Map<string, string>()

async function actorName(app: FastifyInstance, entry: AuditEntry): Promise<string> {
  if (entry.actorLabel) return entry.actorLabel
  if (!entry.actorId) return 'system'

  const cached = actors.get(entry.actorId)
  if (cached) return cached

  const [user] = await app.db
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, entry.actorId))
    .limit(1)

  const name = user?.email ?? entry.actorId
  actors.set(entry.actorId, name)
  return name
}

/** Called when a tenant's settings change, so a new collector is used at once. */
export function forgetCollector(tenantId: string): void {
  collectors.delete(tenantId)
}

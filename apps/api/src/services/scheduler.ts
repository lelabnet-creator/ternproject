import { and, eq, isNull, lte, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { schema } from '@tern/db'
import { enqueueEvent } from './notify.js'

/**
 * Background jobs.
 *
 * Every function here is idempotent and safe to run twice: they are driven by a
 * timer, and a restart mid-tick must not double-announce a maintenance window or
 * skip one.
 */

/**
 * Moves maintenance windows through their lifecycle.
 *
 * Automatic transitions exist because the alternative is someone remembering to
 * press a button at 02:00. A window that says "scheduled" an hour after it began
 * is worse than no window at all.
 */
export async function advanceMaintenances(app: FastifyInstance): Promise<{
  started: number
  completed: number
}> {
  const now = new Date()

  const starting = await app.db
    .update(schema.maintenances)
    .set({ status: 'in_progress', actualStart: now })
    .where(
      and(
        eq(schema.maintenances.status, 'scheduled'),
        eq(schema.maintenances.autoTransition, true),
        lte(schema.maintenances.scheduledStart, now),
      ),
    )
    .returning()

  for (const maintenance of starting) {
    await enqueueEvent(app, {
      tenantId: maintenance.tenantId,
      eventType: 'maintenance.started',
      payload: { maintenanceId: maintenance.id, title: maintenance.title },
    })
  }

  const completing = await app.db
    .update(schema.maintenances)
    .set({ status: 'completed', actualEnd: now })
    .where(
      and(
        eq(schema.maintenances.status, 'in_progress'),
        eq(schema.maintenances.autoTransition, true),
        lte(schema.maintenances.scheduledEnd, now),
      ),
    )
    .returning()

  for (const maintenance of completing) {
    await enqueueEvent(app, {
      tenantId: maintenance.tenantId,
      eventType: 'maintenance.completed',
      payload: { maintenanceId: maintenance.id, title: maintenance.title },
    })
  }

  return { started: starting.length, completed: completing.length }
}

/**
 * Sends the "starts in N minutes" reminders.
 *
 * Which reminders have already gone out is recorded on the row rather than
 * inferred from the clock. Inferring it means a worker that was down over the
 * −24h mark either sends nothing or sends it late and wrong; recording it means
 * a restart resumes exactly where it left off.
 */
export async function sendMaintenanceReminders(app: FastifyInstance): Promise<number> {
  const now = Date.now()

  const upcoming = await app.db
    .select()
    .from(schema.maintenances)
    .where(eq(schema.maintenances.status, 'scheduled'))

  let sent = 0

  for (const maintenance of upcoming) {
    const minutesUntil = (maintenance.scheduledStart.getTime() - now) / 60_000
    if (minutesUntil < 0) continue

    const due = maintenance.remindersBeforeMin.filter(
      (mark) => minutesUntil <= mark && !maintenance.remindersSentAt.includes(mark),
    )
    if (due.length === 0) continue

    // Only the closest mark is announced when several are due at once — a worker
    // that was down for a day should not fire the −24h and −1h reminders back to
    // back into someone's inbox.
    const mark = Math.min(...due)

    await enqueueEvent(app, {
      tenantId: maintenance.tenantId,
      eventType: 'maintenance.reminder',
      payload: {
        maintenanceId: maintenance.id,
        title: maintenance.title,
        minutesUntil: mark,
        scheduledStart: maintenance.scheduledStart.toISOString(),
      },
    })

    await app.db
      .update(schema.maintenances)
      .set({ remindersSentAt: [...new Set([...maintenance.remindersSentAt, ...due])] })
      .where(eq(schema.maintenances.id, maintenance.id))

    sent++
  }

  return sent
}

/**
 * Marks push controls that have gone quiet.
 *
 * `unknown`, never `down`: silence from a probe means we stopped hearing, which
 * is not the same claim as the service being broken. Reporting it as an outage
 * turns every agent restart into a public incident.
 */
export async function sweepStaleControls(
  app: FastifyInstance,
  /**
   * Restricts the sweep to one tenant. Production runs it across all of them,
   * but a test that sweeps globally writes rows into every other tenant's
   * history — including the demo data someone is looking at.
   */
  tenantId?: string,
): Promise<number> {
  const rows = await app.sql<{ id: string; tenant_id: string }[]>`
    SELECT c.id, c.tenant_id
      FROM controls c
      LEFT JOIN LATERAL (
        SELECT ts, status FROM checks
         WHERE control_id = c.id
         ORDER BY ts DESC
         LIMIT 1
      ) last ON TRUE
     WHERE c.enabled
       ${tenantId ? app.sql`AND c.tenant_id = ${tenantId}::uuid` : app.sql``}
       AND c.kind = 'push'
       AND c.expected_interval_s IS NOT NULL
       AND (last.ts IS NULL OR last.ts < now() - (c.expected_interval_s * 2 || ' seconds')::interval)
       AND (last.status IS NULL OR last.status <> 'unknown')
       -- A control inside a maintenance window that suppresses alerts is
       -- expected to go quiet. Reporting that as lost contact is noise the
       -- operator explicitly asked not to receive.
       AND NOT EXISTS (
         SELECT 1 FROM maintenance_controls mc
           JOIN maintenances m ON m.id = mc.maintenance_id
          WHERE mc.control_id = c.id
            AND m.status = 'in_progress'
            AND m.suppress_alerts
       )
  `

  if (rows.length === 0) return 0

  await app.db.insert(schema.checks).values(
    rows.map((row) => ({
      tenantId: row.tenant_id,
      controlId: row.id,
      status: 'unknown' as const,
      message: 'No data received within the expected interval',
    })),
  )

  return rows.length
}

/**
 * Deletes data past each tenant's own retention window.
 *
 * TimescaleDB retention policies act per hypertable, but tenants configure
 * different windows, so this runs per tenant. The hypertable policy remains as a
 * backstop for the longest window the product allows.
 */
export async function applyRetention(app: FastifyInstance): Promise<number> {
  const tenants = await app.db
    .select({
      id: schema.tenants.id,
      retentionMode: schema.tenants.retentionMode,
      retentionDays: schema.tenants.retentionDays,
      rawRetentionHours: schema.tenants.rawRetentionHours,
    })
    .from(schema.tenants)

  let deleted = 0

  for (const tenant of tenants) {
    const hours =
      tenant.retentionMode === 'live'
        ? tenant.rawRetentionHours
        : Math.max(tenant.rawRetentionHours, tenant.retentionDays * 24)

    const result = await app.sql`
      DELETE FROM checks
       WHERE tenant_id = ${tenant.id}::uuid
         AND ts < now() - (${hours} || ' hours')::interval
    `
    deleted += result.count ?? 0
  }

  return deleted
}

/** Deletes simulation rows for one control, so a demo can be undone in one click. */
export async function purgeSyntheticChecks(
  app: FastifyInstance,
  controlId: string,
): Promise<number> {
  const result = await app.db
    .delete(schema.checks)
    .where(and(eq(schema.checks.controlId, controlId), eq(schema.checks.synthetic, true)))
    .returning({ controlId: schema.checks.controlId })
  return result.length
}

/** Removes sessions that have expired, so the table does not grow without bound. */
export async function purgeExpired(app: FastifyInstance): Promise<void> {
  await app.db.delete(schema.sessions).where(sql`${schema.sessions.expiresAt} < now()`)
  await app.db
    .delete(schema.pairingCodes)
    .where(
      and(
        isNull(schema.pairingCodes.consumedAt),
        sql`${schema.pairingCodes.expiresAt} < now() - interval '7 days'`,
      ),
    )
}

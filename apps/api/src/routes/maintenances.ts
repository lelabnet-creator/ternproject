import { and, asc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import { audit } from '../services/audit.js'
import { enqueueEvent } from '../services/notify.js'
import { assertControlsBelong } from '../services/tenant-guard.js'

/**
 * Planned work.
 *
 * Everything downstream of creating a window already existed — the scheduler
 * moves windows through their lifecycle, reminders go out before they open, the
 * public page renders them, and `sweepStaleControls` stays quiet for controls
 * inside one. It was a complete machine with its intake unplugged.
 *
 * Two questions this file has to answer, because the schema does not:
 *
 *   1. *Can a window be edited once it has opened?* Partly. Before it starts,
 *      everything is fair game. Once it is in progress its start is history, so
 *      the schedule freezes and only the wording, the end, and the two
 *      behaviour flags may still change — an operator overrunning a window needs
 *      to push the end, and that is the one edit that actually happens at 03:00.
 *      Once it is over, only the wording: the record of when it ran is not a
 *      field to correct after the fact.
 *
 *   2. *What happens to a window whose controls are deleted?* The foreign key
 *      already cascades, so the window survives with fewer components rather
 *      than disappearing with them. That is the right answer — the work still
 *      happened — but it means a window can end up affecting nothing at all,
 *      which the list reports rather than hides.
 */

const statusSchema = z.enum(['scheduled', 'in_progress', 'completed', 'cancelled'])

/**
 * Reminder marks, in minutes before the window.
 *
 * Capped at a week: a reminder further out than that is an announcement, and
 * announcements are what the window itself is for. Bounded in count as well —
 * each mark is a fan-out to every subscriber.
 */
const remindersSchema = z
  .array(z.number().int().min(1).max(10_080))
  .max(5)
  .transform((marks) => [...new Set(marks)].sort((a, b) => b - a))

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/:slug/maintenances',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('status:read')],
      schema: {
        params: z.object({ slug: z.string() }),
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              title: z.string(),
              body: z.string().nullable(),
              status: statusSchema,
              scheduledStart: z.string(),
              scheduledEnd: z.string(),
              actualStart: z.string().nullable(),
              actualEnd: z.string().nullable(),
              autoTransition: z.boolean(),
              suppressAlerts: z.boolean(),
              isPublic: z.boolean(),
              remindersBeforeMin: z.array(z.number()),
              remindersSentAt: z.array(z.number()),
              controlIds: z.array(z.string()),
              updates: z.array(
                z.object({
                  id: z.string(),
                  status: statusSchema,
                  body: z.string(),
                  createdAt: z.string(),
                }),
              ),
            }),
          ),
        },
      },
    },
    async (req) => {
      const canSeePrivate = req.can('maintenance:write')

      const rows = await app.db
        .select()
        .from(schema.maintenances)
        .where(
          and(
            eq(schema.maintenances.tenantId, req.tenant!.id),
            canSeePrivate ? undefined : eq(schema.maintenances.isPublic, true),
          ),
        )
        // Soonest first, unlike incidents: a maintenance list is read forwards,
        // to see what is coming.
        .orderBy(asc(schema.maintenances.scheduledStart))
        .limit(req.query.limit)

      if (rows.length === 0) return []
      const ids = rows.map((r) => r.id)

      const [links, updates] = await Promise.all([
        app.db
          .select()
          .from(schema.maintenanceControls)
          .where(inArray(schema.maintenanceControls.maintenanceId, ids)),
        app.db
          .select()
          .from(schema.maintenanceUpdates)
          .where(inArray(schema.maintenanceUpdates.maintenanceId, ids))
          .orderBy(schema.maintenanceUpdates.createdAt),
      ])

      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        status: row.status,
        scheduledStart: row.scheduledStart.toISOString(),
        scheduledEnd: row.scheduledEnd.toISOString(),
        actualStart: row.actualStart?.toISOString() ?? null,
        actualEnd: row.actualEnd?.toISOString() ?? null,
        autoTransition: row.autoTransition,
        suppressAlerts: row.suppressAlerts,
        isPublic: row.isPublic,
        remindersBeforeMin: row.remindersBeforeMin,
        remindersSentAt: row.remindersSentAt,
        controlIds: links.filter((l) => l.maintenanceId === row.id).map((l) => l.controlId),
        updates: updates
          .filter((u) => u.maintenanceId === row.id)
          .map((u) => ({
            id: u.id,
            status: u.status,
            body: u.body,
            createdAt: u.createdAt.toISOString(),
          })),
      }))
    },
  )

  app.post(
    '/:slug/maintenances',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('maintenance:write')],
      schema: {
        params: z.object({ slug: z.string() }),
        body: z.object({
          title: z.string().min(1).max(200),
          body: z.string().max(10_000).optional(),
          scheduledStart: z.coerce.date(),
          scheduledEnd: z.coerce.date(),
          controlIds: z.array(z.string().uuid()).default([]),
          autoTransition: z.boolean().default(true),
          suppressAlerts: z.boolean().default(true),
          isPublic: z.boolean().default(true),
          remindersBeforeMin: remindersSchema.default([1440, 60]),
          /** Announce it now, rather than waiting for the first reminder mark. */
          notify: z.boolean().default(true),
        }),
        response: { 201: z.object({ id: z.string() }) },
      },
    },
    async (req, reply) => {
      const tenantId = req.tenant!.id
      assertWindow(app, req.body.scheduledStart, req.body.scheduledEnd)
      await assertControlsBelong(app, tenantId, req.body.controlIds)

      const [maintenance] = await app.db
        .insert(schema.maintenances)
        .values({
          tenantId,
          title: req.body.title,
          body: req.body.body ?? null,
          scheduledStart: req.body.scheduledStart,
          scheduledEnd: req.body.scheduledEnd,
          autoTransition: req.body.autoTransition,
          suppressAlerts: req.body.suppressAlerts,
          isPublic: req.body.isPublic,
          remindersBeforeMin: req.body.remindersBeforeMin,
          createdBy: req.actor.userId ?? null,
        })
        .returning()
      if (!maintenance) throw app.httpErrors.internalServerError('Failed to create maintenance')

      if (req.body.controlIds.length > 0) {
        await app.db.insert(schema.maintenanceControls).values(
          req.body.controlIds.map((controlId) => ({
            maintenanceId: maintenance.id,
            controlId,
          })),
        )
      }

      if (req.body.notify && req.body.isPublic) {
        await enqueueEvent(app, {
          tenantId,
          eventType: 'maintenance.scheduled',
          payload: {
            maintenanceId: maintenance.id,
            title: maintenance.title,
            body: maintenance.body ?? '',
            scheduledStart: maintenance.scheduledStart.toISOString(),
            scheduledEnd: maintenance.scheduledEnd.toISOString(),
          },
          controlIds: req.body.controlIds,
        })
      }

      await audit(app, {
        action: 'maintenance.scheduled',
        tenantId,
        actorId: req.actor.userId,
        target: maintenance.id,
        ip: req.ip,
      })

      return reply.code(201).send({ id: maintenance.id })
    },
  )

  app.patch(
    '/:slug/maintenances/:id',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('maintenance:write')],
      schema: {
        params: z.object({ slug: z.string(), id: z.string().uuid() }),
        body: z.object({
          title: z.string().min(1).max(200).optional(),
          body: z.string().max(10_000).nullable().optional(),
          scheduledStart: z.coerce.date().optional(),
          scheduledEnd: z.coerce.date().optional(),
          controlIds: z.array(z.string().uuid()).optional(),
          autoTransition: z.boolean().optional(),
          suppressAlerts: z.boolean().optional(),
          isPublic: z.boolean().optional(),
          remindersBeforeMin: remindersSchema.optional(),
        }),
        response: { 200: z.object({ ok: z.boolean() }) },
      },
    },
    async (req) => {
      const tenantId = req.tenant!.id
      const current = await loadMaintenance(app, tenantId, req.params.id)

      /*
       * What may still change depends on where the window is in its life. The
       * rule is not about tidiness: a window that has already opened has told
       * subscribers when it began, and a window that is over is a record.
       */
      const frozen = frozenFields(current.status, req.body)
      if (frozen.length > 0) {
        throw app.httpErrors.conflict(
          `A ${current.status.replace('_', ' ')} maintenance cannot change ${frozen.join(', ')}`,
        )
      }

      const scheduledStart = req.body.scheduledStart ?? current.scheduledStart
      const scheduledEnd = req.body.scheduledEnd ?? current.scheduledEnd
      assertWindow(app, scheduledStart, scheduledEnd)

      if (req.body.controlIds) {
        await assertControlsBelong(app, tenantId, req.body.controlIds)
      }

      /*
       * Moving the window forward un-sends the reminders it has outrun.
       *
       * Postponing a window from tomorrow to next week leaves the −24h mark
       * recorded as sent, and without this the reminder everyone actually reads
       * would never fire again. Only marks that are genuinely in the future are
       * cleared, so pulling a window closer does not re-send anything.
       */
      const marks = req.body.remindersBeforeMin ?? current.remindersBeforeMin
      const minutesUntil = (scheduledStart.getTime() - Date.now()) / 60_000
      const remindersSentAt = current.remindersSentAt.filter(
        (mark) => marks.includes(mark) && minutesUntil <= mark,
      )

      await app.db
        .update(schema.maintenances)
        .set({
          ...(req.body.title !== undefined && { title: req.body.title }),
          ...(req.body.body !== undefined && { body: req.body.body }),
          ...(req.body.autoTransition !== undefined && { autoTransition: req.body.autoTransition }),
          ...(req.body.suppressAlerts !== undefined && { suppressAlerts: req.body.suppressAlerts }),
          ...(req.body.isPublic !== undefined && { isPublic: req.body.isPublic }),
          scheduledStart,
          scheduledEnd,
          remindersBeforeMin: marks,
          remindersSentAt,
        })
        .where(eq(schema.maintenances.id, current.id))

      if (req.body.controlIds) {
        await app.db
          .delete(schema.maintenanceControls)
          .where(eq(schema.maintenanceControls.maintenanceId, current.id))
        if (req.body.controlIds.length > 0) {
          await app.db.insert(schema.maintenanceControls).values(
            req.body.controlIds.map((controlId) => ({
              maintenanceId: current.id,
              controlId,
            })),
          )
        }
      }

      await audit(app, {
        action: 'maintenance.updated',
        tenantId,
        actorId: req.actor.userId,
        target: current.id,
        ip: req.ip,
      })

      return { ok: true }
    },
  )

  /**
   * An update, and the manual way to move the window.
   *
   * `autoTransition` covers the ordinary case; this is what an operator uses
   * when the work finished early, ran long, or never started.
   */
  app.post(
    '/:slug/maintenances/:id/updates',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('maintenance:write')],
      schema: {
        params: z.object({ slug: z.string(), id: z.string().uuid() }),
        body: z.object({
          status: statusSchema,
          body: z.string().min(1).max(10_000),
          notify: z.boolean().default(true),
        }),
        response: { 201: z.object({ id: z.string(), status: statusSchema }) },
      },
    },
    async (req, reply) => {
      const tenantId = req.tenant!.id
      const current = await loadMaintenance(app, tenantId, req.params.id)

      const [update] = await app.db
        .insert(schema.maintenanceUpdates)
        .values({
          maintenanceId: current.id,
          authorId: req.actor.userId ?? null,
          status: req.body.status,
          body: req.body.body,
          notify: req.body.notify,
        })
        .returning()
      if (!update) throw app.httpErrors.internalServerError('Failed to add update')

      const now = new Date()
      await app.db
        .update(schema.maintenances)
        .set({
          status: req.body.status,
          // Stamped on the first transition only, exactly as the scheduler does
          // it: moving a window back to in_progress must not rewrite when the
          // work originally began.
          ...(req.body.status === 'in_progress' && {
            actualStart: current.actualStart ?? now,
          }),
          ...((req.body.status === 'completed' || req.body.status === 'cancelled') && {
            actualEnd: current.actualEnd ?? now,
          }),
        })
        .where(eq(schema.maintenances.id, current.id))

      if (req.body.notify && current.isPublic) {
        await enqueueEvent(app, {
          tenantId,
          eventType: EVENT_FOR_STATUS[req.body.status],
          payload: {
            maintenanceId: current.id,
            title: current.title,
            body: req.body.body,
          },
        })
      }

      await audit(app, {
        action: `maintenance.${req.body.status}`,
        tenantId,
        actorId: req.actor.userId,
        target: current.id,
        ip: req.ip,
      })

      return reply.code(201).send({ id: update.id, status: req.body.status })
    },
  )

  /**
   * Cancelling, and the narrow case where deleting is honest.
   *
   * A window nobody was told about — still scheduled, no reminder sent, nothing
   * written on it — is a draft, and deleting a draft leaves no one confused. Any
   * other window has been announced, so it is cancelled and said out loud:
   * removing it silently leaves subscribers expecting work that will never
   * happen, which is worse than the noise of one more mail.
   */
  app.delete(
    '/:slug/maintenances/:id',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('maintenance:write')],
      schema: {
        params: z.object({ slug: z.string(), id: z.string().uuid() }),
        querystring: z.object({ notify: z.coerce.boolean().default(true) }),
        response: { 200: z.object({ deleted: z.boolean(), cancelled: z.boolean() }) },
      },
    },
    async (req) => {
      const tenantId = req.tenant!.id
      const current = await loadMaintenance(app, tenantId, req.params.id)

      const announced =
        current.status !== 'scheduled' ||
        current.remindersSentAt.length > 0 ||
        current.actualStart !== null

      if (!announced) {
        await app.db.delete(schema.maintenances).where(eq(schema.maintenances.id, current.id))

        await audit(app, {
          action: 'maintenance.deleted',
          tenantId,
          actorId: req.actor.userId,
          target: current.id,
          ip: req.ip,
        })

        return { deleted: true, cancelled: false }
      }

      await app.db
        .update(schema.maintenances)
        .set({ status: 'cancelled', actualEnd: current.actualEnd ?? new Date() })
        .where(eq(schema.maintenances.id, current.id))

      if (req.query.notify && current.isPublic) {
        await enqueueEvent(app, {
          tenantId,
          eventType: 'maintenance.cancelled',
          payload: { maintenanceId: current.id, title: current.title, body: '' },
        })
      }

      await audit(app, {
        action: 'maintenance.cancelled',
        tenantId,
        actorId: req.actor.userId,
        target: current.id,
        ip: req.ip,
      })

      return { deleted: false, cancelled: true }
    },
  )
}

const EVENT_FOR_STATUS: Record<z.infer<typeof statusSchema>, string> = {
  scheduled: 'maintenance.scheduled',
  in_progress: 'maintenance.started',
  completed: 'maintenance.completed',
  cancelled: 'maintenance.cancelled',
}

/** The fields each status refuses, so the message can name them. */
function frozenFields(
  status: z.infer<typeof statusSchema>,
  body: Record<string, unknown>,
): string[] {
  const schedule = ['scheduledStart', 'remindersBeforeMin']
  const behaviour = ['scheduledEnd', 'controlIds', 'autoTransition', 'suppressAlerts', 'isPublic']

  const refused =
    status === 'scheduled' ? [] : status === 'in_progress' ? schedule : [...schedule, ...behaviour]

  return refused.filter((field) => body[field] !== undefined)
}

function assertWindow(app: Parameters<FastifyPluginAsyncZod>[0], start: Date, end: Date): void {
  if (end.getTime() <= start.getTime()) {
    throw app.httpErrors.badRequest('The window must end after it starts')
  }
}

async function loadMaintenance(
  app: Parameters<FastifyPluginAsyncZod>[0],
  tenantId: string,
  id: string,
) {
  const [maintenance] = await app.db
    .select()
    .from(schema.maintenances)
    // Scoped by tenant, not just by id: an id from another tenant must 404,
    // not load.
    .where(and(eq(schema.maintenances.id, id), eq(schema.maintenances.tenantId, tenantId)))
    .limit(1)
  if (!maintenance) throw app.httpErrors.notFound('Unknown maintenance')
  return maintenance
}

export default routes

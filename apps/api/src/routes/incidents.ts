import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import { incidentImpactSchema } from '@tern/shared'
import { audit } from '../services/audit.js'
import { enqueueEvent } from '../services/notify.js'
import { assertControlsBelong } from '../services/tenant-guard.js'

/**
 * Incident communication.
 *
 * The shape here mirrors how an incident is actually run: open it before you
 * know the cause, add updates as you learn, record impact per component, and
 * write the postmortem afterwards — separately, because it is written calmly and
 * published later.
 */

const statusSchema = z.enum(['investigating', 'identified', 'monitoring', 'resolved'])

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/:slug/incidents',
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
              severity: z.string(),
              status: z.string(),
              startedAt: z.string(),
              resolvedAt: z.string().nullable(),
              hasPostmortem: z.boolean(),
              impacts: z.array(z.object({ controlId: z.string(), impact: z.string() })),
              updates: z.array(
                z.object({
                  id: z.string(),
                  status: z.string(),
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
      const canSeePrivate = req.can('incident:write')

      const incidents = await app.db
        .select()
        .from(schema.incidents)
        .where(
          and(
            eq(schema.incidents.tenantId, req.tenant!.id),
            canSeePrivate ? undefined : eq(schema.incidents.isPublic, true),
          ),
        )
        .orderBy(desc(schema.incidents.startedAt))
        .limit(req.query.limit)

      if (incidents.length === 0) return []
      const ids = incidents.map((i) => i.id)

      const [impacts, updates] = await Promise.all([
        app.db
          .select()
          .from(schema.incidentImpacts)
          .where(inArray(schema.incidentImpacts.incidentId, ids)),
        app.db
          .select()
          .from(schema.incidentUpdates)
          .where(inArray(schema.incidentUpdates.incidentId, ids))
          .orderBy(schema.incidentUpdates.createdAt),
      ])

      return incidents.map((incident) => ({
        id: incident.id,
        title: incident.title,
        severity: incident.severity,
        status: incident.status,
        startedAt: incident.startedAt.toISOString(),
        resolvedAt: incident.resolvedAt?.toISOString() ?? null,
        // The body is not sent in the list: it is Markdown, often long, and
        // only the detail view renders it.
        hasPostmortem: Boolean(incident.postmortemPublishedAt),
        impacts: impacts
          .filter((i) => i.incidentId === incident.id)
          .map((i) => ({ controlId: i.controlId, impact: i.impact })),
        updates: updates
          .filter((u) => u.incidentId === incident.id)
          .map((u) => ({
            id: u.id,
            status: u.status,
            body: u.body,
            createdAt: u.createdAt.toISOString(),
          })),
      }))
    },
  )

  app.get(
    '/:slug/incidents/:id',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('status:read')],
      schema: {
        params: z.object({ slug: z.string(), id: z.string().uuid() }),
        response: {
          200: z.object({
            id: z.string(),
            title: z.string(),
            severity: z.string(),
            status: z.string(),
            startedAt: z.string(),
            resolvedAt: z.string().nullable(),
            postmortemBody: z.string().nullable(),
            postmortemPublishedAt: z.string().nullable(),
          }),
        },
      },
    },
    async (req) => {
      const incident = await loadIncident(app, req.tenant!.id, req.params.id)
      if (!incident.isPublic && !req.can('incident:write')) {
        throw app.httpErrors.notFound('Not found')
      }

      return {
        id: incident.id,
        title: incident.title,
        severity: incident.severity,
        status: incident.status,
        startedAt: incident.startedAt.toISOString(),
        resolvedAt: incident.resolvedAt?.toISOString() ?? null,
        // An unpublished postmortem is a draft. It must not leak before its
        // author decided it was ready.
        postmortemBody: incident.postmortemPublishedAt ? incident.postmortemBody : null,
        postmortemPublishedAt: incident.postmortemPublishedAt?.toISOString() ?? null,
      }
    },
  )

  app.post(
    '/:slug/incidents',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('incident:write')],
      schema: {
        params: z.object({ slug: z.string() }),
        body: z.object({
          title: z.string().min(1).max(200),
          severity: z.enum(['minor', 'major', 'critical']).default('minor'),
          body: z.string().min(1).max(10_000),
          impacts: z
            .array(z.object({ controlId: z.string().uuid(), impact: incidentImpactSchema }))
            .default([]),
          isPublic: z.boolean().default(true),
          notify: z.boolean().default(true),
          startedAt: z.coerce.date().optional(),
        }),
        response: { 201: z.object({ id: z.string() }) },
      },
    },
    async (req, reply) => {
      const tenantId = req.tenant!.id
      await assertControlsBelong(
        app,
        tenantId,
        req.body.impacts.map((i) => i.controlId),
      )

      const [incident] = await app.db
        .insert(schema.incidents)
        .values({
          tenantId,
          title: req.body.title,
          severity: req.body.severity,
          status: 'investigating',
          startedAt: req.body.startedAt ?? new Date(),
          isPublic: req.body.isPublic,
          createdBy: req.actor.userId ?? null,
        })
        .returning()
      if (!incident) throw app.httpErrors.internalServerError('Failed to create incident')

      if (req.body.impacts.length > 0) {
        await app.db.insert(schema.incidentImpacts).values(
          req.body.impacts.map((i) => ({
            incidentId: incident.id,
            controlId: i.controlId,
            impact: i.impact,
          })),
        )
      }

      await app.db.insert(schema.incidentUpdates).values({
        incidentId: incident.id,
        authorId: req.actor.userId ?? null,
        status: 'investigating',
        body: req.body.body,
        notify: req.body.notify,
      })

      if (req.body.notify && req.body.isPublic) {
        await enqueueEvent(app, {
          tenantId,
          eventType: 'incident.opened',
          payload: { incidentId: incident.id, title: incident.title, body: req.body.body },
          controlIds: req.body.impacts.map((i) => i.controlId),
        })
      }

      await audit(app, {
        action: 'incident.opened',
        tenantId,
        actorId: req.actor.userId,
        target: incident.id,
        ip: req.ip,
      })

      return reply.code(201).send({ id: incident.id })
    },
  )

  app.post(
    '/:slug/incidents/:id/updates',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('incident:write')],
      schema: {
        params: z.object({ slug: z.string(), id: z.string().uuid() }),
        body: z.object({
          status: statusSchema,
          body: z.string().min(1).max(10_000),
          notify: z.boolean().default(true),
          /** Revise per-component impact as understanding of the blast radius changes. */
          impacts: z
            .array(z.object({ controlId: z.string().uuid(), impact: incidentImpactSchema }))
            .optional(),
        }),
        response: { 201: z.object({ id: z.string(), status: z.string() }) },
      },
    },
    async (req, reply) => {
      const tenantId = req.tenant!.id
      const incident = await loadIncident(app, tenantId, req.params.id)

      const [update] = await app.db
        .insert(schema.incidentUpdates)
        .values({
          incidentId: incident.id,
          authorId: req.actor.userId ?? null,
          status: req.body.status,
          body: req.body.body,
          notify: req.body.notify,
        })
        .returning()
      if (!update) throw app.httpErrors.internalServerError('Failed to add update')

      const resolving = req.body.status === 'resolved'
      await app.db
        .update(schema.incidents)
        .set({
          status: req.body.status,
          // Only stamped on the first transition to resolved. Re-resolving an
          // incident that was reopened must not rewrite when it originally ended.
          resolvedAt: resolving ? (incident.resolvedAt ?? new Date()) : null,
        })
        .where(eq(schema.incidents.id, incident.id))

      if (req.body.impacts) {
        await assertControlsBelong(
          app,
          tenantId,
          req.body.impacts.map((i) => i.controlId),
        )
        await app.db
          .delete(schema.incidentImpacts)
          .where(eq(schema.incidentImpacts.incidentId, incident.id))
        if (req.body.impacts.length > 0) {
          await app.db.insert(schema.incidentImpacts).values(
            req.body.impacts.map((i) => ({
              incidentId: incident.id,
              controlId: i.controlId,
              impact: i.impact,
            })),
          )
        }
      }

      // Resolution clears declared impact, so components fall back to what they
      // are actually measuring. Leaving it would keep the page red after the
      // incident was closed.
      if (resolving) {
        await app.db
          .delete(schema.incidentImpacts)
          .where(eq(schema.incidentImpacts.incidentId, incident.id))
      }

      if (req.body.notify && incident.isPublic) {
        await enqueueEvent(app, {
          tenantId,
          eventType: resolving ? 'incident.resolved' : 'incident.updated',
          payload: { incidentId: incident.id, title: incident.title, body: req.body.body },
        })
      }

      await audit(app, {
        action: `incident.${req.body.status}`,
        tenantId,
        actorId: req.actor.userId,
        target: incident.id,
        ip: req.ip,
      })

      return reply.code(201).send({ id: update.id, status: req.body.status })
    },
  )

  app.put(
    '/:slug/incidents/:id/postmortem',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('incident:write')],
      schema: {
        params: z.object({ slug: z.string(), id: z.string().uuid() }),
        body: z.object({
          body: z.string().min(1).max(100_000),
          /** Save a draft, or make it visible on the public history page. */
          publish: z.boolean().default(false),
        }),
        response: { 200: z.object({ published: z.boolean() }) },
      },
    },
    async (req) => {
      const tenantId = req.tenant!.id
      const incident = await loadIncident(app, tenantId, req.params.id)
      if (!incident.resolvedAt) {
        throw app.httpErrors.conflict('Resolve the incident before writing its postmortem')
      }

      await app.db
        .update(schema.incidents)
        .set({
          postmortemBody: req.body.body,
          postmortemPublishedAt: req.body.publish
            ? (incident.postmortemPublishedAt ?? new Date())
            : null,
        })
        .where(eq(schema.incidents.id, incident.id))

      if (req.body.publish) {
        await enqueueEvent(app, {
          tenantId,
          eventType: 'incident.postmortem',
          payload: { incidentId: incident.id, title: incident.title },
        })
      }

      await audit(app, {
        action: req.body.publish ? 'incident.postmortem.published' : 'incident.postmortem.saved',
        tenantId,
        actorId: req.actor.userId,
        target: incident.id,
        ip: req.ip,
      })

      return { published: req.body.publish }
    },
  )

  /** Resolved incidents with a published postmortem — the history page. */
  app.get(
    '/:slug/postmortems',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('history:read')],
      schema: {
        params: z.object({ slug: z.string() }),
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              title: z.string(),
              startedAt: z.string(),
              publishedAt: z.string(),
            }),
          ),
        },
      },
    },
    async (req) => {
      const rows = await app.db
        .select()
        .from(schema.incidents)
        .where(
          and(
            eq(schema.incidents.tenantId, req.tenant!.id),
            eq(schema.incidents.isPublic, true),
            isNotNull(schema.incidents.postmortemPublishedAt),
          ),
        )
        .orderBy(desc(schema.incidents.startedAt))

      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        startedAt: r.startedAt.toISOString(),
        publishedAt: r.postmortemPublishedAt!.toISOString(),
      }))
    },
  )
}

async function loadIncident(
  app: Parameters<FastifyPluginAsyncZod>[0],
  tenantId: string,
  id: string,
) {
  const [incident] = await app.db
    .select()
    .from(schema.incidents)
    // Scoped by tenant, not just by id: an id from another tenant must 404,
    // not load.
    .where(and(eq(schema.incidents.id, id), eq(schema.incidents.tenantId, tenantId)))
    .limit(1)
  if (!incident) throw app.httpErrors.notFound('Unknown incident')
  return incident
}

export default routes

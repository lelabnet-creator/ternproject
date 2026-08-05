import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import { generateToken, hashToken } from '@tern/shared'
import { config } from '../config.js'
import { audit } from '../services/audit.js'
import { normalise, type GenericMapping, type ReceiverKind } from '../services/receivers.js'

/**
 * Inbound webhooks from existing monitoring.
 *
 * The alternative to this is telling a team to replace the monitoring they
 * already trust in order to publish a status page — which nobody does. Accepting
 * what they already emit is the only realistic on-ramp.
 */

/**
 * The inbound endpoint is its own encapsulated plugin so its rate limit applies
 * to that route alone — and so it keeps the Zod type provider, which a nested
 * anonymous plugin does not inherit.
 */
const inboundRoute: FastifyPluginAsyncZod = async (app) => {
  await app.register(import('@fastify/rate-limit'), {
    // An alert storm is exactly when this endpoint matters most, so the limit
    // is generous — it exists to stop a loop, not to shed real alerts.
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req) => (req.params as { id?: string }).id ?? req.ip,
  })

  app.post(
    '/receivers/:id/:token',
    {
      schema: {
        params: z.object({ id: z.string().uuid(), token: z.string().min(10) }),
        response: {
          200: z.object({
            accepted: z.number(),
            ignored: z.array(z.string()),
          }),
        },
      },
    },
    async (req) => {
      const [receiver] = await app.db
        .select()
        .from(schema.receivers)
        .where(
          and(
            eq(schema.receivers.id, req.params.id),
            eq(schema.receivers.tokenHash, hashToken(req.params.token)),
            eq(schema.receivers.enabled, true),
          ),
        )
        .limit(1)

      // Same answer for a wrong id and a wrong token, so neither can be
      // enumerated independently of the other.
      if (!receiver) throw app.httpErrors.unauthorized('Unknown receiver')

      const alerts = normalise(
        receiver.kind as ReceiverKind,
        req.body,
        receiver.mapping as GenericMapping,
      )

      if (alerts.length === 0) {
        // Nothing recognisable is a 200, not an error: a source that receives
        // a 4xx will usually disable the webhook, and losing the integration
        // is worse than dropping one unmatched payload.
        app.log.info({ receiverId: receiver.id }, 'receiver payload matched no alerts')
        return { accepted: 0, ignored: ['payload matched no alerts'] }
      }

      const keys = [...new Set(alerts.map((a) => a.key))]
      const controls = await app.db
        .select({ id: schema.controls.id, key: schema.controls.key })
        .from(schema.controls)
        .where(
          and(eq(schema.controls.tenantId, receiver.tenantId), inArray(schema.controls.key, keys)),
        )

      const byKey = new Map(controls.map((c) => [c.key, c.id]))
      const rows: (typeof schema.checks.$inferInsert)[] = []
      const ignored: string[] = []

      for (const alert of alerts) {
        const controlId = byKey.get(alert.key)
        if (!controlId) {
          // Named rather than silently dropped: an operator wiring this up
          // needs to see that their label does not match any control key.
          ignored.push(alert.key)
          continue
        }

        rows.push({
          tenantId: receiver.tenantId,
          controlId,
          status: alert.status,
          latencyMs: alert.latencyMs ?? null,
          value: alert.value ?? null,
          message: alert.message ?? null,
          meta: { receiver: receiver.kind, receiverId: receiver.id },
        })
      }

      if (rows.length > 0) await app.db.insert(schema.checks).values(rows)

      await app.db
        .update(schema.receivers)
        .set({ lastReceivedAt: new Date() })
        .where(eq(schema.receivers.id, receiver.id))

      return { accepted: rows.length, ignored }
    },
  )
}

const routes: FastifyPluginAsyncZod = async (app) => {
  await app.register(inboundRoute)

  // ── Management ────────────────────────────────────────────────────────────

  app.post(
    '/:slug/receivers',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('receiver:manage')],
      schema: {
        params: z.object({ slug: z.string() }),
        body: z.object({
          name: z.string().min(1).max(100),
          kind: z.enum([
            'alertmanager',
            'grafana',
            'uptimerobot',
            'zabbix',
            'pagerduty',
            'healthchecks',
            'generic',
          ]),
          mapping: z.record(z.string(), z.unknown()).default({}),
          manageIncidents: z.boolean().default(false),
        }),
        response: { 201: z.object({ id: z.string(), url: z.string() }) },
      },
    },
    async (req, reply) => {
      const token = generateToken(24)

      const [receiver] = await app.db
        .insert(schema.receivers)
        .values({
          tenantId: req.tenant!.id,
          name: req.body.name,
          kind: req.body.kind,
          tokenHash: hashToken(token),
          mapping: req.body.mapping,
          manageIncidents: req.body.manageIncidents,
        })
        .returning()
      if (!receiver) throw app.httpErrors.internalServerError('Failed to create receiver')

      await audit(app, {
        action: 'receiver.created',
        tenantId: req.tenant!.id,
        actorId: req.actor.userId,
        target: receiver.id,
        meta: { kind: req.body.kind },
        ip: req.ip,
      })

      return reply.code(201).send({
        id: receiver.id,
        // Shown once — only the hash is stored, so this URL cannot be recovered.
        url: `${config.PUBLIC_BASE_URL}/api/v1/receivers/${receiver.id}/${token}`,
      })
    },
  )

  /**
   * Dry run: paste a payload, see what it would produce, before wiring anything
   * up. Discovering a mapping is wrong during an actual outage is the worst
   * possible time to find out.
   */
  app.post(
    '/:slug/receivers/test',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('receiver:manage')],
      schema: {
        params: z.object({ slug: z.string() }),
        body: z.object({
          kind: z.enum([
            'alertmanager',
            'grafana',
            'uptimerobot',
            'zabbix',
            'pagerduty',
            'healthchecks',
            'generic',
          ]),
          mapping: z.record(z.string(), z.unknown()).default({}),
          payload: z.unknown(),
        }),
        response: {
          200: z.object({
            alerts: z.array(
              z.object({
                key: z.string(),
                status: z.string(),
                resolved: z.boolean(),
                message: z.string().optional(),
                matchesControl: z.boolean(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const alerts = normalise(
        req.body.kind as ReceiverKind,
        req.body.payload,
        req.body.mapping as GenericMapping,
      )

      const keys = [...new Set(alerts.map((a) => a.key))]
      const existing =
        keys.length > 0
          ? await app.db
              .select({ key: schema.controls.key })
              .from(schema.controls)
              .where(
                and(
                  eq(schema.controls.tenantId, req.tenant!.id),
                  inArray(schema.controls.key, keys),
                ),
              )
          : []
      const known = new Set(existing.map((c) => c.key))

      return {
        alerts: alerts.map((a) => ({
          key: a.key,
          status: a.status,
          resolved: a.resolved,
          message: a.message,
          matchesControl: known.has(a.key),
        })),
      }
    },
  )

  app.get(
    '/:slug/receivers',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('receiver:manage')],
      schema: {
        params: z.object({ slug: z.string() }),
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              kind: z.string(),
              enabled: z.boolean(),
              lastReceivedAt: z.string().nullable(),
            }),
          ),
        },
      },
    },
    async (req) => {
      const rows = await app.db
        .select()
        .from(schema.receivers)
        .where(eq(schema.receivers.tenantId, req.tenant!.id))

      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        enabled: r.enabled,
        lastReceivedAt: r.lastReceivedAt?.toISOString() ?? null,
      }))
    },
  )
}

export default routes

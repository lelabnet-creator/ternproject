import { count, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import { audit } from '../services/audit.js'

/**
 * Emptying a tenant.
 *
 * The operation exists because a demo tenant, a trial, or a page built wrong
 * from the start needs a way back to nothing that is not "delete the tenant and
 * re-invite everyone". What it removes is what the tenant *monitors and
 * publishes*; what it keeps is what the tenant *is*.
 *
 * Kept, deliberately:
 *
 * - **The tenant and its settings.** Emptying is not deleting; the address, the
 *   branding and the members survive, or this would be a different operation
 *   wearing a gentler name.
 * - **The audit trail.** Wiping it would erase the record of the wipe, which is
 *   the one entry somebody will certainly go looking for afterwards. It ages
 *   out on its own retention instead.
 *
 * Everything else — controls, their measurements, groups, agents and their
 * keys, incidents, maintenances, subscribers, receivers, pairing codes, viewer
 * devices — is deleted.
 */

const routes: FastifyPluginAsyncZod = async (app) => {
  /** What is there, so the confirmation can say what is about to go. */
  app.get(
    '/:slug/danger/summary',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('tenant:settings')],
      schema: {
        params: z.object({ slug: z.string() }),
        response: {
          200: z.object({
            controls: z.number(),
            checks: z.number(),
            agents: z.number(),
            incidents: z.number(),
            maintenances: z.number(),
            subscribers: z.number(),
            receivers: z.number(),
          }),
        },
      },
    },
    async (req) => {
      const tenantId = req.tenant!.id
      const [controls, checks, agents, incidents, maintenances, subscribers, receivers] =
        await Promise.all([
          app.db
            .select({ n: count() })
            .from(schema.controls)
            .where(eq(schema.controls.tenantId, tenantId)),
          app.db
            .select({ n: count() })
            .from(schema.checks)
            .where(eq(schema.checks.tenantId, tenantId)),
          app.db
            .select({ n: count() })
            .from(schema.agents)
            .where(eq(schema.agents.tenantId, tenantId)),
          app.db
            .select({ n: count() })
            .from(schema.incidents)
            .where(eq(schema.incidents.tenantId, tenantId)),
          app.db
            .select({ n: count() })
            .from(schema.maintenances)
            .where(eq(schema.maintenances.tenantId, tenantId)),
          app.db
            .select({ n: count() })
            .from(schema.subscribers)
            .where(eq(schema.subscribers.tenantId, tenantId)),
          app.db
            .select({ n: count() })
            .from(schema.receivers)
            .where(eq(schema.receivers.tenantId, tenantId)),
        ])

      return {
        controls: Number(controls[0]?.n ?? 0),
        checks: Number(checks[0]?.n ?? 0),
        agents: Number(agents[0]?.n ?? 0),
        incidents: Number(incidents[0]?.n ?? 0),
        maintenances: Number(maintenances[0]?.n ?? 0),
        subscribers: Number(subscribers[0]?.n ?? 0),
        receivers: Number(receivers[0]?.n ?? 0),
      }
    },
  )

  app.post(
    '/:slug/danger/empty',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('tenant:settings')],
      schema: {
        params: z.object({ slug: z.string() }),
        body: z.object({
          /**
           * The tenant's own slug, typed by hand.
           *
           * Checked on the server rather than only in the browser: a confirmation
           * that exists only in the UI is one that a stray `curl` skips, and this
           * is the request where that matters.
           */
          confirm: z.string(),
          /** Second gate, and it must be explicit rather than defaulted. */
          understood: z.literal(true),
        }),
        response: {
          200: z.object({
            emptied: z.boolean(),
            deleted: z.record(z.string(), z.number()),
          }),
        },
      },
    },
    async (req) => {
      const tenantId = req.tenant!.id

      if (req.body.confirm !== req.params.slug) {
        throw app.httpErrors.badRequest(
          `Type “${req.params.slug}” to confirm — nothing was deleted`,
        )
      }

      const deleted: Record<string, number> = {}

      await app.db.transaction(async (tx) => {
        /*
         * Order matters only where a foreign key does not cascade. Checks are
         * removed before controls because the hypertable is the large one and a
         * cascade from 20 000 controls would build one enormous statement;
         * everything else follows its parent.
         */
        deleted.checks = (
          await tx.delete(schema.checks).where(eq(schema.checks.tenantId, tenantId)).returning({
            id: schema.checks.controlId,
          })
        ).length

        for (const [name, table, column] of [
          ['incidents', schema.incidents, schema.incidents.tenantId],
          ['maintenances', schema.maintenances, schema.maintenances.tenantId],
          ['controls', schema.controls, schema.controls.tenantId],
          ['groups', schema.controlGroups, schema.controlGroups.tenantId],
          ['agents', schema.agents, schema.agents.tenantId],
          ['pairingCodes', schema.pairingCodes, schema.pairingCodes.tenantId],
          ['apiKeys', schema.apiKeys, schema.apiKeys.tenantId],
          ['subscribers', schema.subscribers, schema.subscribers.tenantId],
          ['notifications', schema.notifications, schema.notifications.tenantId],
          ['receivers', schema.receivers, schema.receivers.tenantId],
          ['viewerTokens', schema.viewerTokens, schema.viewerTokens.tenantId],
          ['templates', schema.templates, schema.templates.tenantId],
        ] as const) {
          const rows = await tx.delete(table).where(eq(column, tenantId)).returning({ id: column })
          deleted[name] = rows.length
        }
      })

      // Written after, and never itself deleted: this is the entry somebody
      // will certainly go looking for.
      await audit(app, {
        action: 'tenant.emptied',
        tenantId,
        actorId: req.actor.userId,
        target: tenantId,
        meta: deleted,
        ip: req.ip,
      })

      return { emptied: true, deleted }
    },
  )
}

export default routes

import { and, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import { audit } from '../services/audit.js'
import { render, send, type SyslogTarget } from '../services/syslog.js'

/**
 * What has happened on this tenant, and where else it should be recorded.
 *
 * The audit trail was written from the first day and had no way to read it,
 * which makes it a trail nobody consults until an incident — and then it is a
 * database query typed under pressure.
 */

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/:slug/logs',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('audit:read')],
      schema: {
        params: z.object({ slug: z.string() }),
        querystring: z.object({
          /** Substring over the action, the target and the actor's label. */
          q: z.string().max(200).optional(),
          action: z.string().max(100).optional(),
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          /** Keyset pagination: the `ts` of the last row of the previous page. */
          before: z.coerce.date().optional(),
        }),
        response: {
          200: z.object({
            entries: z.array(
              z.object({
                id: z.string(),
                ts: z.string(),
                action: z.string(),
                actor: z.string(),
                target: z.string().nullable(),
                ip: z.string().nullable(),
                meta: z.record(z.string(), z.unknown()),
              }),
            ),
            /** Distinct actions present, so the filter offers what exists. */
            actions: z.array(z.string()),
          }),
        },
      },
    },
    async (req) => {
      const tenantId = req.tenant!.id
      const filters = [eq(schema.auditLog.tenantId, tenantId)]

      if (req.query.action) filters.push(eq(schema.auditLog.action, req.query.action))
      if (req.query.from) filters.push(gte(schema.auditLog.ts, req.query.from))
      if (req.query.to) filters.push(lte(schema.auditLog.ts, req.query.to))
      if (req.query.before) filters.push(sql`${schema.auditLog.ts} < ${req.query.before}`)

      if (req.query.q) {
        const term = `%${req.query.q}%`
        const matches = or(
          ilike(schema.auditLog.action, term),
          ilike(schema.auditLog.target, term),
          ilike(schema.auditLog.actorLabel, term),
        )
        if (matches) filters.push(matches)
      }

      const demo = req.role === 'demo'

      const [rows, actions] = await Promise.all([
        app.db
          .select({
            id: schema.auditLog.id,
            ts: schema.auditLog.ts,
            action: schema.auditLog.action,
            actorId: schema.auditLog.actorId,
            actorLabel: schema.auditLog.actorLabel,
            target: schema.auditLog.target,
            ip: schema.auditLog.ip,
            meta: schema.auditLog.meta,
            actorEmail: schema.users.email,
          })
          .from(schema.auditLog)
          .leftJoin(schema.users, eq(schema.users.id, schema.auditLog.actorId))
          .where(and(...filters))
          .orderBy(desc(schema.auditLog.ts))
          .limit(req.query.limit),
        app.db
          .selectDistinct({ action: schema.auditLog.action })
          .from(schema.auditLog)
          .where(eq(schema.auditLog.tenantId, tenantId))
          .orderBy(schema.auditLog.action),
      ])

      return {
        entries: rows.map((row) => ({
          id: row.id,
          ts: row.ts.toISOString(),
          action: row.action,
          // The user's email when there was one, the recorded label otherwise —
          // a pairing agent has no user, and "unknown" would lose which agent.
          actor: demo
            ? redactActor(row.actorEmail ?? row.actorLabel)
            : (row.actorEmail ?? row.actorLabel ?? 'system'),
          target: row.target,
          /*
           * Never to a demo visitor.
           *
           * The audit trail of a public demo accumulates the addresses of the
           * strangers who came to look at it, and the email of whoever
           * administers the instance. The trail is worth showing — it is a
           * feature — but not those two columns, and a demo is exactly the
           * deployment where they belong to people who never agreed to be in it.
           */
          ip: demo ? null : row.ip,
          meta: row.meta,
        })),
        actions: actions.map((row) => row.action),
      }
    },
  )

  /**
   * A line to the configured collector, now, reporting what happened.
   *
   * Separate from the mirror on the audit path because that one is deliberately
   * silent: a failing collector must not make the action that produced the
   * event fail. This is where an operator gets the error instead.
   */
  app.post(
    '/:slug/logs/syslog/test',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('tenant:settings')],
      schema: {
        params: z.object({ slug: z.string() }),
        response: { 200: z.object({ sent: z.boolean(), detail: z.string() }) },
      },
    },
    async (req) => {
      const [tenant] = await app.db
        .select()
        .from(schema.tenants)
        .where(eq(schema.tenants.id, req.tenant!.id))
        .limit(1)

      const target = tenant?.syslog as SyslogTarget | null | undefined
      if (!target) return { sent: false, detail: 'No collector is configured.' }

      const line = render(
        {
          timestamp: new Date(),
          tenantSlug: tenant!.slug,
          action: 'syslog.test',
          actor: req.actor.userId ?? 'admin',
          ip: req.ip,
        },
        target,
      )

      try {
        await send(line, target)
        await audit(app, {
          action: 'syslog.tested',
          tenantId: req.tenant!.id,
          actorId: req.actor.userId,
          meta: { host: target.host, port: target.port, protocol: target.protocol },
          ip: req.ip,
        })

        return {
          sent: true,
          detail:
            target.protocol === 'udp'
              ? // Said plainly: UDP cannot confirm delivery, and a green tick
                // that means "handed to the kernel" would be a lie by omission.
                `Datagram sent to ${target.host}:${target.port}. UDP cannot confirm it arrived — check the collector.`
              : `${target.host}:${target.port} accepted the line.`,
        }
      } catch (error) {
        return { sent: false, detail: error instanceof Error ? error.message : String(error) }
      }
    },
  )
}

/** Keeps who acted legible without naming them: "an administrator", not an address. */
function redactActor(actor: string | null): string {
  if (!actor) return 'system'
  return actor.includes('@') ? 'an administrator' : actor
}

export default routes

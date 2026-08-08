import { and, count, eq, gte, isNull, lt, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import { config } from '../config.js'
import { requirePlatformAdmin as guardPlatformAdmin } from '../services/platform-admin.js'

/**
 * Running the instance, as opposed to running a status page on it.
 *
 * Reserved for admins of the tenant flagged `is_system`. What they get is
 * *supervision*: how much load each tenant puts on the shared machinery, and
 * whether that machinery is keeping up. What they deliberately do not get is
 * other tenants' data — no incidents, no subscriber addresses, no measurements.
 * Supervision is not administration, and an operator who can read every
 * customer's incident history has an access level nobody agreed to.
 *
 * First version, and honest about it: everything here is measured, nothing is
 * estimated, and where a number is a rough figure it says so.
 */

const routes: FastifyPluginAsyncZod = async (app) => {
  /** Shared with the Monitoring route, which gates its instance figures the same way. */
  const requirePlatformAdmin = (req: { actor: { userId?: string | null } }) =>
    guardPlatformAdmin(app, req.actor.userId)

  app.get(
    '/system/overview',
    {
      schema: {
        response: {
          200: z.object({
            instance: z.object({
              tenants: z.number(),
              controls: z.number(),
              agents: z.number(),
              activeAgents: z.number(),
              pointsLastHour: z.number(),
              pointsLastDay: z.number(),
              /** Rough on-disk size of the measurement hypertable. */
              checksBytes: z.number().nullable(),
            }),
            tenants: z.array(
              z.object({
                id: z.string(),
                slug: z.string(),
                name: z.string(),
                isSystem: z.boolean(),
                retentionMode: z.string(),
                retentionDays: z.number(),
                controls: z.number(),
                agents: z.number(),
                pointsLastHour: z.number(),
                /** Points a minute, averaged over the last hour. */
                pointsPerMinute: z.number(),
                lastPointAt: z.string().nullable(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      await requirePlatformAdmin(req)

      const hourAgo = new Date(Date.now() - 3_600_000)
      const dayAgo = new Date(Date.now() - 86_400_000)

      const [tenantRows, controlCounts, agentCounts, hourly, dayTotal, size] = await Promise.all([
        app.db.select().from(schema.tenants).orderBy(schema.tenants.name),
        app.db
          .select({ tenantId: schema.controls.tenantId, n: count() })
          .from(schema.controls)
          .groupBy(schema.controls.tenantId),
        app.db
          .select({ tenantId: schema.agents.tenantId, status: schema.agents.status, n: count() })
          .from(schema.agents)
          .groupBy(schema.agents.tenantId, schema.agents.status),
        app.db
          .select({
            tenantId: schema.checks.tenantId,
            n: count(),
            last: sql<Date>`max(${schema.checks.ts})`,
          })
          .from(schema.checks)
          .where(gte(schema.checks.ts, hourAgo))
          .groupBy(schema.checks.tenantId),
        app.db.select({ n: count() }).from(schema.checks).where(gte(schema.checks.ts, dayAgo)),
        hypertableBytes(app),
      ])

      const controlsBy = new Map(controlCounts.map((r) => [r.tenantId, Number(r.n)]))
      const hourlyBy = new Map(hourly.map((r) => [r.tenantId, r]))

      const agentsBy = new Map<string, { total: number; active: number }>()
      for (const row of agentCounts) {
        const entry = agentsBy.get(row.tenantId) ?? { total: 0, active: 0 }
        entry.total += Number(row.n)
        if (row.status === 'active') entry.active += Number(row.n)
        agentsBy.set(row.tenantId, entry)
      }

      const tenants = tenantRows.map((tenant) => {
        const hour = hourlyBy.get(tenant.id)
        const points = Number(hour?.n ?? 0)

        return {
          id: tenant.id,
          slug: tenant.slug,
          name: tenant.name,
          isSystem: tenant.isSystem,
          retentionMode: tenant.retentionMode,
          retentionDays: tenant.retentionDays,
          controls: controlsBy.get(tenant.id) ?? 0,
          agents: agentsBy.get(tenant.id)?.total ?? 0,
          pointsLastHour: points,
          pointsPerMinute: Math.round((points / 60) * 100) / 100,
          lastPointAt: hour?.last ? new Date(hour.last).toISOString() : null,
        }
      })

      return {
        instance: {
          tenants: tenants.length,
          controls: tenants.reduce((sum, t) => sum + t.controls, 0),
          agents: tenants.reduce((sum, t) => sum + t.agents, 0),
          activeAgents: [...agentsBy.values()].reduce((sum, a) => sum + a.active, 0),
          pointsLastHour: tenants.reduce((sum, t) => sum + t.pointsLastHour, 0),
          pointsLastDay: Number(dayTotal[0]?.n ?? 0),
          checksBytes: size,
        },
        tenants,
      }
    },
  )

  /**
   * Is the shared machinery keeping up?
   *
   * Each check is something that has actually failed in this product's life or
   * would silently degrade it: aggregates falling behind, the notification
   * queue backing up, mail unconfigured, the ingest limit below what the fleet
   * needs.
   */
  app.get(
    '/system/health',
    {
      schema: {
        response: {
          200: z.object({
            checks: z.array(
              z.object({
                id: z.string(),
                label: z.string(),
                state: z.enum(['ok', 'warn', 'fail']),
                detail: z.string(),
              }),
            ),
            limits: z.object({
              ingestRateLimitPerMinute: z.number(),
              dbPoolMax: z.number(),
              authRateLimitPerMinute: z.number(),
            }),
            uptimeS: z.number(),
          }),
        },
      },
    },
    async (req) => {
      await requirePlatformAdmin(req)

      const checks: { id: string; label: string; state: 'ok' | 'warn' | 'fail'; detail: string }[] =
        []

      // ── Database ──────────────────────────────────────────────────────────
      try {
        const started = Date.now()
        const version = await app.db.execute(sql`select version() as v`)
        const row = (version as unknown as { v?: string }[])[0]
        checks.push({
          id: 'database',
          label: 'Database',
          state: 'ok',
          detail: `${String(row?.v ?? 'PostgreSQL')
            .split(' ')
            .slice(0, 2)
            .join(' ')} — answered in ${Date.now() - started} ms`,
        })
      } catch (error) {
        checks.push({
          id: 'database',
          label: 'Database',
          state: 'fail',
          detail: describe(error),
        })
      }

      // ── Aggregate lag ─────────────────────────────────────────────────────
      // The failure this catches: the public page silently trailing the admin
      // because the continuous aggregates cannot keep up with raw volume.
      try {
        const result = await app.db.execute(sql`
          select
            (select max(ts) from checks) as raw_latest,
            (select max(bucket) from checks_1m) as agg_latest
        `)
        const row = (result as unknown as { raw_latest?: string; agg_latest?: string }[])[0]

        if (!row?.raw_latest) {
          checks.push({
            id: 'aggregates',
            label: 'Continuous aggregates',
            state: 'ok',
            detail: 'No measurements yet — nothing to roll up',
          })
        } else {
          const lagS = row.agg_latest
            ? Math.max(0, (Date.parse(row.raw_latest) - Date.parse(row.agg_latest)) / 1000)
            : Number.POSITIVE_INFINITY
          checks.push({
            id: 'aggregates',
            label: 'Continuous aggregates',
            state: lagS < 300 ? 'ok' : lagS < 1800 ? 'warn' : 'fail',
            detail: Number.isFinite(lagS)
              ? `${Math.round(lagS)}s behind the raw table`
              : 'No aggregated buckets at all — the refresh policy may not be running',
          })
        }
      } catch (error) {
        checks.push({
          id: 'aggregates',
          label: 'Continuous aggregates',
          state: 'fail',
          detail: describe(error),
        })
      }

      // ── Notification queue ────────────────────────────────────────────────
      const pending = await app.db
        .select({ status: schema.notifications.status, n: count() })
        .from(schema.notifications)
        .groupBy(schema.notifications.status)

      const byStatus = new Map(pending.map((r) => [r.status, Number(r.n)]))
      const waiting = byStatus.get('pending') ?? 0
      const failed = byStatus.get('failed') ?? 0

      checks.push({
        id: 'notifications',
        label: 'Notification queue',
        state: failed > 0 ? 'warn' : waiting > 500 ? 'warn' : 'ok',
        detail:
          failed > 0
            ? `${waiting} waiting, ${failed} failed — failures do not retry forever`
            : `${waiting} waiting, none failed`,
      })

      // ── Mail ──────────────────────────────────────────────────────────────
      const mailLooksLocal = /^(localhost|127\.0\.0\.1|mailhog)$/i.test(config.SMTP_HOST)
      checks.push({
        id: 'mail',
        label: 'Mail',
        state: mailLooksLocal ? 'warn' : 'ok',
        detail: mailLooksLocal
          ? `${config.SMTP_HOST}:${config.SMTP_PORT} — a local catcher, not a real sender`
          : `${config.SMTP_HOST}:${config.SMTP_PORT}${config.SMTP_SECURE ? ' (TLS)' : ''}`,
      })

      // ── Stale agents ──────────────────────────────────────────────────────
      const staleCutoff = new Date(Date.now() - 3_600_000)
      const [staleRow] = await app.db
        .select({ n: count() })
        .from(schema.agents)
        .where(
          and(
            eq(schema.agents.status, 'active'),
            // Through the query builder rather than raw SQL: a JS Date
            // interpolated into a template has no type for Postgres to compare
            // against, and the failure is a 500 on the health page — which is
            // the one page that must not be the thing that is broken.
            or(isNull(schema.agents.lastSeenAt), lt(schema.agents.lastSeenAt, staleCutoff)),
          ),
        )
      const stale = Number(staleRow?.n ?? 0)

      checks.push({
        id: 'agents',
        label: 'Agents reporting',
        state: stale === 0 ? 'ok' : 'warn',
        detail:
          stale === 0
            ? 'Every active agent has reported within the hour'
            : `${stale} active agent(s) have said nothing for over an hour`,
      })

      return {
        checks,
        limits: {
          ingestRateLimitPerMinute: config.INGEST_RATE_LIMIT_MAX,
          dbPoolMax: config.DB_POOL_MAX,
          authRateLimitPerMinute: config.AUTH_RATE_LIMIT_MAX,
        },
        uptimeS: Math.round(process.uptime()),
      }
    },
  )

  /** The busiest tenants by measurement volume — where the load actually is. */
  app.get(
    '/system/load',
    {
      schema: {
        querystring: z.object({ hours: z.coerce.number().int().min(1).max(168).default(24) }),
        response: {
          200: z.object({
            buckets: z.array(z.object({ ts: z.string(), points: z.number() })),
          }),
        },
      },
    },
    async (req) => {
      await requirePlatformAdmin(req)

      const from = new Date(Date.now() - req.query.hours * 3_600_000)
      const result = await app.db.execute(sql`
        select time_bucket('1 hour', ts) as bucket, count(*)::int as points
        from checks
        where ts >= ${from.toISOString()}::timestamptz
        group by bucket
        order by bucket
      `)

      return {
        buckets: (result as unknown as { bucket: string; points: number }[]).map((row) => ({
          ts: new Date(row.bucket).toISOString(),
          points: Number(row.points),
        })),
      }
    },
  )
}

/**
 * Size of the measurement hypertable, or null where TimescaleDB does not answer.
 *
 * Null rather than zero: "we could not measure it" and "it is empty" are
 * different facts, and a dashboard that shows 0 for the first one is lying.
 */
async function hypertableBytes(app: Parameters<FastifyPluginAsyncZod>[0]): Promise<number | null> {
  try {
    const result = await app.db.execute(sql`select hypertable_size('checks') as bytes`)
    const row = (result as unknown as { bytes?: string | number }[])[0]
    return row?.bytes == null ? null : Number(row.bytes)
  } catch {
    return null
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default routes

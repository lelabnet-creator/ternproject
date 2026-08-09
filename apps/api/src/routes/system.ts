import { and, count, eq, gte, isNull, lt, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import { config } from '../config.js'
import { audit } from '../services/audit.js'
import { requirePlatformAdmin as guardPlatformAdmin } from '../services/platform-admin.js'
import { releaseState } from '../services/release.js'
import { requestUpdate, updateProgress } from '../services/self-update.js'

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

/** Declared once: the GET below answers with it and the POST's caller polls it. */
const updateProgressSchema = z.object({
  state: z.enum(['unavailable', 'idle', 'running', 'succeeded', 'failed']),
  target: z.string().nullable(),
  steps: z.array(
    z.object({
      id: z.enum(['pull', 'verify', 'restart']),
      label: z.string(),
      state: z.enum(['pending', 'running', 'done', 'failed']),
      percent: z.number(),
      detail: z.string(),
    }),
  ),
  startedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  detail: z.string(),
})

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

  /**
   * Which build this is, and whether a newer image has been published.
   *
   * Its own route rather than another entry in `/system/health`: health is
   * polled every thirty seconds and must answer from the database alone, while
   * this reads a registry over the network. Folding the two together would put
   * a third party's reachability on the critical path of the one page that has
   * to work when everything else does not.
   *
   * Platform-gated like the rest of this file, and for the same reason it is
   * useful: pulling a new image is the instance operator's job, not a tenant's.
   */
  app.get(
    '/system/release',
    {
      schema: {
        response: {
          200: z.object({
            /** `update` when a newer tag exists, `unknown` when nothing can be concluded. */
            state: z.enum(['current', 'update', 'unknown']),
            current: z.string().nullable(),
            latest: z.string().nullable(),
            revision: z.string().nullable(),
            image: z.string(),
            checkedAt: z.string(),
            detail: z.string(),
          }),
        },
      },
    },
    async (req) => {
      await requirePlatformAdmin(req)
      return releaseState()
    },
  )

  /**
   * How an upgrade is going, if one was asked for.
   *
   * Separate from `/system/release` and much cheaper: that one reads a registry
   * and is cached for hours, this one reads two small files and is polled every
   * couple of seconds while a bar is moving. It also has to keep answering
   * after a restart, which is exactly why the answer is on disk and not in this
   * process.
   */
  app.get(
    '/system/release/update',
    { schema: { response: { 200: updateProgressSchema } } },
    async (req) => {
      await requirePlatformAdmin(req)
      return updateProgress()
    },
  )

  /**
   * Applies the newest published release.
   *
   * The target is decided here rather than accepted from the caller: the only
   * upgrade this offers is the one the registry says is newest, and a version
   * in a request body is a field somebody can put an arbitrary tag in. Nothing
   * about the button needs that, and the updater would refuse it anyway.
   */
  app.post(
    '/system/release/update',
    {
      schema: {
        response: {
          202: z.object({ id: z.string(), target: z.string() }),
        },
      },
    },
    async (req, reply) => {
      await requirePlatformAdmin(req)

      const release = await releaseState()
      if (release.state !== 'update' || !release.latest) {
        throw app.httpErrors.conflict(
          release.state === 'unknown'
            ? `Nothing to apply: ${release.detail}`
            : 'This instance already runs the newest published release.',
        )
      }

      const outcome = await requestUpdate(release.latest, release.image)
      if (!outcome.ok) {
        throw outcome.reason === 'busy'
          ? app.httpErrors.conflict(outcome.detail)
          : app.httpErrors.preconditionFailed(outcome.detail)
      }

      // Recorded before anything happens, because the thing that happens next
      // is this process being replaced. An upgrade with no trail of who asked
      // for it is the one entry an operator goes looking for afterwards.
      await audit(app, {
        action: 'system.update_requested',
        // No tenant: this is the instance being upgraded, not a page being
        // edited. The trail is the platform's own.
        tenantId: req.tenant?.id,
        actorId: req.actor.userId,
        target: outcome.id,
        meta: { from: release.current, to: release.latest, image: release.image },
        ip: req.ip,
      })

      // 202: accepted, and deliberately not "done". What happens from here is
      // another container's business, and the caller watches the GET above.
      return reply.code(202).send({ id: outcome.id, target: release.latest })
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

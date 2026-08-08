import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import { config } from '../config.js'
import { APPLICATION_NAME } from '../plugins/db.js'
import { REQUEST_CLASSES } from '../services/http-metrics.js'
import { isPlatformAdmin } from '../services/platform-admin.js'

/**
 * Live HTTP figures, for sizing the layer while it is under load.
 *
 * Two audiences in one response, and the split is deliberate. A tenant admin
 * always sees *their own agents* — which host is pushing how hard is their
 * business, and on a single-tenant install it is the whole question. The
 * instance-wide figures — request rates, latencies, the rate-limit tally, the
 * database pool — go only to an admin of the system tenant, because on a
 * multi-tenant install they describe shared machinery that no single customer
 * should be able to read.
 *
 * Everything here comes from the process that answers the request. Say so on the
 * screen: behind a load balancer this is one instance's view, and reading it as
 * the deployment's is the mistake this shape invites.
 */

const classFigures = z.object({
  requests: z.number(),
  perMinute: z.number(),
  rateLimited: z.number(),
  failed: z.number(),
  p50Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
})

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/:slug/monitoring',
    {
      onRequest: [app.requireTenant()],
      // The same bar as the fleet screen: this is the same agents, counted, so
      // it asks to read them rather than to manage them. The instance figures
      // below carry their own, higher bar.
      preHandler: [app.requirePermission('agent:read')],
      schema: {
        params: z.object({ slug: z.string() }),
        querystring: z.object({
          minutes: z.coerce.number().int().min(1).max(120).default(60),
        }),
        response: {
          200: z.object({
            /** Always present: this instance, named, so two of them are telling apart. */
            instance: z.object({
              name: z.string(),
              startedAt: z.string(),
              minutesCovered: z.number(),
            }),
            agents: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                site: z.string().nullable(),
                status: z.string(),
                requests: z.number(),
                perMinute: z.number(),
              }),
            ),
            /** Null unless the caller administers the system tenant. */
            platform: z
              .object({
                inFlight: z.number(),
                byClass: z.record(z.string(), classFigures),
                perMinute: z.array(
                  z.object({
                    minute: z.string(),
                    requests: z.number(),
                    rateLimited: z.number(),
                  }),
                ),
                limits: z.object({
                  ingestRateLimitPerMinute: z.number(),
                  authRateLimitPerMinute: z.number(),
                  dbPoolMax: z.number(),
                }),
                pool: z.object({
                  open: z.number(),
                  active: z.number(),
                  max: z.number(),
                }),
                /** Unattributed ingest — a key with no agent, or one since deleted. */
                unattributedRequests: z.number(),
              })
              .nullable(),
          }),
        },
      },
    },
    async (req) => {
      const snapshot = app.metrics.snapshot(req.query.minutes)
      const tenantId = req.tenant!.id

      /*
       * Ingest is counted per API key, because that is what a request carries.
       * Resolving keys to agents happens here rather than in the hook: the hook
       * runs on the hot path, and a database round trip per ingest request to
       * label a counter would be the instrumentation causing the jam.
       */
      const keyIds = snapshot.byApiKey.map((row) => row.apiKeyId)
      const agents = keyIds.length
        ? await app.db
            .select({
              id: schema.agents.id,
              name: schema.agents.name,
              site: schema.agents.site,
              status: schema.agents.status,
              apiKeyId: schema.agents.apiKeyId,
            })
            .from(schema.agents)
            .where(
              and(eq(schema.agents.tenantId, tenantId), inArray(schema.agents.apiKeyId, keyIds)),
            )
        : []

      const divisor = Math.max(1, snapshot.minutes)
      const byKey = new Map(snapshot.byApiKey.map((row) => [row.apiKeyId, row.requests]))

      const agentRows = agents
        .map((agent) => {
          const requests = byKey.get(agent.apiKeyId!) ?? 0
          return {
            id: agent.id,
            name: agent.name,
            site: agent.site,
            status: agent.status,
            requests,
            perMinute: Math.round((requests / divisor) * 10) / 10,
          }
        })
        .sort((a, b) => b.requests - a.requests)

      const platform = (await isPlatformAdmin(app, req.actor.userId))
        ? {
            inFlight: snapshot.inFlight,
            byClass: Object.fromEntries(
              REQUEST_CLASSES.map((kind) => [kind, snapshot.byClass[kind]]),
            ),
            perMinute: snapshot.perMinute,
            limits: {
              ingestRateLimitPerMinute: config.INGEST_RATE_LIMIT_MAX,
              authRateLimitPerMinute: config.AUTH_RATE_LIMIT_MAX,
              dbPoolMax: config.DB_POOL_MAX,
            },
            pool: await poolUsage(app),
            // Ingest this instance served for keys that resolve to no agent of
            // this tenant — another tenant's traffic, or a key whose agent was
            // deleted. Reported as a total rather than itemised: the detail is
            // not this tenant's to see, but the volume explains a gap between
            // the agent rows and the ingest class.
            unattributedRequests: Math.max(
              0,
              snapshot.byClass.ingest.requests -
                agentRows.reduce((sum, row) => sum + row.requests, 0),
            ),
          }
        : null

      return {
        instance: {
          name: APPLICATION_NAME,
          startedAt: snapshot.startedAt,
          minutesCovered: snapshot.minutes,
        },
        agents: agentRows,
        platform,
      }
    },
  )
}

/**
 * How much of this process's pool is checked out.
 *
 * Asked of Postgres rather than of the driver: postgres.js keeps its connection
 * state private, and `pg_stat_activity` is the one place the answer exists.
 * Filtered on this process's own `application_name`, so a second API container
 * connected to the same database does not inflate the figure.
 */
async function poolUsage(
  app: Parameters<FastifyPluginAsyncZod>[0],
): Promise<{ open: number; active: number; max: number }> {
  try {
    const [row] = await app.sql<{ open: number; active: number }[]>`
      SELECT count(*)::int AS open,
             count(*) FILTER (WHERE state = 'active')::int AS active
        FROM pg_stat_activity
       WHERE application_name = ${APPLICATION_NAME}
    `
    return { open: row?.open ?? 0, active: row?.active ?? 0, max: config.DB_POOL_MAX }
  } catch (error) {
    // A restricted role may not read pg_stat_activity. Zeroes rather than a
    // failed screen: the rest of the tab is still worth showing, and the
    // alternative is monitoring that breaks under exactly the permissions
    // someone tightened on purpose.
    app.log.warn({ err: error }, 'could not read pool usage')
    return { open: 0, active: 0, max: config.DB_POOL_MAX }
  }
}

export default routes

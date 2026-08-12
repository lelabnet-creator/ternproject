import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import {
  checkStatusSchema,
  heartbeatIngestResponseSchema,
  ingestPointSchema,
  ingestResponseSchema,
} from '@tern/shared'
import {
  authenticateApiKey,
  keyCoversControl,
  touchAgent,
  type ApiKeyContext,
} from '../services/apikeys.js'
import { config } from '../config.js'

/**
 * Ingestion — how measurements actually arrive.
 *
 * Two shapes, because two very different callers use them: a batch endpoint for
 * agents and scripts that measure several things at once, and a heartbeat that
 * a bare `curl` in a cron job can hit with no body at all. Requiring a JSON
 * envelope for "I am still alive" would put a scripting language between the
 * user and their first working check.
 */

/*
 * The point shape lives in @tern/shared/agent-protocol, beside the rest of the
 * agent protocol and the fixtures the Rust side is tested against. What stays
 * here is everything about *storing* one.
 */
const MAX_BATCH = 500

/** Timestamps outside this window are clamped — see below. */
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000
const MAX_PAST_AGE_MS = 7 * 24 * 3600 * 1000

const routes: FastifyPluginAsyncZod = async (app) => {
  await app.register(import('@fastify/rate-limit'), {
    // Generous: this is the hot path for a fleet of agents, and the API key
    // already bounds who can reach it. The limit exists to stop a runaway loop,
    // not to police normal use — see the Capacity screen for what this
    // deployment's fleet actually needs.
    max: config.INGEST_RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.headers.authorization ?? req.ip,
  })

  app.post(
    '/ingest',
    {
      schema: {
        body: z.union([ingestPointSchema, z.array(ingestPointSchema).min(1).max(MAX_BATCH)]),
        response: { 200: ingestResponseSchema },
      },
    },
    async (req) => {
      const key = await authenticateApiKey(app, req, 'ingest')
      if (!key) throw app.httpErrors.unauthorized('Invalid or missing API key')

      // A push is the strongest possible evidence the agent is alive, and it is
      // what everything downstream means by "last seen".
      await touchAgent(app, key.id, req.headers['user-agent'])

      const points = Array.isArray(req.body) ? req.body : [req.body]
      const resolved = await resolveControls(app, key, [
        ...new Set(points.map((p) => p.controlKey)),
      ])

      const rows: (typeof schema.checks.$inferInsert)[] = []
      const rejected: { controlKey: string; reason: string }[] = []

      for (const point of points) {
        const controlId = resolved.get(point.controlKey)
        if (!controlId) {
          // Named individually rather than failing the whole batch: one unknown
          // key in a fleet-wide push should not discard everything else.
          rejected.push({ controlKey: point.controlKey, reason: 'unknown or out-of-scope control' })
          continue
        }

        rows.push({
          // A string on the wire (see the shared schema); a Date from here on.
          ts: clampTimestamp(point.ts === undefined ? undefined : new Date(point.ts)),
          tenantId: key.tenantId,
          controlId,
          status: point.status,
          latencyMs: point.latencyMs ?? null,
          value: point.value ?? null,
          metrics: point.metrics ?? {},
          message: point.message ?? null,
          meta: point.meta ?? {},
          synthetic: false,
        })
      }

      if (rows.length > 0) await app.db.insert(schema.checks).values(rows)

      /*
       * Rejections were invisible from the server: the agent logged them, but
       * an operator reading this side saw an ingest that answered 200 and a
       * control that never moved. Deduplicated by reason — a 500-point batch
       * against a revoked scope is one line, not five hundred.
       */
      if (rejected.length > 0) {
        req.log.warn(
          {
            apiKeyId: key.id,
            rejected: rejected.length,
            reasons: [...new Set(rejected.map((r) => r.reason))],
            controlKeys: [...new Set(rejected.map((r) => r.controlKey))].slice(0, 10),
          },
          'ingest points rejected',
        )
      }

      return { accepted: rows.length, rejected }
    },
  )

  /**
   * The simplest possible client: `curl -XPOST .../heartbeat/backup -H 'Authorization: Bearer ...'`
   *
   * No body, no JSON, no dependency. Optional query parameters cover the common
   * "report a failure" case without turning it into a different endpoint.
   */
  app.post(
    '/heartbeat/:controlKey',
    {
      schema: {
        params: z.object({ controlKey: z.string().min(1).max(200) }),
        querystring: z.object({
          status: checkStatusSchema.default('operational'),
          latencyMs: z.coerce.number().int().min(0).optional(),
          value: z.coerce.number().finite().optional(),
          message: z.string().max(2000).optional(),
        }),
        // `accepted` is a count here as it is on /ingest — the two success
        // envelopes used to disagree (`true` vs a number) for no reason a
        // client could use.
        response: { 200: heartbeatIngestResponseSchema },
      },
    },
    async (req) => {
      const key = await authenticateApiKey(app, req, 'ingest')
      if (!key) throw app.httpErrors.unauthorized('Invalid or missing API key')

      await touchAgent(app, key.id, req.headers['user-agent'])

      const resolved = await resolveControls(app, key, [req.params.controlKey])
      const controlId = resolved.get(req.params.controlKey)
      if (!controlId) throw app.httpErrors.notFound('Unknown or out-of-scope control')

      await app.db.insert(schema.checks).values({
        tenantId: key.tenantId,
        controlId,
        status: req.query.status,
        latencyMs: req.query.latencyMs ?? null,
        value: req.query.value ?? null,
        message: req.query.message ?? null,
        synthetic: false,
      })

      return { accepted: 1, controlKey: req.params.controlKey }
    },
  )
}

/**
 * Maps control keys to ids for this API key, creating them when the key allows
 * auto-registration.
 *
 * Auto-registration is what makes a first push work without visiting the UI
 * first, but it is opt-in per key: on a key shared across a fleet, a typo in a
 * control name would otherwise silently create a new component on the public
 * status page.
 */
async function resolveControls(
  app: Parameters<FastifyPluginAsyncZod>[0],
  key: ApiKeyContext,
  controlKeys: string[],
): Promise<Map<string, string>> {
  if (controlKeys.length === 0) return new Map()

  const existing = await app.db
    .select({ id: schema.controls.id, key: schema.controls.key })
    .from(schema.controls)
    .where(
      and(eq(schema.controls.tenantId, key.tenantId), inArray(schema.controls.key, controlKeys)),
    )

  const map = new Map<string, string>()
  for (const row of existing) {
    if (keyCoversControl(key, row.id)) map.set(row.key, row.id)
  }

  if (!key.autoRegister) return map

  const missing = controlKeys.filter((k) => !map.has(k))
  for (const controlKey of missing) {
    const [created] = await app.db
      .insert(schema.controls)
      .values({
        tenantId: key.tenantId,
        key: controlKey,
        // A readable placeholder rather than the raw key: it is what appears on
        // the public page until someone renames it.
        name: humanise(controlKey),
        kind: 'push',
        // Auto-registered controls start internal. A component appearing on a
        // customer-facing page because of a typo is not a recoverable mistake.
        isPublic: false,
      })
      .onConflictDoNothing()
      .returning()

    if (created) map.set(controlKey, created.id)
  }

  return map
}

/**
 * Clamps a client-supplied timestamp.
 *
 * Machine clocks drift and occasionally sit years off. An unclamped timestamp
 * lands the point in a chunk nobody queries, so the check silently never
 * appears — worse than being visibly wrong.
 */
function clampTimestamp(ts: Date | undefined): Date {
  const now = Date.now()
  if (!ts) return new Date(now)

  const value = ts.getTime()
  if (!Number.isFinite(value)) return new Date(now)
  if (value > now + MAX_FUTURE_SKEW_MS) return new Date(now)
  if (value < now - MAX_PAST_AGE_MS) return new Date(now - MAX_PAST_AGE_MS)
  return ts
}

function humanise(key: string): string {
  return key
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase())
}

export default routes

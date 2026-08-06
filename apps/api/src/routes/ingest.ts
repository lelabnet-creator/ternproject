import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import { checkStatusSchema } from '@tern/shared'
import { authenticateApiKey, keyCoversControl, type ApiKeyContext } from '../services/apikeys.js'

/**
 * Ingestion — how measurements actually arrive.
 *
 * Two shapes, because two very different callers use them: a batch endpoint for
 * agents and scripts that measure several things at once, and a heartbeat that
 * a bare `curl` in a cron job can hit with no body at all. Requiring a JSON
 * envelope for "I am still alive" would put a scripting language between the
 * user and their first working check.
 */

const pointSchema = z
  .object({
    controlKey: z.string().min(1).max(200),
    /**
     * Optional when a `value` is sent.
     *
     * A control that reports a measurement — a queue depth, a session count —
     * has no status to invent. Receiving the number is itself the evidence that
     * the thing is reporting, so the point defaults to `operational` and the
     * widget's own thresholds decide how it is drawn.
     *
     * Requiring a status here forced every measurement client to make one up,
     * which is both busywork and an invitation to make it up wrongly.
     */
    status: checkStatusSchema.optional(),
    latencyMs: z.number().int().min(0).max(3_600_000).optional(),
    value: z.number().finite().optional(),
    /**
     * Anything else worth charting, by name.
     *
     * `latencyMs` and `value` are two names that happened to get columns; a
     * caller measuring a queue depth *and* a latency, or three temperatures,
     * should not have to choose one and drop the rest.
     *
     * Bounded on purpose: names are constrained because they become chart
     * labels and option values, and an unbounded map on the hot ingest path is
     * a way to fill a disk one point at a time.
     */
    metrics: z
      .record(
        z
          .string()
          .min(1)
          .max(60)
          .regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/, 'Metric names start with a letter'),
        z.number().finite(),
      )
      .refine((m) => Object.keys(m).length <= 25, 'At most 25 metrics per point')
      .optional(),
    message: z.string().max(2000).optional(),
    /** Defaults to now. Accepted so a queued agent can report when it measured. */
    ts: z.coerce.date().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  // One of the two must be present. A point carrying neither says nothing, and
  // silently storing it as `operational` would invent a claim nobody made.
  .refine(
    (point) =>
      point.status !== undefined ||
      point.value !== undefined ||
      (point.metrics !== undefined && Object.keys(point.metrics).length > 0),
    { message: 'Send a status, a value, or at least one metric' },
  )
  .transform((point) => ({
    ...point,
    status: point.status ?? ('operational' as const),
  }))

const MAX_BATCH = 500

/** Timestamps outside this window are clamped — see below. */
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000
const MAX_PAST_AGE_MS = 7 * 24 * 3600 * 1000

const routes: FastifyPluginAsyncZod = async (app) => {
  await app.register(import('@fastify/rate-limit'), {
    // Generous: this is the hot path for a fleet of agents, and the API key
    // already bounds who can reach it. The limit exists to stop a runaway loop,
    // not to police normal use.
    max: 600,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.headers.authorization ?? req.ip,
  })

  app.post(
    '/ingest',
    {
      schema: {
        body: z.union([pointSchema, z.array(pointSchema).min(1).max(MAX_BATCH)]),
        response: {
          200: z.object({
            accepted: z.number(),
            rejected: z.array(z.object({ controlKey: z.string(), reason: z.string() })),
          }),
        },
      },
    },
    async (req) => {
      const key = await authenticateApiKey(app, req, 'ingest')
      if (!key) throw app.httpErrors.unauthorized('Invalid or missing API key')

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
          ts: clampTimestamp(point.ts),
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
        response: { 200: z.object({ accepted: z.literal(true), controlKey: z.string() }) },
      },
    },
    async (req) => {
      const key = await authenticateApiKey(app, req, 'ingest')
      if (!key) throw app.httpErrors.unauthorized('Invalid or missing API key')

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

      return { accepted: true as const, controlKey: req.params.controlKey }
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

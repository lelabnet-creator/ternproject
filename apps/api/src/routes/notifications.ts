import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import {
  blindIndex,
  decryptSecret,
  encryptSecret,
  generateToken,
  hashToken,
  sizeDeployment,
} from '@tern/shared'
import { config } from '../config.js'
import { audit } from '../services/audit.js'
import { sendEmail, sendWebhook } from '../services/transports.js'

/**
 * How a tenant's notifications leave the building.
 *
 * Mail is deliberately read-only here. SMTP belongs to the deployment: it is one
 * connection per instance, it holds a credential that has no business in a
 * tenant's hands on a shared installation, and a wrong value takes down mail for
 * everyone. What an admin actually needs is to see the effective settings and
 * prove they work, so that is what this offers — the truth about the
 * configuration, plus a test send.
 *
 * Outbound webhooks are the opposite: per tenant, self-service, and safe to get
 * wrong.
 */

const routes: FastifyPluginAsyncZod = async (app) => {
  /**
   * The HTTP layer's limits, beside what this tenant's fleet actually asks of
   * them.
   *
   * Read-only for the same reason the mail settings are: these are per-process
   * and shared by every tenant. What is useful is knowing whether the values in
   * the environment fit the fleet that grew since they were set.
   */
  app.get(
    '/:slug/capacity',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('tenant:settings')],
      schema: {
        params: z.object({ slug: z.string() }),
        querystring: z.object({
          /** Override the measured fleet to try a hypothetical one. */
          agents: z.coerce.number().int().min(0).max(100_000).optional(),
          probesPerAgent: z.coerce.number().int().min(0).max(1000).optional(),
          intervalS: z.coerce.number().int().min(5).max(86_400).optional(),
          concurrentViewers: z.coerce.number().int().min(0).max(1_000_000).optional(),
        }),
        response: {
          200: z.object({
            measured: z.object({
              agents: z.number(),
              probes: z.number(),
              retentionDays: z.number(),
            }),
            effective: z.object({
              ingestRateLimitPerMinute: z.number(),
              dbPoolMax: z.number(),
              authRateLimitPerMinute: z.number(),
            }),
            sizing: z.object({
              pointsPerMinute: z.number(),
              ingestRequestsPerMinute: z.number(),
              readRequestsPerMinute: z.number(),
              rawPointsRetained: z.number(),
              rawStorageMb: z.number(),
              recommended: z.object({
                ingestRateLimitPerMinute: z.number(),
                dbPoolMax: z.number(),
              }),
              notes: z.array(z.string()),
            }),
          }),
        },
      },
    },
    async (req) => {
      const tenantId = req.tenant!.id

      const [agentRows, controlRows, [tenant]] = await Promise.all([
        app.db
          .select({ id: schema.agents.id })
          .from(schema.agents)
          .where(and(eq(schema.agents.tenantId, tenantId), eq(schema.agents.status, 'active'))),
        app.db
          .select({ id: schema.controls.id })
          .from(schema.controls)
          .where(and(eq(schema.controls.tenantId, tenantId), eq(schema.controls.enabled, true))),
        app.db
          .select({ retentionDays: schema.tenants.retentionDays })
          .from(schema.tenants)
          .where(eq(schema.tenants.id, tenantId))
          .limit(1),
      ])

      const agents = req.query.agents ?? agentRows.length
      const probesPerAgent = req.query.probesPerAgent ?? controlRows.length
      const retentionDays = tenant?.retentionDays ?? 90

      const sizing = sizeDeployment({
        agents,
        probesPerAgent,
        intervalS: req.query.intervalS ?? 60,
        concurrentViewers: req.query.concurrentViewers ?? 20,
        retentionDays,
      })

      return {
        measured: { agents: agentRows.length, probes: controlRows.length, retentionDays },
        effective: {
          ingestRateLimitPerMinute: config.INGEST_RATE_LIMIT_MAX,
          dbPoolMax: config.DB_POOL_MAX,
          authRateLimitPerMinute: config.AUTH_RATE_LIMIT_MAX,
        },
        sizing,
      }
    },
  )

  app.get(
    '/:slug/notifications/mail',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('subscriber:manage')],
      schema: {
        params: z.object({ slug: z.string() }),
        response: {
          200: z.object({
            host: z.string(),
            port: z.number(),
            secure: z.boolean(),
            from: z.string(),
            /** Whether a username is configured. Never the username itself. */
            authenticated: z.boolean(),
            /** Where these come from, so nobody hunts for a screen to edit them. */
            source: z.literal('environment'),
          }),
        },
      },
    },
    async () => ({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      from: config.MAIL_FROM,
      // The presence of credentials is operationally useful; their value is not,
      // and an admin screen is a fine place for a credential to be shoulder-read.
      authenticated: Boolean(config.SMTP_USER),
      source: 'environment' as const,
    }),
  )

  app.post(
    '/:slug/notifications/mail/test',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('subscriber:manage')],
      schema: {
        params: z.object({ slug: z.string() }),
        body: z.object({ to: z.string().email() }),
        response: {
          200: z.object({ sent: z.boolean(), detail: z.string() }),
        },
      },
    },
    async (req) => {
      try {
        await sendEmail(req.body.to, {
          subject: `TERN test message — ${req.tenant!.slug}`,
          text: 'If you are reading this, TERN can send mail with its current settings.',
          html: '<p>If you are reading this, TERN can send mail with its current settings.</p>',
        })

        await audit(app, {
          action: 'notifications.mail_tested',
          tenantId: req.tenant!.id,
          actorId: req.actor.userId,
          // The recipient is recorded: sending mail from someone else's server
          // to an arbitrary address is worth a trail.
          meta: { to: req.body.to },
          ip: req.ip,
        })

        return { sent: true, detail: `Accepted for delivery to ${req.body.to}` }
      } catch (error) {
        // Reported rather than thrown: "connection refused on localhost:1025" is
        // the answer, and a 500 with a stack trace is not.
        return { sent: false, detail: describe(error) }
      }
    },
  )

  // ── Outbound webhooks ─────────────────────────────────────────────────────

  app.get(
    '/:slug/notifications/webhooks',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('subscriber:manage')],
      schema: {
        params: z.object({ slug: z.string() }),
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              url: z.string(),
              confirmed: z.boolean(),
              hasSecret: z.boolean(),
              createdAt: z.string(),
            }),
          ),
        },
      },
    },
    async (req) => {
      const rows = await app.db
        .select()
        .from(schema.subscribers)
        .where(
          and(
            eq(schema.subscribers.tenantId, req.tenant!.id),
            eq(schema.subscribers.channel, 'webhook'),
          ),
        )
        .orderBy(schema.subscribers.createdAt)

      return rows.map((row) => ({
        id: row.id,
        // Decrypted for display, unlike a subscriber's email address: this URL
        // is something an admin typed in, not somebody else's contact detail.
        url: decryptSecret(row.addressEnc, config.APP_SECRET),
        confirmed: Boolean(row.confirmedAt),
        // The secret itself is stored encrypted and never returned — a webhook
        // signature is worthless once the screen showing it is screenshotted.
        hasSecret: Boolean(row.webhookSecretEnc),
        createdAt: row.createdAt.toISOString(),
      }))
    },
  )

  app.post(
    '/:slug/notifications/webhooks',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('subscriber:manage')],
      schema: {
        params: z.object({ slug: z.string() }),
        body: z.object({
          url: z.string().url(),
          /** Generated when absent — a signed webhook with no secret is unsigned. */
          secret: z.string().min(16).max(200).optional(),
        }),
        response: { 201: z.object({ id: z.string(), secret: z.string() }) },
      },
    },
    async (req, reply) => {
      assertNotLoopback(app, req.body.url)

      const secret = req.body.secret ?? generateToken(24)

      const [created] = await app.db
        .insert(schema.subscribers)
        .values({
          tenantId: req.tenant!.id,
          channel: 'webhook',
          addressEnc: encryptSecret(req.body.url, config.APP_SECRET),
          addressHash: blindIndex(req.body.url, config.APP_SECRET),
          webhookSecretEnc: encryptSecret(secret, config.APP_SECRET),
          // An endpoint an admin entered is already an act of consent — unlike
          // an email address, which somebody else has to agree to.
          confirmedAt: new Date(),
          unsubscribeTokenHash: hashToken(generateToken(24)),
        })
        .returning()
      if (!created) throw app.httpErrors.internalServerError('Could not save the webhook')

      await audit(app, {
        action: 'notifications.webhook_added',
        tenantId: req.tenant!.id,
        actorId: req.actor.userId,
        target: created.id,
        meta: { url: req.body.url },
        ip: req.ip,
      })

      // Returned exactly once, like every other secret in this product.
      return reply.code(201).send({ id: created.id, secret })
    },
  )

  app.post(
    '/:slug/notifications/webhooks/:id/test',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('subscriber:manage')],
      schema: {
        params: z.object({ slug: z.string(), id: z.string().uuid() }),
        response: { 200: z.object({ sent: z.boolean(), detail: z.string() }) },
      },
    },
    async (req) => {
      const [row] = await app.db
        .select()
        .from(schema.subscribers)
        .where(
          and(
            eq(schema.subscribers.id, req.params.id),
            eq(schema.subscribers.tenantId, req.tenant!.id),
          ),
        )
        .limit(1)
      if (!row) throw app.httpErrors.notFound('Unknown webhook')

      const secret = row.webhookSecretEnc
        ? decryptSecret(row.webhookSecretEnc, config.APP_SECRET)
        : null

      try {
        await sendWebhook(
          decryptSecret(row.addressEnc, config.APP_SECRET),
          {
            type: 'test',
            tenant: req.tenant!.slug,
            message: 'TERN test delivery. Verify the signature headers on this request.',
          },
          secret,
        )
        return { sent: true, detail: 'The endpoint accepted the delivery' }
      } catch (error) {
        return { sent: false, detail: describe(error) }
      }
    },
  )

  app.delete(
    '/:slug/notifications/webhooks/:id',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('subscriber:manage')],
      schema: {
        params: z.object({ slug: z.string(), id: z.string().uuid() }),
        response: { 200: z.object({ ok: z.boolean() }) },
      },
    },
    async (req) => {
      const deleted = await app.db
        .delete(schema.subscribers)
        .where(
          and(
            eq(schema.subscribers.id, req.params.id),
            eq(schema.subscribers.tenantId, req.tenant!.id),
            eq(schema.subscribers.channel, 'webhook'),
          ),
        )
        .returning({ id: schema.subscribers.id })

      if (deleted.length === 0) throw app.httpErrors.notFound('Unknown webhook')

      await audit(app, {
        action: 'notifications.webhook_removed',
        tenantId: req.tenant!.id,
        actorId: req.actor.userId,
        target: req.params.id,
        ip: req.ip,
      })

      return { ok: true }
    },
  )
}

/**
 * Refuses an endpoint pointing back at the host running TERN.
 *
 * A webhook URL is a request this server will make on an admin's behalf, which
 * is the shape of a server-side request forgery: `http://169.254.169.254/` is a
 * cloud metadata endpoint, and `http://localhost:5432` is the database. This is
 * not a complete SSRF defence — DNS can still resolve elsewhere — but it closes
 * the case someone reaches for first.
 */
function assertNotLoopback(app: Parameters<FastifyPluginAsyncZod>[0], url: string) {
  const host = new URL(url).hostname.toLowerCase()

  const blocked =
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '169.254.169.254'

  if (blocked) {
    throw app.httpErrors.badRequest(
      `Refusing ${host}: a webhook is a request this server makes, and that address is on its own network`,
    )
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    if (cause instanceof Error && cause.message) return `${error.message}: ${cause.message}`
    return error.message
  }
  return String(error)
}

export default routes

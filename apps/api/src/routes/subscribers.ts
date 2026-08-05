import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import {
  blindIndex,
  encryptSecret,
  generateToken,
  hashToken,
  parseUnsubscribeRef,
} from '@tern/shared'
import { config } from '../config.js'
import { audit } from '../services/audit.js'
import { sendEmail } from '../services/transports.js'

/**
 * Subscriptions.
 *
 * Double opt-in throughout. A status page that lets anyone subscribe anyone
 * else is a way to mail-bomb a third party using someone's trusted domain, and
 * the tenant is the one whose deliverability pays for it.
 */

const routes: FastifyPluginAsyncZod = async (app) => {
  await app.register(import('@fastify/rate-limit'), {
    // Signing up writes a row and sends mail. Tighter than reading.
    max: config.SUBSCRIBE_RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
  })

  app.post(
    '/public/:slug/subscribers',
    {
      onRequest: [app.requireTenant()],
      schema: {
        params: z.object({ slug: z.string() }),
        body: z.object({
          channel: z.enum(['email', 'webhook', 'slack', 'teams']).default('email'),
          address: z.string().min(3).max(500),
          scopeControlIds: z.array(z.string().uuid()).default([]),
          locale: z.enum(['en', 'fr']).default('en'),
        }),
        response: { 202: z.object({ pending: z.boolean() }) },
      },
    },
    async (req, reply) => {
      const tenant = req.tenant!
      const address = req.body.address.trim()

      if (req.body.channel === 'email') {
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
          throw app.httpErrors.badRequest('Not a valid email address')
        }
      } else if (!/^https:\/\//i.test(address)) {
        // Plain HTTP would put incident payloads and the signature on the wire
        // in clear.
        throw app.httpErrors.badRequest('Webhook and chat URLs must use HTTPS')
      }

      const addressHash = blindIndex(address, config.APP_SECRET)

      const [existing] = await app.db
        .select()
        .from(schema.subscribers)
        .where(
          and(
            eq(schema.subscribers.tenantId, tenant.id),
            eq(schema.subscribers.addressHash, addressHash),
          ),
        )
        .limit(1)

      // Always the same answer, whether the address is new, already pending, or
      // already confirmed. Anything else turns this endpoint into a way to test
      // whether a given person subscribes to a given company's status page.
      const acknowledge = () => reply.code(202).send({ pending: true })

      if (existing?.confirmedAt) return acknowledge()

      const confirmToken = generateToken(24)
      const unsubscribeToken = generateToken(24)

      if (existing) {
        // Re-issue rather than create a duplicate: someone who lost the first
        // email should be able to ask again.
        await app.db
          .update(schema.subscribers)
          .set({ confirmTokenHash: hashToken(confirmToken) })
          .where(eq(schema.subscribers.id, existing.id))
      } else {
        await app.db.insert(schema.subscribers).values({
          tenantId: tenant.id,
          channel: req.body.channel,
          addressEnc: encryptSecret(address, config.APP_SECRET),
          addressHash,
          scopeControlIds: req.body.scopeControlIds,
          locale: req.body.locale,
          confirmTokenHash: hashToken(confirmToken),
          unsubscribeTokenHash: hashToken(unsubscribeToken),
        })
      }

      if (req.body.channel === 'email') {
        const confirmUrl = `${config.PUBLIC_BASE_URL}/s/${tenant.slug}/confirm/${confirmToken}`
        await sendEmail(address, {
          subject: `Confirm your ${tenant.slug} status notifications`,
          text: `Confirm your subscription: ${confirmUrl}\n\nIf you did not request this, ignore this message — nothing further will be sent.`,
          html: `<p>Confirm your subscription:</p><p><a href="${confirmUrl}">${confirmUrl}</a></p><p>If you did not request this, ignore this message — nothing further will be sent.</p>`,
        }).catch((error: unknown) => {
          // A failed confirmation email must not reveal, by returning an error,
          // that this address was new.
          app.log.warn({ err: error }, 'failed to send confirmation email')
        })
      }

      await audit(app, {
        action: 'subscriber.requested',
        tenantId: tenant.id,
        meta: { channel: req.body.channel },
        ip: req.ip,
      })

      return acknowledge()
    },
  )

  app.post(
    '/public/:slug/subscribers/confirm/:token',
    {
      onRequest: [app.requireTenant()],
      schema: {
        params: z.object({ slug: z.string(), token: z.string().min(10) }),
        response: { 200: z.object({ confirmed: z.boolean() }) },
      },
    },
    async (req) => {
      const [subscriber] = await app.db
        .select()
        .from(schema.subscribers)
        .where(
          and(
            eq(schema.subscribers.tenantId, req.tenant!.id),
            eq(schema.subscribers.confirmTokenHash, hashToken(req.params.token)),
          ),
        )
        .limit(1)

      if (!subscriber) throw app.httpErrors.notFound('Unknown or already used link')

      await app.db
        .update(schema.subscribers)
        // The token is cleared as it is spent, so a forwarded confirmation link
        // cannot be replayed to re-confirm an address someone unsubscribed.
        .set({ confirmedAt: new Date(), confirmTokenHash: null })
        .where(eq(schema.subscribers.id, subscriber.id))

      await audit(app, {
        action: 'subscriber.confirmed',
        tenantId: req.tenant!.id,
        target: subscriber.id,
        ip: req.ip,
      })

      return { confirmed: true }
    },
  )

  /**
   * Unsubscribing needs no session, no tenant slug and no confirmation step.
   * Every extra hoop between a reader and the exit is a spam report.
   */
  app.post(
    '/unsubscribe/:token',
    {
      schema: {
        params: z.object({ token: z.string().min(10) }),
        response: { 200: z.object({ unsubscribed: z.boolean() }) },
      },
    },
    async (req) => {
      // Accepts both forms: the derived `<id>.<token>` reference carried by every
      // notification, and the one-off token issued at signup.
      const subscriberId = parseUnsubscribeRef(req.params.token, config.APP_SECRET)

      const deleted = await app.db
        .delete(schema.subscribers)
        .where(
          subscriberId
            ? eq(schema.subscribers.id, subscriberId)
            : eq(schema.subscribers.unsubscribeTokenHash, hashToken(req.params.token)),
        )
        .returning({ id: schema.subscribers.id, tenantId: schema.subscribers.tenantId })

      if (deleted.length > 0) {
        await audit(app, {
          action: 'subscriber.unsubscribed',
          tenantId: deleted[0]!.tenantId,
          ip: req.ip,
        })
      }

      // Always reports success. An unknown token answering differently would
      // let someone probe which unsubscribe links are live.
      return { unsubscribed: true }
    },
  )

  app.get(
    '/:slug/subscribers',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('subscriber:manage')],
      schema: {
        params: z.object({ slug: z.string() }),
        response: {
          200: z.object({
            total: z.number(),
            confirmed: z.number(),
            byChannel: z.record(z.string(), z.number()),
          }),
        },
      },
    },
    async (req) => {
      const rows = await app.db
        .select()
        .from(schema.subscribers)
        .where(eq(schema.subscribers.tenantId, req.tenant!.id))

      // Counts, never addresses. An admin has no operational reason to read
      // their subscribers' email addresses, and a compromised admin account
      // should not hand over a customer list.
      const byChannel: Record<string, number> = {}
      for (const row of rows) {
        byChannel[row.channel] = (byChannel[row.channel] ?? 0) + 1
      }

      return {
        total: rows.length,
        confirmed: rows.filter((r) => r.confirmedAt).length,
        byChannel,
      }
    },
  )
}

export default routes

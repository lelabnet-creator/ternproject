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
import { tenantMailFor } from '../services/tenant-mail.js'
import { sendEmail, sendWebhook } from '../services/transports.js'

/**
 * Subscriptions.
 *
 * Double opt-in throughout. A status page that lets anyone subscribe anyone
 * else is a way to mail-bomb a third party using someone's trusted domain, and
 * the tenant is the one whose deliverability pays for it.
 */

const routes: FastifyPluginAsyncZod = async (app) => {
  /*
   * A form POST and a provider's one-click POST both arrive as
   * `application/x-www-form-urlencoded`, which nothing else in this API speaks —
   * without a parser Fastify answers 415 and the unsubscribe silently fails for
   * exactly the two callers that matter.
   *
   * The body is discarded on purpose. RFC 8058 has the provider send
   * `List-Unsubscribe=One-Click`, but the token is in the path and the action is
   * the same either way, so there is nothing in the body worth trusting.
   */
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 1024 },
    (_req, _body, done) => done(null, {}),
  )

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

      const confirmUrl = `${config.PUBLIC_BASE_URL}/s/${tenant.slug}/confirm/${confirmToken}`

      /*
       * A webhook proves its own consent.
       *
       * Only the email branch used to deliver anything, so a webhook subscribed
       * from the public page was created pending and stayed that way for ever —
       * a subscription that silently never delivers. Whoever controls the
       * endpoint receives the confirmation link and follows it, which is the
       * same proof of ownership the email flow asks for.
       */
      if (req.body.channel === 'webhook') {
        await sendWebhook(
          address,
          {
            type: 'subscription.confirm',
            tenant: tenant.slug,
            confirmUrl,
            message:
              'Follow confirmUrl to start receiving status updates. Ignore this if you did not ask for it — nothing further will be sent.',
          },
          // Unsigned: there is no shared secret until the subscription exists,
          // and this message carries nothing that is a secret to the recipient.
          null,
        ).catch((error: unknown) => {
          app.log.warn({ err: error }, 'failed to deliver webhook confirmation')
        })
      }

      if (req.body.channel === 'email') {
        await sendEmail(
          address,
          {
            subject: `Confirm your ${tenant.slug} status notifications`,
            text: `Confirm your subscription: ${confirmUrl}\n\nIf you did not request this, ignore this message — nothing further will be sent.`,
            html: `<p>Confirm your subscription:</p><p><a href="${confirmUrl}">${confirmUrl}</a></p><p>If you did not request this, ignore this message — nothing further will be sent.</p>`,
          },
          // The same sender the notifications themselves use. A confirmation
          // arriving from a different address than everything that follows is
          // the shape of a phishing mail.
          { tenantMail: await tenantMailFor(app, tenant.id) },
        ).catch((error: unknown) => {
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
   * The address `List-Unsubscribe` points at, and the one in the message body.
   *
   * A GET may not unsubscribe anybody. Mail clients and security appliances
   * prefetch links in mail, so a GET that deletes would unsubscribe readers who
   * never clicked anything. It answers with a one-button page instead — one
   * click, no session, no tenant slug, no typing, because every extra hoop
   * between a reader and the exit is a spam report.
   *
   * Deliberately hand-written HTML rather than the SPA. This page is reached
   * from a mail client, sometimes an old one, often with scripting disabled, and
   * it has to work when everything else about the browser is hostile.
   */
  app.get(
    '/unsubscribe/:token',
    { schema: { params: z.object({ token: z.string().min(10) }) } },
    async (req, reply) => {
      return reply.type('text/html; charset=utf-8').send(confirmPage(req.params.token))
    },
  )

  /**
   * The actual unsubscribe.
   *
   * Reached three ways, and all three have to work: the button on the page
   * above, a provider's one-click POST under RFC 8058, and any client that
   * posts the `List-Unsubscribe` URL directly.
   */
  app.post(
    '/unsubscribe/:token',
    {
      schema: {
        params: z.object({ token: z.string().min(10) }),
      },
    },
    async (req, reply) => {
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

      /*
       * Always reports success. An unknown token answering differently would let
       * someone probe which unsubscribe links are live.
       *
       * A provider doing one-click wants a bare 200 and reads no body; a reader
       * who pressed the button wants to be told it worked. The Accept header
       * separates them, and neither is asked to understand the other's answer.
       */
      if (req.headers.accept?.includes('text/html')) {
        return reply.type('text/html; charset=utf-8').send(donePage())
      }
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

/**
 * The two pages a reader can land on, inlined.
 *
 * No stylesheet, no script, no image: this is opened from a mail client, and
 * every external reference is one more thing that can be blocked between the
 * reader and the button they came to press.
 */
function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:2.5rem 1.25rem;color:#1f2328;background:#fff;display:flex;justify-content:center}
  main{max-width:26rem}
  h1{font-size:1.25rem;margin:0 0 .75rem}
  p{margin:0 0 1.25rem;color:#57606a}
  button{font:inherit;font-weight:600;padding:.7rem 1.25rem;border-radius:.375rem;border:0;background:#1f2328;color:#fff;cursor:pointer}
  @media(prefers-color-scheme:dark){
    body{color:#e6edf3;background:#0d1117}p{color:#9198a1}button{background:#e6edf3;color:#0d1117}
  }
</style>
</head><body><main>${body}</main></body></html>`
}

function confirmPage(token: string): string {
  return shell(
    'Unsubscribe',
    `<h1>Unsubscribe from these updates?</h1>
<p>You will stop receiving status notifications at this address. You can subscribe again at any time from the status page.</p>
<form method="post" action="/api/v1/unsubscribe/${encodeURIComponent(token)}">
  <button type="submit">Unsubscribe</button>
</form>`,
  )
}

function donePage(): string {
  return shell(
    'Unsubscribed',
    `<h1>Done — you are unsubscribed.</h1>
<p>Nothing further will be sent to this address.</p>`,
  )
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export default routes

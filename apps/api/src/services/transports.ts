import { createTransport, type Transporter } from 'nodemailer'
import type { FastifyInstance } from 'fastify'
import type { schema } from '@tern/db'
import { buildUnsubscribeRef, decryptSecret, signWebhook } from '@tern/shared'
import { config } from '../config.js'

/**
 * Delivery transports, one per subscriber channel.
 *
 * Each takes a decrypted address and a rendered message. Encryption, queueing
 * and retry live elsewhere — a transport's only job is one attempt at one
 * delivery, so a failure is unambiguous and the queue can decide what to do.
 */

let mailer: Transporter | null = null

/**
 * A tenant's own mail settings, when it has them.
 *
 * Cached per tenant rather than rebuilt per message: a transporter holds a
 * connection pool, and creating one per notification would open a socket per
 * subscriber during exactly the incident that produced the mail.
 */
const tenantMailers = new Map<string, Transporter>()

export interface TenantMail {
  tenantId: string
  host: string
  port: number
  secure: boolean
  user?: string
  password?: string
  from: string
}

export function forgetTenantMailer(tenantId: string): void {
  tenantMailers.get(tenantId)?.close()
  tenantMailers.delete(tenantId)
}

function tenantTransporter(mail: TenantMail): Transporter {
  const existing = tenantMailers.get(mail.tenantId)
  if (existing) return existing

  const created = createTransport({
    host: mail.host,
    port: mail.port,
    secure: mail.secure,
    auth: mail.user ? { user: mail.user, pass: mail.password } : undefined,
  })
  tenantMailers.set(mail.tenantId, created)
  return created
}

function transporter(): Transporter {
  mailer ??= createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
  })
  return mailer
}

export interface RenderedMessage {
  subject: string
  text: string
  html: string
}

export async function sendEmail(
  to: string,
  message: RenderedMessage,
  options: { unsubscribeUrl?: string; tenantMail?: TenantMail | null } = {},
) {
  // A tenant that has configured its own sender uses it; everyone else uses the
  // instance's. One sender per installation is the right default — a tenant
  // sending as itself is the exception that has to be asked for.
  const mail = options.tenantMail
  await (mail ? tenantTransporter(mail) : transporter()).sendMail({
    from: mail?.from ?? config.MAIL_FROM,
    to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    // List-Unsubscribe is NOT advertised here. Nodemailer owns that header, and
    // in this setup it does not reach the wire — see BACKLOG.md. Sending
    // List-Unsubscribe-Post without it is actively worse than sending neither:
    // the mail client shows a one-click unsubscribe button that does nothing.
    //
    // The link in the message body is the path that actually works, and it is
    // the one most readers use anyway.
    list: options.unsubscribeUrl
      ? { unsubscribe: { url: options.unsubscribeUrl, comment: 'Unsubscribe' } }
      : undefined,
  })
}

/**
 * Posts a signed webhook.
 *
 * The signature covers `<timestamp>.<body>`, and the timestamp travels in its
 * own header so a receiver can reject anything older than a few minutes.
 * Signing the body alone leaves a captured payload replayable forever.
 */
export async function sendWebhook(
  url: string,
  payload: unknown,
  secret: string | null,
): Promise<void> {
  const body = JSON.stringify(payload)
  const timestamp = Math.floor(Date.now() / 1000)

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'TERN-Status/1.0',
    'x-tern-timestamp': String(timestamp),
  }
  if (secret) headers['x-tern-signature'] = `sha256=${signWebhook(body, secret, timestamp)}`

  // A hung endpoint must not hold a queue worker indefinitely; the queue's own
  // retry is the right place for that delay, not a socket.
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
      redirect: 'error',
    })
    if (!response.ok) {
      throw new Error(`Webhook returned ${response.status}`)
    }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Slack and Teams both accept a JSON POST to an opaque incoming-webhook URL, so
 * they share a transport and differ only in the envelope each expects.
 */
export async function sendChat(
  url: string,
  channel: 'slack' | 'teams',
  message: RenderedMessage,
): Promise<void> {
  const payload =
    channel === 'slack'
      ? { text: `*${message.subject}*\n${message.text}` }
      : {
          '@type': 'MessageCard',
          '@context': 'https://schema.org/extensions',
          summary: message.subject,
          title: message.subject,
          text: message.text,
        }

  await sendWebhook(url, payload, null)
}

/** Dispatches one queued notification to whichever channel its subscriber uses. */
export async function deliverToSubscriber(
  app: FastifyInstance,
  notification: typeof schema.notifications.$inferSelect,
  subscriber: typeof schema.subscribers.$inferSelect,
  message: RenderedMessage,
): Promise<void> {
  const address = decryptSecret(subscriber.addressEnc, config.APP_SECRET)

  switch (subscriber.channel) {
    case 'email':
      await sendEmail(address, message, {
        // Without a way out in the message itself, a reader reports it as spam
        // and the tenant's sending domain pays for it.
        // Derived from the subscriber id, so every message carries a link that
        // still works — a per-notification link would break as soon as that row
        // was cleaned up, leaving a button that silently does nothing.
        unsubscribeUrl: `${config.PUBLIC_BASE_URL}/u/${buildUnsubscribeRef(subscriber.id, config.APP_SECRET)}`,
      })
      break

    case 'webhook': {
      const secret = subscriber.webhookSecretEnc
        ? decryptSecret(subscriber.webhookSecretEnc, config.APP_SECRET)
        : null
      await sendWebhook(
        address,
        { event: notification.eventType, data: notification.payload },
        secret,
      )
      break
    }

    case 'slack':
    case 'teams':
      await sendChat(address, subscriber.channel, message)
      break
  }

  app.log.debug({ channel: subscriber.channel, notificationId: notification.id }, 'delivered')
}

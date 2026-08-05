import { createTransport, type Transporter } from 'nodemailer'
import type { FastifyInstance } from 'fastify'
import { schema } from '@tern/db'
import { decryptSecret, signWebhook } from '@tern/shared'
import { config } from '../config.js'

/**
 * Delivery transports, one per subscriber channel.
 *
 * Each takes a decrypted address and a rendered message. Encryption, queueing
 * and retry live elsewhere — a transport's only job is one attempt at one
 * delivery, so a failure is unambiguous and the queue can decide what to do.
 */

let mailer: Transporter | null = null

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
  headers: Record<string, string> = {},
) {
  await transporter().sendMail({
    from: config.MAIL_FROM,
    to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    headers,
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
        // One-click unsubscribe. Without it, a reader with no obvious way out
        // reports the message as spam, and the tenant's domain pays for it.
        'List-Unsubscribe': `<${config.PUBLIC_BASE_URL}/u/${notification.id}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
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

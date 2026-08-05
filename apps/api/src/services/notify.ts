import { and, eq, isNotNull, lte, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { schema } from '@tern/db'

/**
 * Outbound notification queue.
 *
 * Events are persisted and delivered by a worker rather than sent inline. A
 * failing SMTP server should delay notifications, not fail the request that
 * created the incident — the status update itself is the thing that must land.
 */

export interface NotifiableEvent {
  tenantId: string
  eventType: string
  payload: Record<string, unknown>
  /** Restricts delivery to subscribers watching these components. */
  controlIds?: string[]
}

/**
 * Fans an event out to the subscribers who asked for it.
 *
 * Only confirmed subscribers receive anything. An unconfirmed address has not
 * agreed to hear from this tenant, and sending to it is how a status page turns
 * into a spam vector.
 */
export async function enqueueEvent(app: FastifyInstance, event: NotifiableEvent): Promise<number> {
  const subscribers = await app.db
    .select()
    .from(schema.subscribers)
    .where(
      and(
        eq(schema.subscribers.tenantId, event.tenantId),
        isNotNull(schema.subscribers.confirmedAt),
      ),
    )

  const targets = subscribers.filter((subscriber) => {
    // An empty scope means "everything". A scoped subscriber only hears about
    // an event when it touches one of their components — otherwise a person
    // watching one API gets paged for an unrelated outage and unsubscribes.
    if (subscriber.scopeControlIds.length === 0) return true
    if (!event.controlIds || event.controlIds.length === 0) return true
    return event.controlIds.some((id) => subscriber.scopeControlIds.includes(id))
  })

  if (targets.length === 0) return 0

  await app.db.insert(schema.notifications).values(
    targets.map((subscriber) => ({
      tenantId: event.tenantId,
      subscriberId: subscriber.id,
      eventType: event.eventType,
      payload: event.payload,
    })),
  )

  return targets.length
}

/**
 * Retry schedule, in seconds: a minute, five, half an hour, two hours, then a
 * day. Front-loaded because most failures are a brief blip, and slowing down
 * afterwards so a genuinely dead endpoint is not hammered for a week.
 */
const BACKOFF_S = [60, 300, 1800, 7200, 86_400]
const MAX_ATTEMPTS = BACKOFF_S.length

export interface DeliveryResult {
  sent: number
  failed: number
}

/**
 * Delivers due notifications.
 *
 * `deliver` is injected so the worker can be tested without a mail server and so
 * each channel keeps its own transport.
 */
export async function processQueue(
  app: FastifyInstance,
  deliver: (notification: typeof schema.notifications.$inferSelect) => Promise<void>,
  batchSize = 50,
): Promise<DeliveryResult> {
  const due = await app.db
    .select()
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.status, 'pending'),
        lte(schema.notifications.nextAttemptAt, new Date()),
      ),
    )
    .limit(batchSize)

  let sent = 0
  let failed = 0

  for (const notification of due) {
    try {
      await deliver(notification)
      await app.db
        .update(schema.notifications)
        .set({ status: 'sent', sentAt: new Date(), attempts: notification.attempts + 1 })
        .where(eq(schema.notifications.id, notification.id))
      sent++
    } catch (error) {
      const attempts = notification.attempts + 1
      const exhausted = attempts >= MAX_ATTEMPTS
      const delay = BACKOFF_S[Math.min(attempts, BACKOFF_S.length - 1)] ?? 86_400

      await app.db
        .update(schema.notifications)
        .set({
          // Marked failed only once the retries are exhausted. A transient SMTP
          // error must not permanently drop an outage notification.
          status: exhausted ? 'failed' : 'pending',
          attempts,
          nextAttemptAt: new Date(Date.now() + delay * 1000),
          lastError: error instanceof Error ? error.message.slice(0, 500) : String(error),
        })
        .where(eq(schema.notifications.id, notification.id))

      failed++
      app.log.warn(
        { err: error, notificationId: notification.id, attempts },
        'notification delivery failed',
      )
    }
  }

  return { sent, failed }
}

/** Removes subscribers who never confirmed. */
export async function purgeUnconfirmed(app: FastifyInstance, olderThanDays = 7): Promise<number> {
  const result = await app.db
    .delete(schema.subscribers)
    .where(
      and(
        sql`${schema.subscribers.confirmedAt} IS NULL`,
        sql`${schema.subscribers.createdAt} < now() - (${olderThanDays} || ' days')::interval`,
      ),
    )
    .returning({ id: schema.subscribers.id })

  return result.length
}

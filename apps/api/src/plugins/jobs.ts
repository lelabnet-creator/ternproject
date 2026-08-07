import { eq } from 'drizzle-orm'
import fp from 'fastify-plugin'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { runLocalProbes } from '../services/local-probes.js'
import { schema } from '@tern/db'
import { config } from '../config.js'
import { processQueue, purgeUnconfirmed } from '../services/notify.js'
import {
  advanceMaintenances,
  applyRetention,
  purgeExpired,
  sendMaintenanceReminders,
  sweepStaleControls,
} from '../services/scheduler.js'
import { deliverToSubscriber } from '../services/transports.js'
import { buildUnsubscribeRef } from '@tern/shared'
import { renderNotification } from '../services/render.js'
import { purgeExpiredChallenges } from '../services/webauthn.js'
import { startLocalAgent } from '../services/local-agent.js'

/**
 * The background job runner.
 *
 * Everything the product promises to do on its own — advancing maintenance
 * windows, sending reminders, noticing a silent agent, delivering
 * notifications, applying retention — happens here. Without it those services
 * are code nobody calls.
 */

interface Job {
  name: string
  intervalMs: number
  run(app: FastifyInstance): Promise<unknown>
}

const JOBS: Job[] = [
  {
    // The queue is polled often: a notification that arrives ten minutes after
    // the incident it announces is worse than none, because the reader has
    // already found out another way.
    name: 'notifications',
    intervalMs: 10_000,
    run: (app) =>
      processQueue(app, async (notification) => {
        const [subscriber] = await app.db
          .select()
          .from(schema.subscribers)
          .where(eq(schema.subscribers.id, notification.subscriberId!))
          .limit(1)

        // A subscriber deleted between queueing and delivery is not an error —
        // they unsubscribed, which is exactly what should happen.
        if (!subscriber) return

        await deliverToSubscriber(
          app,
          notification,
          subscriber,
          renderNotification(
            notification,
            subscriber.locale,
            `${config.PUBLIC_BASE_URL}/u/${buildUnsubscribeRef(subscriber.id, config.APP_SECRET)}`,
          ),
        )
      }),
  },
  {
    name: 'maintenance-transitions',
    intervalMs: 30_000,
    run: advanceMaintenances,
  },
  {
    name: 'maintenance-reminders',
    intervalMs: 60_000,
    run: sendMaintenanceReminders,
  },
  {
    /*
     * The instance's own agent. Polled often and self-throttling: each control
     * carries its own interval, so a short tick only means a probe starts close
     * to when it is due rather than up to a minute late.
     */
    name: 'local-probes',
    intervalMs: 10_000,
    run: (app) => runLocalProbes(app),
  },
  {
    name: 'stale-controls',
    intervalMs: 30_000,
    run: sweepStaleControls,
  },
  {
    /*
     * Brings `Agent-local-tern` into line with the instance.
     *
     * Its preconditions — a page exists, a control worth probing exists — are
     * created by a person, long after boot. Without a tick here, an operator
     * who adds their first control would have to restart the API to get the
     * agent they were told is automatic.
     */
    name: 'local-agent',
    intervalMs: 60_000,
    run: (app) => startLocalAgent(app),
  },
  {
    // Retention deletes rows; running it hourly rather than constantly keeps it
    // off the hot path, and a few extra minutes of expired data harms nothing.
    name: 'retention',
    intervalMs: 3_600_000,
    run: applyRetention,
  },
  {
    name: 'purge-expired',
    intervalMs: 3_600_000,
    run: async (app) => {
      await purgeExpired(app)
      // Answered challenges delete themselves on use; this only collects the
      // ones nobody ever answered — a prompt dismissed, a tab closed.
      await purgeExpiredChallenges(app.db)
      return purgeUnconfirmed(app)
    },
  },
]

const plugin: FastifyPluginAsync = async (app) => {
  // Off in tests: the suite calls these functions directly with its own
  // fixtures, and a timer firing mid-assertion would write rows the test did
  // not ask for.
  if (config.NODE_ENV === 'test') {
    app.log.debug('background jobs disabled in test')
    return
  }

  const timers: NodeJS.Timeout[] = []
  // Guards against a slow run overlapping its own next tick — retention over a
  // large hypertable can easily outlast its interval.
  const running = new Set<string>()

  for (const job of JOBS) {
    const tick = async () => {
      if (running.has(job.name)) {
        app.log.warn({ job: job.name }, 'skipping tick, previous run still in flight')
        return
      }
      running.add(job.name)
      const started = Date.now()

      try {
        const result = await job.run(app)
        // Only logged when something happened. A quiet instance should not
        // produce a line per job per tick, or the log becomes unreadable
        // precisely when someone is reading it during an incident.
        if (isInteresting(result)) {
          app.log.info({ job: job.name, result, ms: Date.now() - started }, 'job ran')
        }
      } catch (error) {
        // One failing job must not take down the runner: the others still have
        // work to do, and a status page whose maintenance windows stopped
        // advancing because the mail server is down is a second outage.
        app.log.error({ err: error, job: job.name }, 'job failed')
      } finally {
        running.delete(job.name)
      }
    }

    // Jitter the first run so every job does not fire simultaneously at boot,
    // and so a restarted fleet does not synchronise into a thundering herd.
    const startDelay = Math.floor((job.intervalMs / JOBS.length) * JOBS.indexOf(job))
    const timer = setTimeout(() => {
      void tick()
      timers.push(setInterval(() => void tick(), job.intervalMs))
    }, startDelay)

    timers.push(timer)
  }

  app.addHook('onClose', async () => {
    for (const timer of timers) {
      clearTimeout(timer)
      clearInterval(timer)
    }
  })

  app.log.info({ jobs: JOBS.map((j) => j.name) }, 'background jobs started')
}

/** Suppresses "nothing happened" results so the log stays worth reading. */
function isInteresting(result: unknown): boolean {
  if (typeof result === 'number') return result > 0
  if (result && typeof result === 'object') {
    return Object.values(result).some((v) => typeof v === 'number' && v > 0)
  }
  return false
}

export default fp(plugin, { name: 'jobs', dependencies: ['db'] })

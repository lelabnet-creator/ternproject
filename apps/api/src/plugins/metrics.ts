import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { classifyRequest, HttpMetrics } from '../services/http-metrics.js'

/**
 * Feeds the per-minute counters from the request lifecycle.
 *
 * Registered before the routes so its `onRequest` runs first and its
 * `onResponse` runs for everything, including the replies Fastify generates
 * itself — a 429 never reaches a handler, and a rate-limited request is the one
 * this whole tab exists to show.
 */

declare module 'fastify' {
  interface FastifyInstance {
    metrics: HttpMetrics
  }
  interface FastifyRequest {
    /**
     * Set by `authenticateApiKey`. Lets ingest volume be attributed to the key
     * that sent it, which the monitoring route resolves to an agent name — the
     * question during a jam is which host is generating the load.
     */
    apiKeyId?: string
    /** Monotonic, so a clock adjustment mid-request cannot produce a negative. */
    metricsStart?: number
  }
}

const plugin: FastifyPluginAsync = async (app) => {
  const metrics = new HttpMetrics()
  app.decorate('metrics', metrics)
  app.decorateRequest('apiKeyId', undefined)
  app.decorateRequest('metricsStart', undefined)

  app.addHook('onRequest', async (req) => {
    if (classifyRequest(req.url) === null) return
    req.metricsStart = performance.now()
    metrics.began()
  })

  app.addHook('onResponse', async (req, reply) => {
    if (req.metricsStart === undefined) return
    metrics.finished()

    const kind = classifyRequest(req.url)
    if (!kind) return

    metrics.record({
      kind,
      latencyMs: performance.now() - req.metricsStart,
      statusCode: reply.statusCode,
      apiKeyId: req.apiKeyId,
    })
  })

  // A request that dies before a response still holds a slot in the in-flight
  // gauge. Without this the gauge only ever climbs on a failing instance, which
  // is the instance whose gauge most needs to be true.
  app.addHook('onRequestAbort', async (req) => {
    if (req.metricsStart === undefined) return
    req.metricsStart = undefined
    metrics.finished()
  })
}

export default fp(plugin, { name: 'metrics' })

import Fastify, { type FastifyInstance } from 'fastify'
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod'
import { config, isProduction } from './config.js'
import contextPlugin from './plugins/context.js'
import dbPlugin from './plugins/db.js'

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      transport: isProduction ? undefined : { target: 'pino-pretty' },
      // The bearer token, the session cookie and any probe auth header must
      // never reach the log — a log file is not a place to store credentials.
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        remove: true,
      },
    },
    // Empty by default. Believing X-Forwarded-For from an untrusted source lets
    // a caller pick its own IP, which would defeat both rate limiting and the
    // per-tenant IP allowlist.
    trustProxy: config.TRUSTED_PROXIES.length > 0 ? config.TRUSTED_PROXIES : false,
  }).withTypeProvider<ZodTypeProvider>()

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  await app.register(import('@fastify/sensible'))

  // Right after sensible, whose errors it reshapes: every error body this API
  // sends is an RFC 9457 problem document — see the plugin for why.
  await app.register(import('./plugins/problem-json.js'))
  // And the protocol version check + DEV wire trace for the agent routes.
  await app.register(import('./plugins/agent-protocol.js'))

  await app.register(import('@fastify/cookie'))
  await app.register(import('@fastify/cors'), {
    // Credentials travel in a cookie, so the origin cannot be a wildcard.
    origin: config.PUBLIC_BASE_URL,
    credentials: true,
  })

  // Before the routes, so its hooks wrap every one of them — including the
  // replies Fastify generates itself, which is where the 429s are.
  await app.register(import('./plugins/metrics.js'))

  /*
   * The API, described by the API.
   *
   * Nothing here annotates a route. Every one of them already declares its
   * params, query, body and responses in Zod because that is what validates
   * them, and `jsonSchemaTransform` reads those same objects — so the document
   * cannot describe a contract the server does not enforce. A hand-written
   * reference would be a second description of ninety-nine endpoints, and it
   * would start drifting on the first one somebody changed.
   *
   * Public, like the guides. It maps routes whose authorisation is checked on
   * the server; hiding the map does not move the lock, it only makes anyone
   * integrating guess at it.
   *
   * Registered before the routes because the plugin collects them as they are
   * added, and after the metrics for the same reason those come first.
   */
  await app.register(import('@fastify/swagger'), {
    openapi: {
      info: {
        title: 'TERN',
        description:
          'IT service status pages, live or historized.\n\n' +
          'Session endpoints authenticate with the cookie set by `POST /api/v1/auth/login`. ' +
          'Ingest authenticates with a receiver key as a bearer token. Everything under ' +
          '`/api/v1/public` needs neither.',
        version: config.TERN_VERSION || '0.0.0-dev',
        license: { name: 'AGPL-3.0-or-later', url: 'https://www.gnu.org/licenses/agpl-3.0.html' },
      },
      servers: [{ url: config.PUBLIC_BASE_URL }],
    },
    transform: jsonSchemaTransform,
  })

  await app.register(import('@fastify/swagger-ui'), {
    routePrefix: '/api/v1/docs',
    // Its own assets, served from this instance. A reference that fetches a
    // bundle from a CDN is a reference that is blank on the air-gapped installs
    // this product is explicitly built for.
    staticCSP: true,
    uiConfig: { docExpansion: 'list', deepLinking: true, tryItOutEnabled: true },
  })

  /*
   * The document under the name everyone guesses.
   *
   * The UI plugin serves it at `/api/v1/docs/json`, which is an implementation
   * detail of that plugin — a generator, a Postman import or a contract test
   * will try `openapi.json` first, and a 404 there reads as "this API has no
   * schema" rather than as "look elsewhere". Same object, so the two can never
   * disagree.
   *
   * Outside the schema-validated routes on purpose: `app.swagger()` returns the
   * whole document, and declaring a response shape for it would be describing
   * the description.
   */
  app.get('/api/v1/openapi.json', { schema: { hide: true } }, () => app.swagger())

  /*
   * Grouped, from the paths themselves.
   *
   * A hundred operations in one flat list is a document nobody reads twice. The
   * alternative was a `tags` line on every route in twenty-one files — work
   * that would be redone on each new route and forgotten on some of them.
   *
   * Derived instead, in one place, from the segment that already says what the
   * route is about. It cannot go stale: a route added tomorrow is grouped by
   * where its author put it, which is the same decision they already made.
   */
  app.addHook('onRoute', (route) => {
    const schema = (route.schema ?? {}) as { tags?: string[]; hide?: boolean }
    if (schema.hide || schema.tags) return
    const tag = areaOf(route.url)
    if (tag) route.schema = { ...route.schema, tags: [tag] }
  })

  await app.register(dbPlugin)
  await app.register(contextPlugin)
  await app.register(import('./plugins/jobs.js'))
  await app.register(import('./plugins/local-agent.js'))

  app.get('/health', async () => {
    await app.sql`SELECT 1`
    return { status: 'ok' }
  })

  await app.register(import('./routes/auth.js'), { prefix: '/api/v1/auth' })
  await app.register(import('./routes/setup.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/ingest.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/agents.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/status.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/incidents.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/maintenances.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/badge.js'))
  await app.register(import('./routes/feeds.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/subscribers.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/notifications.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/system.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/settings.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/logs.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/monitoring.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/danger.js'), { prefix: '/api/v1' })
  // No prefix: the installer lives at /install.sh, which is where a one-liner
  // can be read aloud.
  await app.register(import('./routes/download.js'))
  await app.register(import('./routes/receivers.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/controls.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/controls-import.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/control-groups.js'), { prefix: '/api/v1' })

  // Last: its catch-all answers whatever the routes above did not claim, so it
  // has to be registered once they all have.
  await app.register(import('./plugins/web.js'))

  return app
}

/**
 * Which part of the product a path belongs to.
 *
 * The shapes the API actually has: what a visitor may call, what an agent
 * calls, what an operator calls about one tenant, what concerns the instance,
 * and the handful of paths that sit outside /api/v1 on purpose.
 *
 * Anything unrecognised is left ungrouped rather than filed under a guess — an
 * operation in the wrong section is worse than one in none, because the reader
 * stops looking for it.
 */
function areaOf(url: string): string | null {
  // Deliberately outside /api/v1, and each for a reason: a badge URL is pasted
  // into a README, an installer is read aloud as a one-liner, and a healthcheck
  // is typed by an orchestrator that knows nothing about versions. They are
  // still part of the surface, so they are still grouped.
  if (url === '/health') return 'System'
  if (url.startsWith('/badge/')) return 'Badges'
  if (url.startsWith('/install.')) return 'Downloads'

  const parts = url.split('/').filter(Boolean)
  // api, v1, …
  if (parts[0] !== 'api' || parts[1] !== 'v1') return null

  const third = parts[2]
  if (!third) return null

  if (third === 'auth') return 'Authentication'
  if (third === 'public') return 'Public'
  if (third === 'agent') return 'Agents'
  if (third === 'system') return 'System'
  if (third === 'ingest') return 'Ingest'
  if (third === 'openapi.json' || third === 'docs') return null

  // Everything else is tenant-scoped: /api/v1/:slug/<area>[/…]
  const area = parts[3]
  if (!area) return 'Tenants'

  const named: Record<string, string> = {
    controls: 'Controls',
    'control-groups': 'Controls',
    incidents: 'Incidents',
    maintenances: 'Maintenance',
    agents: 'Agents',
    receivers: 'Ingest',
    subscribers: 'Subscribers',
    notifications: 'Notifications',
    settings: 'Settings',
    layout: 'Settings',
    logs: 'Logs',
    monitoring: 'Monitoring',
    probe: 'Controls',
  }

  return named[area] ?? 'Tenants'
}

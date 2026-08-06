import Fastify, { type FastifyInstance } from 'fastify'
import {
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
  await app.register(import('@fastify/cookie'))
  await app.register(import('@fastify/cors'), {
    // Credentials travel in a cookie, so the origin cannot be a wildcard.
    origin: config.PUBLIC_BASE_URL,
    credentials: true,
  })

  await app.register(dbPlugin)
  await app.register(contextPlugin)
  await app.register(import('./plugins/jobs.js'))

  app.get('/health', async () => {
    await app.sql`SELECT 1`
    return { status: 'ok' }
  })

  await app.register(import('./routes/auth.js'), { prefix: '/api/v1/auth' })
  await app.register(import('./routes/ingest.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/agents.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/status.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/incidents.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/badge.js'))
  await app.register(import('./routes/feeds.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/subscribers.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/notifications.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/system.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/settings.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/logs.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/danger.js'), { prefix: '/api/v1' })
  // No prefix: the installer lives at /install.sh, which is where a one-liner
  // can be read aloud.
  await app.register(import('./routes/download.js'))
  await app.register(import('./routes/receivers.js'), { prefix: '/api/v1' })
  await app.register(import('./routes/controls.js'), { prefix: '/api/v1' })

  return app
}

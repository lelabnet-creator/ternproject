import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

/**
 * Serves the built single-page app from the API process.
 *
 * `docs/operations.md` describes one process answering both the API and the web
 * app, and `apps/web/vite.config.ts` proxies the same set of paths in
 * development so the session cookie behaves identically in both. This plugin is
 * the production half of that arrangement — without it the SPA has to be hosted
 * separately, which reintroduces the cross-origin cookie problem the proxy list
 * exists to avoid.
 */

/**
 * Prefixes the API owns. A GET that matches one of these must never fall
 * through to `index.html`: `curl … /install.sh | sh` would then pipe a web page
 * into a shell, and the resulting syntax error says nothing about the cause.
 *
 * This mirrors the proxy table in `apps/web/vite.config.ts` — the two lists
 * describe the same boundary and have to move together.
 */
const API_OWNED = ['/api/', '/install.sh', '/install.ps1', '/badge/', '/health']

function isApiOwned(url: string): boolean {
  const path = url.split('?')[0] ?? url
  return API_OWNED.some((prefix) =>
    prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix,
  )
}

/** Where `apps/web` writes its build, unless an explicit path is given. */
function defaultWebDist(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', '..', '..', 'web', 'dist')
}

async function webPlugin(app: FastifyInstance): Promise<void> {
  const dist = process.env.WEB_DIST_DIR ? resolve(process.env.WEB_DIST_DIR) : defaultWebDist()

  // Absent in development and in tests, where Vite serves the app instead.
  // Staying quiet-but-explicit beats failing to boot: an API with no UI is
  // still a working API.
  if (!existsSync(join(dist, 'index.html'))) {
    app.log.info({ dist }, 'no built web app found — serving the API only')
    return
  }

  await app.register(import('@fastify/static'), {
    root: dist,
    // The catch-all below owns unmatched paths. @fastify/static's own wildcard
    // would answer them with a 404 before the SPA fallback ever runs.
    wildcard: false,
    index: false,
  })

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const isRead = request.method === 'GET' || request.method === 'HEAD'

    if (!isRead || isApiOwned(request.url)) {
      return reply.code(404).send({ error: 'Not Found' })
    }

    // Client-side routing: every other GET is a deep link into the SPA, which
    // resolves the route itself once index.html has loaded.
    return reply.type('text/html').sendFile('index.html')
  })

  app.log.info({ dist }, 'serving the built web app')
}

export default fp(webPlugin, { name: 'web' })

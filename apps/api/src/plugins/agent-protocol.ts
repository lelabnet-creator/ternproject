import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from '@tern/shared'
import { config } from '../config.js'
import { withCode } from './problem-json.js'

/**
 * The protocol version check, and the DEV-mode wire trace.
 *
 * ## Version
 *
 * There is no negotiation: the fleet and the server ship together, and a
 * mismatch is answered loudly — 400 `protocol-mismatch` naming both versions,
 * plus a warn in the log — rather than guessed around. The alternative was the
 * status quo: no version anywhere, and compatibility maintained as a
 * per-field discipline that nothing enforced.
 *
 * The check is strict only where the caller is known to be our binary. The
 * ingest and curl-heartbeat paths verify the header *if present*, because
 * their promise is "a bare curl works" and a mandatory header would break
 * every hand-written client for no gain — a scripted `curl` has no version to
 * be wrong about.
 *
 * ## Trace (`TERN_PROTOCOL_TRACE=1`)
 *
 * One debug line per protocol request and response, bodies included, under
 * `mod: 'agent-protocol'`. This is the server half of the agent's own
 * `TERN_PROTOCOL_TRACE`; together they show both ends of the same exchange.
 * Debug level on purpose: the trace rides the existing logger and its
 * redaction, and turning it on does not change what production logs at info.
 */

/** Routes where the caller is our binary and the header is required. */
function headerRequired(path: string): boolean {
  if (path === '/api/v1/pair') return true
  if (!path.startsWith('/api/v1/agent/')) return false
  // The download surface sits under /agent/ but serves browsers and scripts:
  // a binary fetch has no protocol to announce.
  return !path.startsWith('/api/v1/agent/releases') && !path.startsWith('/api/v1/agent/bin/')
}

/** Routes that speak the protocol only when the caller says so. */
function headerCheckedIfPresent(path: string): boolean {
  return path === '/api/v1/ingest' || path.startsWith('/api/v1/heartbeat/')
}

const plugin: FastifyPluginAsync = async (app) => {
  const trace = config.TERN_PROTOCOL_TRACE ? app.log.child({ mod: 'agent-protocol' }) : null

  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0] ?? req.url
    const required = headerRequired(path)
    if (!required && !headerCheckedIfPresent(path)) return

    const announced = req.headers[PROTOCOL_HEADER]
    if (announced === undefined && !required) return

    if (announced !== String(PROTOCOL_VERSION)) {
      req.log.warn(
        { path, announced: announced ?? null, speaks: PROTOCOL_VERSION },
        'protocol mismatch',
      )
      throw withCode(
        app.httpErrors.badRequest(
          `This server speaks protocol ${PROTOCOL_VERSION}; the request announced ` +
            (announced === undefined ? 'none' : `${announced}`) +
            '. Server and agents are upgraded together — update the older side.',
        ),
        'protocol-mismatch',
      )
    }
  })

  app.addHook('onSend', async (req, reply, payload) => {
    const path = req.url.split('?')[0] ?? req.url
    if (!headerRequired(path) && !headerCheckedIfPresent(path)) return payload

    // Echoed on every protocol reply, so either side of a mismatch can quote
    // the other's version instead of describing symptoms.
    reply.header(PROTOCOL_HEADER, String(PROTOCOL_VERSION))

    if (trace) {
      trace.debug(
        {
          method: req.method,
          path,
          status: reply.statusCode,
          // Parsed request body and serialized reply, capped: a `logs` result
          // is up to 256k and the trace is for reading exchanges, not storing
          // them.
          request: req.body ?? null,
          response: typeof payload === 'string' ? payload.slice(0, 4_000) : null,
        },
        'protocol exchange',
      )
    }

    return payload
  })
}

export default fp(plugin, { name: 'agent-protocol', dependencies: ['problem-json'] })

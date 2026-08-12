import { STATUS_CODES } from 'node:http'
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod'
import { isProduction } from '../config.js'

/**
 * Every error this API sends is an RFC 9457 problem document.
 *
 * Before this there were two formats at once: `@fastify/sensible` answered
 * `{statusCode, error, message}` and the Zod validator answered with its own
 * issue list — so the agent, which branches on what went wrong, parsed neither
 * and logged raw text. One handler, one shape, and a stable `code` a program
 * can switch on while `title`/`detail` stay free to be reworded.
 *
 * Routes keep throwing `app.httpErrors.*`; the status alone picks a generic
 * `code`. Where the *reason* matters more than the status — a valid key with no
 * agent behind it, a protocol mismatch — the route names it with `withCode`.
 */

/** Marks an HttpError with the machine-readable code the handler will emit. */
export function withCode<E extends Error>(error: E, code: string): E {
  ;(error as E & { ternCode?: string }).ternCode = code
  return error
}

const CODE_BY_STATUS: Record<number, string> = {
  400: 'bad-request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not-found',
  409: 'conflict',
  413: 'payload-too-large',
  429: 'rate-limited',
  500: 'internal',
}

/** A name, not a link that must resolve — see `problemSchema` in @tern/shared. */
const TYPE_BASE = 'https://tern.dev/problems/'

const plugin: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, req, reply) => {
    const instance = req.url.split('?')[0]

    if (hasZodFastifySchemaValidationErrors(error)) {
      // The issue list is the useful part: "body/agents/0/lastSeenAt" names the
      // field where "Bad Request" names nothing.
      const issues = error.validation.map((issue) => ({
        path: issue.instancePath,
        message: issue.message ?? '',
      }))

      req.log.warn({ instance, issues }, 'request failed validation')

      return reply
        .code(400)
        .type('application/problem+json')
        .send({
          type: `${TYPE_BASE}validation`,
          title: 'Bad Request',
          status: 400,
          code: 'validation',
          detail: issues.map((issue) => `${issue.path} ${issue.message}`.trim()).join('; '),
          instance,
          issues,
        })
    }

    // The two guards above narrow `error` all the way to `unknown` in their
    // negative branch; from here on it is an ordinary thrown error again.
    const err = error as Error & { statusCode?: number; ternCode?: string }

    if (isResponseSerializationError(error)) {
      // The server built a reply its own schema refuses — a bug here, never
      // the caller's fault, and the caller gets no internals.
      req.log.error({ err: error, instance }, 'response failed its own schema')
      return reply.code(500).type('application/problem+json').send({
        type: `${TYPE_BASE}internal`,
        title: 'Internal Server Error',
        status: 500,
        code: 'internal',
        instance,
      })
    }

    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500
    const code = err.ternCode ?? CODE_BY_STATUS[status] ?? 'internal'

    if (status >= 500) {
      req.log.error({ err, instance }, 'request failed')
    } else {
      // Warn, not info: a 4xx on an authenticated machine channel is either a
      // misconfiguration or an intrusion attempt, and both deserve a line.
      req.log.warn({ instance, status, code }, err.message)
    }

    return reply
      .code(status)
      .type('application/problem+json')
      .send({
        type: `${TYPE_BASE}${code}`,
        title: STATUS_CODES[status] ?? 'Error',
        status,
        code,
        // A 5xx detail would leak internals; everything 4xx was written to be
        // shown to the caller.
        ...(status < 500
          ? { detail: err.message }
          : isProduction
            ? {}
            : { detail: err.message }),
        instance,
      })
  })
}

export default fp(plugin, { name: 'problem-json' })

import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { config } from '../config.js'
import { startLocalAgent, stopLocalAgent } from '../services/local-agent.js'

/**
 * Provisions `Agent-local-tern` once the server is listening, and stops the
 * binary — if this process is the one running it — on the way down.
 *
 * `onListen` rather than `onReady`: the agent's first request goes to this very
 * process, so anything earlier only earns a connection refused and a retry.
 *
 * The call is deliberately not awaited into the listen path. Provisioning talks
 * to the database and may spawn a process, and neither is a reason for an
 * instance to fail to accept traffic — an API that will not start because its
 * optional agent could not be written to disk is the worse outcome.
 */
const plugin: FastifyPluginAsync = async (app) => {
  // Off in tests for the same reason the job runner is: the suite would
  // otherwise spawn a real agent per fixture, each pushing measurements into
  // assertions that did not ask for them.
  if (config.NODE_ENV === 'test') return

  app.addHook('onListen', async () => {
    startLocalAgent(app).catch((error) => {
      app.log.error({ err: error }, 'could not start the local agent')
    })
  })

  app.addHook('onClose', async () => {
    stopLocalAgent()
  })
}

export default fp(plugin, { name: 'local-agent', dependencies: ['db'] })

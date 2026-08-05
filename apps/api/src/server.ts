import { buildApp } from './app.js'
import { config } from './config.js'

const app = await buildApp()

// SIGTERM arrives from Docker and systemd on every restart. Closing cleanly
// drains in-flight requests and returns database connections instead of
// dropping both.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, shutting down`)
    app.close().then(
      () => process.exit(0),
      (error) => {
        app.log.error({ err: error }, 'error during shutdown')
        process.exit(1)
      },
    )
  })
}

try {
  await app.listen({ port: config.API_PORT, host: config.API_HOST })
} catch (error) {
  app.log.error({ err: error }, 'failed to start')
  process.exit(1)
}

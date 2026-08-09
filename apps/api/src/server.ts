import { buildApp } from './app.js'
import { config } from './config.js'
import { releaseState } from './services/release.js'

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

/*
 * The registry is asked once, now, rather than by whoever opens the admin first.
 *
 * The verdict is cached in memory for `TERN_UPDATE_CHECK_INTERVAL_H` hours, so
 * before this the answer was primed by the first admin to load a page — who
 * then waited on ghcr.io for it, and who, on an instance nobody had visited
 * since the restart, was shown a banner computed from a request made while they
 * watched. Doing it here means the answer is already there, and it makes a
 * restart the obvious way to force a fresh check: the cache lives in this
 * process and dies with it.
 *
 * After `listen`, and never awaited. An instance that waited on a registry to
 * become reachable would be an instance that a slow network can stop from
 * starting — and the whole point of this feature is that a registry it cannot
 * reach is answered with "we do not know", not with silence.
 *
 * `releaseState` settles its own failures into that verdict, so the rejection
 * path here is for the unforeseen. It is logged and dropped: nothing about
 * serving status pages depends on knowing whether a newer image exists.
 */
void releaseState().then(
  (release) => {
    app.log.info(
      { state: release.state, current: release.current, latest: release.latest },
      release.detail,
    )
  },
  (error: unknown) => app.log.warn({ err: error }, 'the release check could not be made'),
)

import { hostname } from 'node:os'
import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { createDatabase, type Database } from '@tern/db'
import { config } from '../config.js'

type SqlClient = ReturnType<typeof createDatabase>['sql']

declare module 'fastify' {
  interface FastifyInstance {
    db: Database
    /**
     * The raw postgres client. Needed where SQL says it better than the query
     * builder does — TimescaleDB aggregate windows, `inet` containment,
     * `LISTEN/NOTIFY` — rather than as a general escape hatch.
     */
    sql: SqlClient
  }
}

/**
 * Names this process's connections so `pg_stat_activity` can be filtered to
 * them. Host and pid rather than a constant: the point of the number is "how
 * much of *this* instance's pool is busy", and a shared name would answer for
 * the whole deployment while looking like it answered for one.
 */
export const APPLICATION_NAME = `tern-api/${hostname()}/${process.pid}`

const plugin: FastifyPluginAsync = async (app) => {
  const { db, sql } = createDatabase(config.DATABASE_URL, {
    max: config.DB_POOL_MAX,
    applicationName: APPLICATION_NAME,
  })

  app.decorate('db', db)
  app.decorate('sql', sql)

  app.addHook('onClose', async () => {
    await sql.end()
  })
}

export default fp(plugin, { name: 'db' })

import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema/index.js'

export type Database = ReturnType<typeof createDatabase>['db']

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.')
  }
  return url
}

/**
 * Opens a connection pool and returns both the Drizzle handle and the raw
 * client — migrations and the seed need the latter to run plain SQL, and
 * long-running processes need it to close cleanly on shutdown.
 */
export function createDatabase(url: string = databaseUrl(), options: { max?: number } = {}) {
  const sql = postgres(url, {
    max: options.max ?? 10,
    // Timestamps are stored with a timezone and rendered in the viewer's own
    // zone; keeping the connection in UTC removes one place to get that wrong.
    types: {},
    onnotice: () => {},
  })
  const db = drizzle(sql, { schema, casing: 'snake_case' })
  return { db, sql }
}

export { schema }

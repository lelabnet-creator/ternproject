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
 *
 * Important when using the raw `sql` handle: Drizzle installs its own type
 * parsers on the underlying client so it can map rows itself. A side effect is
 * that raw queries get `timestamptz` back as a **string**, not a Date. Use
 * `toDate()` below on any timestamp read through `sql` — calling
 * `.toISOString()` on it otherwise throws, and only on the routes that happen
 * to read a timestamp.
 */
export function createDatabase(url: string = databaseUrl(), options: { max?: number } = {}) {
  const sql = postgres(url, { max: options.max ?? 10, onnotice: () => {} })
  const db = drizzle(sql, { schema, casing: 'snake_case' })
  return { db, sql }
}

export { schema }

/**
 * Normalises a timestamp coming out of a raw `sql` query.
 *
 * Drizzle's parsers make those arrive as strings; anything already a Date
 * passes through untouched, so this is safe to apply on either path.
 */
export function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

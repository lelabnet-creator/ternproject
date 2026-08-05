import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDatabase } from './client.js'
import { loadEnv } from './env.js'

loadEnv()

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')

/**
 * Migrations run in two passes.
 *
 * 1. Drizzle applies the generated DDL — it owns table shape.
 * 2. Hand-written SQL in `sql/` applies what Drizzle cannot express:
 *    hypertables, continuous aggregates, compression and retention policies.
 *
 * The second pass is tracked by checksum in its own table rather than folded
 * into Drizzle's journal. Editing a TimescaleDB policy is a normal thing to do
 * during development, and re-running an idempotent file is the honest way to
 * apply that edit; silently ignoring it because a filename was already recorded
 * is how a schema and its migrations drift apart.
 */
async function main() {
  const { db, sql } = createDatabase(undefined, { max: 1 })

  try {
    console.warn('→ applying Drizzle migrations')
    await migrate(db, { migrationsFolder: join(packageRoot, 'migrations') })

    console.warn('→ applying TimescaleDB SQL')
    await sql`
      CREATE TABLE IF NOT EXISTS sql_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `

    const sqlDir = join(packageRoot, 'sql')
    const files = (await readdir(sqlDir)).filter((f) => f.endsWith('.sql')).sort()

    for (const file of files) {
      const body = await readFile(join(sqlDir, file), 'utf8')
      const checksum = createHash('sha256').update(body).digest('hex')

      const [existing] = await sql<{ checksum: string }[]>`
        SELECT checksum FROM sql_migrations WHERE name = ${file}
      `
      if (existing?.checksum === checksum) {
        console.warn(`  · ${file} (unchanged)`)
        continue
      }

      // Not wrapped in a transaction: several TimescaleDB statements
      // (create_hypertable on a populated table, policy registration) cannot
      // run inside one. That is why every statement in these files is written
      // to be idempotent.
      await sql.unsafe(body)
      await sql`
        INSERT INTO sql_migrations (name, checksum) VALUES (${file}, ${checksum})
        ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()
      `
      console.warn(`  ✓ ${file}`)
    }

    console.warn('✓ migrations complete')
  } finally {
    await sql.end()
  }
}

main().catch((error) => {
  console.error('✗ migration failed:', error)
  process.exit(1)
})

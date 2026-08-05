import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

/**
 * Loads the repository-root `.env`.
 *
 * Scripts in this package run with their own directory as cwd, so plain
 * `dotenv/config` would look in `packages/db` and find nothing. One `.env` at
 * the root is what people expect from a monorepo — the alternative is a copy per
 * package, and copies of a file holding APP_SECRET drift.
 */
export function loadEnv(): void {
  let dir = dirname(fileURLToPath(import.meta.url))

  for (let depth = 0; depth < 6; depth++) {
    const candidate = join(dir, '.env')
    if (existsSync(candidate)) {
      config({ path: candidate, quiet: true })
      return
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // No .env is fine: the environment may be populated by Docker or CI.
  config({ quiet: true })
}

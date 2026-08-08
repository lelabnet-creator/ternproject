/**
 * The instance the end-to-end suite runs against.
 *
 * A real `docker-compose.prod.yml` stack, built from this checkout — not a dev
 * server. The things most worth testing end to end are the ones only a real
 * instance has: the entrypoint settling `APP_SECRET`, the migrations, the
 * first-run window, the agent container reporting. A `pnpm dev` process has
 * none of them, and a suite that passed against it would be testing a
 * deployment nobody ships.
 *
 * Its own compose project and its own port, so it can never adopt the
 * containers or volumes of an instance somebody is using. Torn down with `-v`:
 * the first-run window only exists on an empty database, so a suite that left
 * its volumes behind would pass once and then fail on every later run.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync, rmSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export const PROJECT = 'tern-e2e'
export const PORT = 28997
export const BASE_URL = `http://localhost:${PORT}`

const ENV_FILE = join(root, 'e2e', '.env.e2e')
const COMPOSE = join(root, 'docker-compose.prod.yml')

const compose = (args, options = {}) =>
  execFileSync(
    'docker',
    ['compose', '-p', PROJECT, '--env-file', ENV_FILE, '-f', COMPOSE, ...args],
    { cwd: root, stdio: 'inherit', ...options },
  )

export function up() {
  // Written per run rather than committed: it holds a generated APP_SECRET, and
  // a secret in the repository is a secret however synthetic it is.
  //
  // No TERN_TENANT_* or TERN_ADMIN_*: leaving them unset is what leaves the
  // first-run window open, and that window is the first thing the suite tests.
  writeFileSync(
    ENV_FILE,
    [
      `POSTGRES_PASSWORD=${randomBytes(16).toString('hex')}`,
      `APP_SECRET=${randomBytes(32).toString('hex')}`,
      `TERN_HTTP_PORT=${PORT}`,
      `PUBLIC_BASE_URL=${BASE_URL}`,
      'TERN_IMAGE=tern:e2e',
      'LOG_LEVEL=warn',
      '',
    ].join('\n'),
    { mode: 0o600 },
  )

  // Built every run. Docker's layer cache makes it quick when nothing changed,
  // and the alternative — reusing whatever `tern:e2e` happens to be lying
  // around — is a suite that reports on code somebody wrote last week.
  execFileSync(
    'docker',
    ['compose', '-p', PROJECT, '--env-file', ENV_FILE, '-f', COMPOSE, 'build', 'app'],
    { cwd: root, stdio: 'inherit' },
  )

  // --wait returns on the healthcheck, so after the migrations rather than
  // merely after the container exists.
  compose(['up', '-d', '--wait'])
}

export function down() {
  try {
    compose(['down', '-v'], { stdio: 'ignore' })
  } finally {
    rmSync(ENV_FILE, { force: true })
  }
}

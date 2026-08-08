import { rmSync, mkdirSync } from 'node:fs'
import { up } from './stack.mjs'

/**
 * Brings up the instance the suite runs against.
 *
 * The saved sign-in is cleared first. It is written by the first-run spec
 * against a database this setup is about to create fresh, so a file left by
 * yesterday's run holds a session for a tenant that no longer exists — and the
 * failure it causes lands in whichever spec happens to run first, pointing
 * nowhere near the cause.
 */
export default function globalSetup() {
  rmSync('e2e/.auth', { recursive: true, force: true })
  mkdirSync('e2e/.auth', { recursive: true })
  up()
}

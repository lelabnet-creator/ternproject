import { down } from './stack.mjs'

/**
 * Takes the instance down, volumes included.
 *
 * Unconditional. Leaving it up after a failure sounds helpful — the logs are
 * right there — but the next run then finds a database with an administrator
 * already in it and fails in the first-run spec, which is nowhere near
 * whatever actually broke. `docker compose -p tern-e2e logs` while the run is
 * still going is the way to look.
 */
export default function globalTeardown() {
  down()
}

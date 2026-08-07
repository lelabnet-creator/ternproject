/**
 * The password floor, in one place.
 *
 * It was written out as a literal in five: two auth routes, the first-run
 * endpoint, the provisioning script and two screens. They had already drifted
 * apart in wording, and a floor that lives in five files is a floor that will
 * be raised in four of them.
 *
 * Pure and dependency-free, with its own subpath export, because the web app
 * needs it too and the package barrel pulls in `@node-rs/argon2` — see the note
 * in `index.ts`.
 */

/**
 * Eight characters.
 *
 * Stated plainly: this is a floor, not a policy. It is what NIST SP 800-63B
 * sets as the minimum for a user-chosen secret, and it is paired here with
 * Argon2id hashing and hard rate limiting on every endpoint that verifies one —
 * which is what actually decides whether guessing works. Length beyond this is
 * left to the person choosing, and the interface encourages rather than
 * enforces it.
 */
export const PASSWORD_MIN_LENGTH = 8

/** The one sentence every screen and endpoint uses to say it. */
export const PASSWORD_MIN_MESSAGE = `Use at least ${PASSWORD_MIN_LENGTH} characters`

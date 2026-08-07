import { eq, lt } from 'drizzle-orm'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import type { Database } from '@tern/db'
import { schema } from '@tern/db'
import { config } from '../config.js'

/**
 * Passkeys.
 *
 * WebAuthn in one paragraph, because the rest of this file assumes it: the
 * browser holds a private key it will never hand over, the server holds the
 * matching public key, and signing in means the server sends a random challenge
 * and checks the signature that comes back. Nothing reusable crosses the wire,
 * so there is no shared secret to phish, to reuse on another site, or to leak
 * in a dump.
 *
 * What makes it phishing-resistant is the *origin binding*, and that is the
 * part with operational consequences — see `relyingParty()` below.
 */

/**
 * How long a challenge stays answerable.
 *
 * Two minutes. The floor is a person finding a security key in a drawer or
 * reaching for a phone; the ceiling is that an unanswered challenge is a row
 * sitting in a table doing nothing useful.
 */
const CHALLENGE_TTL_MS = 2 * 60 * 1000

/**
 * Who the browser thinks it is talking to.
 *
 * The RP ID is a domain, derived from `PUBLIC_BASE_URL` — it is not free-form.
 * The browser refuses to create or use a credential whose RP ID does not match
 * the page's own origin, and that refusal is exactly the property that stops a
 * lookalike domain from replaying a passkey.
 *
 * The consequence is worth stating rather than discovering: **passkeys are
 * bound to the hostname**. Move an instance from `status.example.com` to
 * `status.example.net` and every registered passkey stops working there. That
 * is not a bug to be worked around; it is the guarantee. It is also why the
 * password stays mandatory — after such a move, the password and the emailed
 * reset link are what get the operator back in.
 *
 * A port is deliberately not part of the RP ID (the spec has no place for one),
 * while the *origin* check does include it. In development that means an RP ID
 * of `localhost` and an expected origin of `http://localhost:5173`.
 */
export function relyingParty() {
  const url = new URL(config.PUBLIC_BASE_URL)
  return {
    id: url.hostname,
    origin: url.origin,
    // Shown by the authenticator's own prompt — "Save a passkey for TERN?" —
    // so it names the product rather than the instance's hostname, which the
    // browser is about to show anyway.
    name: 'TERN',
  }
}

/**
 * Mints a challenge and records it.
 *
 * Recorded server-side because single use is the whole requirement: an
 * assertion that can be replayed is not an authentication. The row is deleted
 * when it is consumed, so a second attempt with the same challenge finds
 * nothing and fails — see `consumeChallenge`.
 */
async function storeChallenge(
  db: Database,
  challenge: string,
  kind: 'register' | 'authenticate',
  userId?: string,
): Promise<void> {
  await db.insert(schema.webauthnChallenges).values({
    challenge,
    kind,
    userId: userId ?? null,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  })
}

/**
 * Claims a challenge, or refuses.
 *
 * The delete is the claim: it returns the row only to the first caller, so two
 * requests racing with the same challenge cannot both proceed. Expiry is
 * checked after the delete rather than before — an expired challenge is spent
 * either way, and leaving it behind would let it be retried until the sweeper
 * came round.
 */
async function consumeChallenge(
  db: Database,
  challenge: string,
  kind: 'register' | 'authenticate',
): Promise<{ userId: string | null } | null> {
  const [row] = await db
    .delete(schema.webauthnChallenges)
    .where(eq(schema.webauthnChallenges.challenge, challenge))
    .returning()

  if (!row) return null
  // A registration challenge must not be answerable with an assertion, nor the
  // reverse: they authorise different things.
  if (row.kind !== kind) return null
  if (row.expiresAt.getTime() <= Date.now()) return null
  return { userId: row.userId }
}

/** Swept on the same schedule as expired sessions; see plugins/jobs.ts. */
export async function purgeExpiredChallenges(db: Database): Promise<void> {
  await db
    .delete(schema.webauthnChallenges)
    .where(lt(schema.webauthnChallenges.expiresAt, new Date()))
}

export async function credentialsFor(db: Database, userId: string) {
  return db
    .select()
    .from(schema.webauthnCredentials)
    .where(eq(schema.webauthnCredentials.userId, userId))
}

// ── Registration ────────────────────────────────────────────────────────────

export async function registrationOptions(
  db: Database,
  user: { id: string; email: string; name: string },
) {
  const rp = relyingParty()
  const existing = await credentialsFor(db, user.id)

  const options = await generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userID: new TextEncoder().encode(user.id),
    userName: user.email,
    userDisplayName: user.name,
    // The account already has a password; the passkey is an additional way in,
    // never a replacement, so the authenticator is not asked to be one.
    attestationType: 'none',
    // Registering the same authenticator twice would create a second row that
    // behaves identically and confuses the list. The browser refuses instead,
    // with a message naming the device.
    excludeCredentials: existing.map((credential) => ({
      id: credential.credentialId,
      transports: credential.transports as never,
    })),
    authenticatorSelection: {
      // Discoverable so signing in needs no email typed first: the browser
      // offers the accounts it holds for this site and the assertion names the
      // credential itself.
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  })

  await storeChallenge(db, options.challenge, 'register', user.id)
  return options
}

export async function verifyRegistration(
  db: Database,
  user: { id: string },
  response: RegistrationResponseJSON,
  name: string,
) {
  const rp = relyingParty()
  const challenge = response.response.clientDataJSON
    ? JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString()).challenge
    : null
  if (typeof challenge !== 'string') return null

  const claimed = await consumeChallenge(db, challenge, 'register')
  // Bound to the user who asked for it: a challenge minted for one account must
  // not register a credential on another.
  if (!claimed || claimed.userId !== user.id) return null

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.id,
    requireUserVerification: false,
  })

  if (!verification.verified || !verification.registrationInfo) return null
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo

  const [row] = await db
    .insert(schema.webauthnCredentials)
    .values({
      userId: user.id,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      name,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      transports: credential.transports ?? [],
    })
    .returning()

  return row ?? null
}

// ── Authentication ──────────────────────────────────────────────────────────

export async function authenticationOptions(db: Database) {
  const rp = relyingParty()

  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    // Deliberately empty: naming the allowed credentials would require knowing
    // who is signing in, and asking for an email first would turn this endpoint
    // into the account oracle that `/login` and `/password/forgot` both go out
    // of their way not to be.
    allowCredentials: [],
    userVerification: 'preferred',
  })

  await storeChallenge(db, options.challenge, 'authenticate')
  return options
}

export interface AuthenticationOutcome {
  userId: string
  credentialId: string
}

export async function verifyAuthentication(
  db: Database,
  response: AuthenticationResponseJSON,
): Promise<AuthenticationOutcome | null> {
  const rp = relyingParty()

  const challenge = response.response.clientDataJSON
    ? JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString()).challenge
    : null
  if (typeof challenge !== 'string') return null

  const claimed = await consumeChallenge(db, challenge, 'authenticate')
  if (!claimed) return null

  const [credential] = await db
    .select()
    .from(schema.webauthnCredentials)
    .where(eq(schema.webauthnCredentials.credentialId, response.id))
    .limit(1)
  if (!credential) return null

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.id,
    credential: {
      id: credential.credentialId,
      publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64url')),
      counter: credential.counter,
      transports: credential.transports as never,
    },
    requireUserVerification: false,
  })

  if (!verification.verified) return null

  // The counter is the only clone signal WebAuthn offers, and it is a weak one:
  // many authenticators — most notably synced passkeys — report a constant 0,
  // where a strict "must increase" rule would reject every legitimate sign-in.
  // So it is stored and moved forward, and only a *decrease* from a counter
  // that was previously non-zero is treated as suspicious.
  const { newCounter } = verification.authenticationInfo
  if (credential.counter > 0 && newCounter < credential.counter) return null

  await db
    .update(schema.webauthnCredentials)
    .set({ counter: newCounter, lastUsedAt: new Date() })
    .where(eq(schema.webauthnCredentials.id, credential.id))

  return { userId: credential.userId, credentialId: credential.id }
}

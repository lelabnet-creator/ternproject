import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schema } from '@tern/db'
import { createFixture, login, type TestFixture } from '../test/harness.js'
import { relyingParty } from '../services/webauthn.js'

/**
 * What can be tested here, and what cannot.
 *
 * A valid assertion requires a private key held by an authenticator, so these
 * tests do not prove that a real passkey signs anyone in — a browser does that,
 * and `@simplewebauthn/server` has its own suite for the cryptography.
 *
 * What is worth pinning here is everything *around* the signature, because that
 * is where this codebase makes its own decisions: that a challenge is spent
 * once, that one account cannot touch another's credentials, that the sign-in
 * endpoint stays silent about who exists, and that a forged response is refused
 * rather than tolerated.
 */

let fx: TestFixture

beforeAll(async () => {
  fx = await createFixture()
}, 30_000)

afterAll(async () => {
  await fx.cleanup()
})

/**
 * A credential row, written directly — registering one needs an authenticator.
 *
 * The id is base64url because a real one always is, and the difference is not
 * cosmetic: `generateRegistrationOptions` passes stored ids back to the browser
 * in `excludeCredentials` and rejects anything else outright. An earlier version
 * of this helper used a readable string with a space in it, and every call to
 * the registration endpoint answered 500 as soon as the account had one row.
 */
async function giveCredential(userId: string, name: string) {
  const [row] = await fx.app.db
    .insert(schema.webauthnCredentials)
    .values({
      userId,
      credentialId: Buffer.from(`cred-${userId}-${name}`).toString('base64url'),
      publicKey: Buffer.from('not-a-real-key').toString('base64url'),
      name,
    })
    .returning()
  if (!row) throw new Error('failed to insert credential')
  return row
}

describe('the relying party', () => {
  it('is the hostname of the public base URL, and the origin keeps its port', () => {
    // The distinction is not pedantry: the spec has no place for a port in an
    // RP ID, while the origin check does include one. Getting this wrong makes
    // every registration fail in development and nowhere else.
    const rp = relyingParty()
    expect(rp.id).not.toContain(':')
    expect(rp.origin).toContain(rp.id)
  })
})

describe('listing and removing passkeys', () => {
  it('refuses anyone who is not signed in', async () => {
    const response = await fx.app.inject({ method: 'GET', url: '/api/v1/auth/passkeys' })
    expect(response.statusCode).toBe(401)
  })

  it('shows the caller their own passkeys and nobody else’s', async () => {
    await giveCredential(fx.users.admin.id, 'admin laptop')
    await giveCredential(fx.users.member.id, 'member phone')

    const cookie = await login(fx.app, fx.users.admin.email)
    const response = await fx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/passkeys',
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
    const names = response.json().map((row: { name: string }) => row.name)
    expect(names).toContain('admin laptop')
    expect(names).not.toContain('member phone')
  })

  it('will not let one account delete another’s passkey', async () => {
    // The id comes from a list the caller was shown, so without the ownership
    // clause on the delete this would be a way to strip somebody else's key.
    const victim = await giveCredential(fx.users.member.id, 'member key')
    const cookie = await login(fx.app, fx.users.admin.email)

    const response = await fx.app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/passkeys/${victim.id}`,
      headers: { cookie },
    })

    expect(response.statusCode).toBe(404)

    const [still] = await fx.app.db
      .select()
      .from(schema.webauthnCredentials)
      .where(eq(schema.webauthnCredentials.id, victim.id))
    expect(still).toBeDefined()
  })

  it('removes one of the caller’s own', async () => {
    const mine = await giveCredential(fx.users.outsider.id, 'outsider key')
    const cookie = await login(fx.app, fx.users.outsider.email)

    const response = await fx.app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/passkeys/${mine.id}`,
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)

    const rows = await fx.app.db
      .select()
      .from(schema.webauthnCredentials)
      .where(eq(schema.webauthnCredentials.id, mine.id))
    expect(rows).toHaveLength(0)
  })
})

describe('signing in with a passkey', () => {
  it('hands out a challenge without being told who is signing in', async () => {
    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkeys/login/options',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(typeof body.challenge).toBe('string')

    // Empty on purpose. A credential list would be an answer to "does this
    // account exist", which is the question /login and /password/forgot both
    // refuse to answer.
    expect(body.allowCredentials ?? []).toEqual([])

    const [stored] = await fx.app.db
      .select()
      .from(schema.webauthnChallenges)
      .where(eq(schema.webauthnChallenges.challenge, body.challenge))
    expect(stored?.kind).toBe('authenticate')
    expect(stored?.userId).toBeNull()
  })

  it('refuses a response whose challenge was never issued', async () => {
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: 'never-minted', origin: 'http://x' }),
    ).toString('base64url')

    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkeys/login',
      payload: {
        response: {
          id: 'whatever',
          rawId: 'whatever',
          type: 'public-key',
          clientExtensionResults: {},
          response: { clientDataJSON, authenticatorData: '', signature: '' },
        },
      },
    })

    expect(response.statusCode).toBe(401)
  })

  it('spends a challenge on its first use', async () => {
    const options = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkeys/login/options',
    })
    const { challenge } = options.json()

    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge, origin: 'http://x' }),
    ).toString('base64url')

    const attempt = () =>
      fx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/passkeys/login',
        payload: {
          response: {
            id: 'whatever',
            rawId: 'whatever',
            type: 'public-key',
            clientExtensionResults: {},
            response: { clientDataJSON, authenticatorData: '', signature: '' },
          },
        },
      })

    // The signature is nonsense either way, so both attempts are refused. What
    // is being pinned is the row: a replayed assertion must not even reach the
    // verifier, and it cannot once the challenge has been claimed.
    expect((await attempt()).statusCode).toBe(401)

    const rows = await fx.app.db
      .select()
      .from(schema.webauthnChallenges)
      .where(eq(schema.webauthnChallenges.challenge, challenge))
    expect(rows).toHaveLength(0)

    expect((await attempt()).statusCode).toBe(401)
  })
})

describe('registering a passkey', () => {
  it('refuses anyone who is not signed in', async () => {
    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkeys/register/options',
    })
    expect(response.statusCode).toBe(401)
  })

  it('mints a challenge bound to the caller', async () => {
    const cookie = await login(fx.app, fx.users.admin.email)
    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkeys/register/options',
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()

    const [stored] = await fx.app.db
      .select()
      .from(schema.webauthnChallenges)
      .where(eq(schema.webauthnChallenges.challenge, body.challenge))

    expect(stored?.kind).toBe('register')
    // Bound, so a challenge minted for one account cannot register a credential
    // on another.
    expect(stored?.userId).toBe(fx.users.admin.id)
  })

  it('will not accept a sign-in challenge as a registration', async () => {
    // The two kinds authorise different things. Without the check, a challenge
    // handed out to an anonymous caller would be usable to attach a credential.
    const options = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkeys/login/options',
    })
    const { challenge } = options.json()

    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge, origin: 'http://x' }),
    ).toString('base64url')

    const cookie = await login(fx.app, fx.users.admin.email)
    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkeys/register',
      headers: { cookie },
      payload: {
        name: 'forged',
        response: {
          id: 'whatever',
          rawId: 'whatever',
          type: 'public-key',
          clientExtensionResults: {},
          response: { clientDataJSON, attestationObject: '' },
        },
      },
    })

    expect(response.statusCode).toBe(400)
  })
})

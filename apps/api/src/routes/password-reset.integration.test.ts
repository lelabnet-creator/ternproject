import { and, desc, eq, isNull } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schema } from '@tern/db'
import { generateToken, hashToken } from '@tern/shared'
import { PASSWORD_MIN_LENGTH } from '@tern/shared/password'
import { createFixture, login, TEST_PASSWORD, type TestFixture } from '../test/harness.js'

let fx: TestFixture

beforeAll(async () => {
  fx = await createFixture()
}, 30_000)

afterAll(async () => {
  await fx.cleanup()
})

/**
 * Issues a live token directly.
 *
 * The value itself only ever exists in the email, so a test that wanted to
 * redeem the token the endpoint minted would have to read a mailbox. Writing a
 * row with a known value exercises the same redemption path against the same
 * table.
 */
async function issueToken(userId: string, overrides: { expiresAt?: Date; usedAt?: Date } = {}) {
  const token = generateToken(32)
  await fx.app.db.insert(schema.passwordResetTokens).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 30 * 60_000),
    usedAt: overrides.usedAt ?? null,
  })
  return token
}

const forgot = (email: string) =>
  fx.app.inject({ method: 'POST', url: '/api/v1/auth/password/forgot', payload: { email } })

const reset = (token: string, newPassword: string) =>
  fx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/password/reset',
    payload: { token, newPassword },
  })

describe('asking for a reset link', () => {
  it('answers the same for a known and an unknown address', async () => {
    // The sign-in form goes to some length not to reveal which addresses have
    // accounts. This endpoint needs no password at all, so it is the cheaper
    // oracle of the two and has to be just as quiet.
    const known = await forgot(fx.users.admin.email)
    const unknown = await forgot(`ghost-${fx.slug}@test.local`)

    expect(known.statusCode).toBe(202)
    expect(unknown.statusCode).toBe(202)
    expect(unknown.json()).toEqual(known.json())
  })

  it('records a token for an account that exists', async () => {
    await forgot(fx.users.member.email)

    const rows = await fx.app.db
      .select()
      .from(schema.passwordResetTokens)
      .where(eq(schema.passwordResetTokens.userId, fx.users.member.id))

    expect(rows.length).toBeGreaterThan(0)
    // Only the hash is kept: a database dump must not be a set of working links.
    expect(rows.every((row) => row.tokenHash.length === 64)).toBe(true)
  })

  it('invalidates any link still outstanding', async () => {
    const stale = await issueToken(fx.users.visitor.id)
    await forgot(fx.users.visitor.email)

    // Someone asking again is usually someone who thinks the first mail went
    // astray. Leaving both live means a token stolen from that first mail
    // outlives the request to replace it.
    const rejected = await reset(stale, 'a-perfectly-fine-password')
    expect(rejected.statusCode).toBe(400)

    const live = await fx.app.db
      .select()
      .from(schema.passwordResetTokens)
      .where(
        and(
          eq(schema.passwordResetTokens.userId, fx.users.visitor.id),
          isNull(schema.passwordResetTokens.usedAt),
        ),
      )
    expect(live).toHaveLength(1)
  })
})

describe('redeeming a reset link', () => {
  it('sets the password and signs every device out', async () => {
    const session = await login(fx.app, fx.users.outsider.email, TEST_PASSWORD)
    const token = await issueToken(fx.users.outsider.id)
    const newPassword = 'brand-new-password-here'

    const response = await reset(token, newPassword)
    expect(response.statusCode).toBe(200)

    // The old session is gone: a reset is usually a response to losing control
    // of the account, and leaving other devices signed in defeats the point.
    const me = await fx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: session },
    })
    expect(me.statusCode).toBe(401)

    const signIn = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: fx.users.outsider.email, password: newPassword },
    })
    expect(signIn.statusCode).toBe(200)
  })

  it('refuses a token that has already been used', async () => {
    const token = await issueToken(fx.users.admin.id)

    expect((await reset(token, 'first-password-choice')).statusCode).toBe(200)
    expect((await reset(token, 'second-password-choice')).statusCode).toBe(400)
  })

  it('refuses an expired token', async () => {
    const token = await issueToken(fx.users.admin.id, { expiresAt: new Date(Date.now() - 1000) })
    expect((await reset(token, 'a-perfectly-fine-password')).statusCode).toBe(400)
  })

  it('refuses a token that was never issued', async () => {
    expect((await reset(generateToken(32), 'a-perfectly-fine-password')).statusCode).toBe(400)
  })

  it('gives the same message whatever the reason', async () => {
    // Expired, spent, and invented are three different facts about a token, and
    // none of them is owed to whoever is holding a bad one.
    const spent = await issueToken(fx.users.member.id, { usedAt: new Date() })
    const expired = await issueToken(fx.users.member.id, { expiresAt: new Date(Date.now() - 1000) })

    const messages = await Promise.all(
      [spent, expired, generateToken(32)].map(
        async (token) => (await reset(token, 'a-perfectly-fine-password')).json().detail,
      ),
    )

    expect(new Set(messages).size).toBe(1)
  })

  it('rejects a password shorter than the floor, and accepts one exactly at it', async () => {
    // Pinned to the constant and tested either side of it. The previous version
    // passed a five-character password, which is refused by any floor at all —
    // so it proved a floor existed without ever saying where.
    const token = await issueToken(fx.users.admin.id)
    expect((await reset(token, 'x'.repeat(PASSWORD_MIN_LENGTH - 1))).statusCode).toBe(400)

    // And the token survives, so a rejected attempt does not cost the link.
    const [row] = await fx.app.db
      .select()
      .from(schema.passwordResetTokens)
      .where(eq(schema.passwordResetTokens.tokenHash, hashToken(token)))
      .orderBy(desc(schema.passwordResetTokens.createdAt))
      .limit(1)
    expect(row?.usedAt).toBeNull()

    // The same link then works with a password exactly at the floor, which is
    // what makes this a boundary rather than a direction.
    expect((await reset(token, 'x'.repeat(PASSWORD_MIN_LENGTH))).statusCode).toBe(200)
  })
})

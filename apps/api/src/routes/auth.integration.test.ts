import { eq } from 'drizzle-orm'
import { authenticator } from 'otplib'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { schema } from '@tern/db'
import { createFixture, login, TEST_PASSWORD, type TestFixture } from '../test/harness.js'

let fx: TestFixture

beforeAll(async () => {
  fx = await createFixture()
}, 30_000)

afterAll(async () => {
  await fx.cleanup()
})

describe('login', () => {
  it('issues a session for correct credentials', async () => {
    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: fx.users.admin.email, password: TEST_PASSWORD },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().mfaRequired).toBe(false)
    expect(response.cookies.some((c) => c.name === 'tern_session')).toBe(true)
  })

  it('rejects a wrong password and an unknown account identically', async () => {
    // Different responses here turn the login form into an account-enumeration
    // oracle, which is how a leaked password list gets targeted.
    const wrongPassword = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: fx.users.admin.email, password: 'not-the-password' },
    })
    const unknownAccount = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: `ghost-${fx.slug}@test.local`, password: 'not-the-password' },
    })

    expect(wrongPassword.statusCode).toBe(401)
    expect(unknownAccount.statusCode).toBe(401)
    expect(unknownAccount.json().detail).toBe(wrongPassword.json().detail)
  })

  it('sets an httpOnly session cookie', async () => {
    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: fx.users.member.email, password: TEST_PASSWORD },
    })
    const cookie = response.cookies.find((c) => c.name === 'tern_session')
    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.sameSite?.toLowerCase()).toBe('lax')
  })
})

describe('session lifecycle', () => {
  it('rejects /me without a session', async () => {
    const response = await fx.app.inject({ method: 'GET', url: '/api/v1/auth/me' })
    expect(response.statusCode).toBe(401)
  })

  it('returns the caller and their memberships', async () => {
    const cookie = await login(fx.app, fx.users.admin.email)
    const response = await fx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.user.email).toBe(fx.users.admin.email)
    expect(body.memberships).toHaveLength(1)
    expect(body.memberships[0].role).toBe('admin')
  })

  it('invalidates the session on logout', async () => {
    const cookie = await login(fx.app, fx.users.member.email)
    await fx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } })

    const after = await fx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    })
    expect(after.statusCode).toBe(401)
  })

  it('signs every device out when the password changes', async () => {
    // A password change is usually a reaction to suspected compromise. Leaving
    // the attacker's session alive would make it pointless.
    const deviceA = await login(fx.app, fx.users.visitor.email)
    const deviceB = await login(fx.app, fx.users.visitor.email)

    const change = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { cookie: deviceA },
      payload: { currentPassword: TEST_PASSWORD, newPassword: 'a-brand-new-password' },
    })
    expect(change.statusCode).toBe(200)

    const other = await fx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: deviceB },
    })
    expect(other.statusCode).toBe(401)

    // Restore, so the fixture stays usable for any later test in this file.
    const fresh = await login(fx.app, fx.users.visitor.email, 'a-brand-new-password')
    await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { cookie: fresh },
      payload: { currentPassword: 'a-brand-new-password', newPassword: TEST_PASSWORD },
    })
  })
})

describe('rate limiting', () => {
  it('stops repeated login attempts from one address', async () => {
    // The suite runs with the limit raised so it does not trip on itself; this
    // test lowers it back down, because an untested limiter is a limiter that
    // quietly stops working.
    const previous = process.env.AUTH_RATE_LIMIT_MAX
    process.env.AUTH_RATE_LIMIT_MAX = '3'
    vi.resetModules()

    const { buildApp } = await import('../app.js')
    const app = await buildApp()
    await app.ready()

    try {
      const attempt = () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: `ghost-${fx.slug}@test.local`, password: 'guess' },
        })

      const codes: number[] = []
      for (let i = 0; i < 5; i++) codes.push((await attempt()).statusCode)

      expect(codes.slice(0, 3)).toEqual([401, 401, 401])
      expect(codes.at(-1)).toBe(429)
    } finally {
      await app.close()
      process.env.AUTH_RATE_LIMIT_MAX = previous
      vi.resetModules()
    }
  }, 30_000)

  it('does not spend the login budget on reading your own session', async () => {
    // `/me` used to sit under the limiter above, and the two are not the same
    // question: ten login attempts a minute stops a password guesser, ten
    // `/auth/me` a minute stops an operator. The admin asks on every mount, so
    // a few navigations and a reload exhausted the budget and the app — unable
    // to tell "could not ask" from "not signed in" — drew a sign-in form at
    // somebody holding a valid session cookie. The counter is keyed by IP, so
    // one NAT shared it across a whole office.
    const previousAuth = process.env.AUTH_RATE_LIMIT_MAX
    const previousSession = process.env.SESSION_RATE_LIMIT_MAX
    process.env.AUTH_RATE_LIMIT_MAX = '3'
    process.env.SESSION_RATE_LIMIT_MAX = '50'
    vi.resetModules()

    const { buildApp } = await import('../app.js')
    const app = await buildApp()
    await app.ready()

    try {
      // The one login this test is allowed, and it spends one of the three.
      const cookie = await login(app, fx.users.admin.email)

      const codes: number[] = []
      // Well past the login budget, and nothing like a person's pace.
      for (let i = 0; i < 12; i++) {
        codes.push(
          (
            await app.inject({
              method: 'GET',
              url: '/api/v1/auth/me',
              headers: { cookie },
            })
          ).statusCode,
        )
      }

      expect(codes.every((code) => code === 200)).toBe(true)
    } finally {
      await app.close()
      process.env.AUTH_RATE_LIMIT_MAX = previousAuth
      process.env.SESSION_RATE_LIMIT_MAX = previousSession
      vi.resetModules()
    }
  }, 30_000)
})

describe('TOTP enrolment and enforcement', () => {
  it('walks the whole second-factor flow', async () => {
    const cookie = await login(fx.app, fx.users.admin.email)

    // 1. Begin enrolment.
    const setup = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/setup',
      headers: { cookie },
    })
    expect(setup.statusCode).toBe(200)
    const { secret, otpauthUrl } = setup.json()
    expect(otpauthUrl).toContain('otpauth://totp/')

    // 2. MFA must not be active yet — a secret nobody has proven they hold
    //    would lock the account out.
    const [beforeConfirm] = await fx.app.db
      .select({ mfaEnabled: schema.users.mfaEnabled })
      .from(schema.users)
      .where(eq(schema.users.id, fx.users.admin.id))
    expect(beforeConfirm?.mfaEnabled).toBe(false)

    // 3. A wrong code must not enable it.
    const badConfirm = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/setup/confirm',
      headers: { cookie },
      payload: { code: '000000' },
    })
    expect(badConfirm.statusCode).toBe(401)

    // 4. A real code does, and returns the recovery codes once.
    const confirm = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/setup/confirm',
      headers: { cookie },
      payload: { code: authenticator.generate(secret) },
    })
    expect(confirm.statusCode).toBe(200)
    const backupCodes: string[] = confirm.json().backupCodes
    expect(backupCodes).toHaveLength(10)

    // 5. Logging in now stops at the second factor, and reveals nothing about
    //    the account before it is satisfied.
    const relogin = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: fx.users.admin.email, password: TEST_PASSWORD },
    })
    expect(relogin.json().mfaRequired).toBe(true)
    expect(relogin.json().user).toBeNull()

    const pending = `tern_session=${relogin.cookies.find((c) => c.name === 'tern_session')?.value}`

    // 6. The pending session must not reach anything.
    const blocked = await fx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: pending },
    })
    expect(blocked.statusCode).toBe(401)

    // 7. A wrong TOTP code keeps it blocked.
    const wrongCode = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      headers: { cookie: pending },
      payload: { code: '000000' },
    })
    expect(wrongCode.statusCode).toBe(401)

    // 8. The right one unlocks it.
    const verified = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      headers: { cookie: pending },
      payload: { code: authenticator.generate(secret) },
    })
    expect(verified.statusCode).toBe(200)

    const unlocked = await fx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: pending },
    })
    expect(unlocked.statusCode).toBe(200)
    expect(unlocked.json().user.mfaEnabled).toBe(true)

    // 9. A recovery code works once and only once.
    const second = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: fx.users.admin.email, password: TEST_PASSWORD },
    })
    const pending2 = `tern_session=${second.cookies.find((c) => c.name === 'tern_session')?.value}`
    const code = backupCodes[0]!

    const usedOnce = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      headers: { cookie: pending2 },
      payload: { code, backupCode: true },
    })
    expect(usedOnce.statusCode).toBe(200)
    expect(usedOnce.json().backupCodesRemaining).toBe(9)

    const third = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: fx.users.admin.email, password: TEST_PASSWORD },
    })
    const pending3 = `tern_session=${third.cookies.find((c) => c.name === 'tern_session')?.value}`
    const replay = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/verify',
      headers: { cookie: pending3 },
      payload: { code, backupCode: true },
    })
    expect(replay.statusCode).toBe(401)
  }, 30_000)
})

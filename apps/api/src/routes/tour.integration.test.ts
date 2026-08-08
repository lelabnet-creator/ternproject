import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFixture, login, type TestFixture } from '../test/harness.js'

/**
 * Remembering that someone has been shown the tour.
 *
 * On the account, which is the whole point: the ticket asked for the dismissal
 * to survive a change of machine, and a flag in local storage would not.
 */

let fx: TestFixture
let adminCookie: string

beforeAll(async () => {
  fx = await createFixture()
  adminCookie = await login(fx.app, fx.users.admin.email)
}, 30_000)

afterAll(async () => {
  await fx.cleanup()
})

const me = (cookie: string) =>
  fx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })

const setSeen = (cookie: string, seen: boolean) =>
  fx.app.inject({
    method: 'PUT',
    url: '/api/v1/auth/me/tour',
    headers: { cookie },
    payload: { seen },
  })

describe('the tour flag', () => {
  it('starts unset, so a new account is walked through', async () => {
    const body = (await me(adminCookie)).json() as { user: { tourSeenAt: string | null } }
    expect(body.user.tourSeenAt).toBeNull()
  })

  it('records a dismissal and reports it back', async () => {
    expect((await setSeen(adminCookie, true)).statusCode).toBe(200)

    const body = (await me(adminCookie)).json() as { user: { tourSeenAt: string | null } }
    expect(body.user.tourSeenAt).not.toBeNull()
  })

  it('survives a new session — the point of storing it on the account', async () => {
    // A second sign-in stands in for a second machine: nothing about the flag
    // is carried in the cookie.
    const second = await login(fx.app, fx.users.admin.email)
    const body = (await me(second)).json() as { user: { tourSeenAt: string | null } }
    expect(body.user.tourSeenAt).not.toBeNull()
  })

  it('clears when the checkbox asks to see it again', async () => {
    const response = await setSeen(adminCookie, false)
    expect(response.json()).toEqual({ tourSeenAt: null })

    const body = (await me(adminCookie)).json() as { user: { tourSeenAt: string | null } }
    expect(body.user.tourSeenAt).toBeNull()
  })

  it('belongs to one account, not to the instance', async () => {
    await setSeen(adminCookie, true)

    const otherCookie = await login(fx.app, fx.users.member.email)
    const other = (await me(otherCookie)).json() as { user: { tourSeenAt: string | null } }
    expect(other.user.tourSeenAt).toBeNull()
  })

  it('refuses an unauthenticated caller', async () => {
    const response = await fx.app.inject({
      method: 'PUT',
      url: '/api/v1/auth/me/tour',
      payload: { seen: true },
    })
    expect(response.statusCode).toBe(401)
  })
})

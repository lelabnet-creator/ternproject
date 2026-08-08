import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFixture, login, type TestFixture } from '../test/harness.js'

/**
 * Where the admin learns what it just changed.
 *
 * This file exists because of one bug and the class it belongs to. The admin
 * used to read the tenant's own state out of the public summary — a response
 * served `Cache-Control: public, max-age=5, stale-while-revalidate=30`, which
 * is right for a status page under load and wrong as the way an operator finds
 * out whether their save took. Answering the setup wizard and watching it
 * reappear was the visible half; the invisible half was every other setting
 * echoed back through the same object, stale for up to thirty seconds.
 *
 * So the settings endpoint is the authority, and what is pinned here is that it
 * carries the answer at all — the field the wizard reads had no home outside
 * the cached summary until now.
 */

let fx: TestFixture

beforeAll(async () => {
  fx = await createFixture()
}, 30_000)

afterAll(async () => {
  await fx.cleanup()
})

describe('the tenant settings', () => {
  it('report whether setup was answered, and record it when it is', async () => {
    const cookie = await login(fx.app, fx.users.admin.email)
    const url = `/api/v1/${fx.slug}/settings`

    const before = await fx.app.inject({ method: 'GET', url, headers: { cookie } })
    expect(before.statusCode).toBe(200)
    // Present and null, rather than absent. An admin reading `undefined` cannot
    // tell "not answered" from "this build does not send it", and would show
    // the wizard to somebody who finished it months ago.
    expect(before.json()).toHaveProperty('setupCompletedAt', null)

    const patch = await fx.app.inject({
      method: 'PATCH',
      url,
      headers: { cookie },
      payload: { setupCompleted: true },
    })
    expect(patch.statusCode).toBeLessThan(300)

    const after = await fx.app.inject({ method: 'GET', url, headers: { cookie } })
    const completedAt = after.json().setupCompletedAt

    expect(completedAt).toBeTruthy()
    // A timestamp, not a flag: "when was this tenant set up" is a question an
    // operator asks, and `true` cannot answer it.
    expect(Number.isNaN(Date.parse(completedAt))).toBe(false)
  })

  it('is not readable without a session', async () => {
    // The counterpart to moving the read here: the summary it came from is
    // public, and this one must not be.
    const response = await fx.app.inject({ method: 'GET', url: `/api/v1/${fx.slug}/settings` })
    expect(response.statusCode).toBeGreaterThanOrEqual(400)
  })
})

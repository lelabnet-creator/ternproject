import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schema } from '@tern/db'
import { createFixture, login, type TestFixture } from '../test/harness.js'

/**
 * A page anyone may open and nobody may change.
 *
 * Two flags that are meant to travel together: `isDemo` lets a stranger into
 * the admin, `readOnly` makes that safe. Every assertion here is one half of
 * that bargain, and the pair is only defensible while both hold.
 */

let fx: TestFixture
let adminCookie: string

beforeAll(async () => {
  fx = await createFixture()
  adminCookie = await login(fx.app, fx.users.admin.email)
  await fx.app.db
    .update(schema.tenants)
    .set({ isDemo: true, readOnly: true })
    .where(eq(schema.tenants.id, fx.tenantId))
}, 30_000)

afterAll(async () => {
  await fx.cleanup()
})

const get = (path: string, cookie?: string) =>
  fx.app.inject({
    method: 'GET',
    url: `/api/v1/${fx.slug}${path}`,
    ...(cookie ? { headers: { cookie } } : {}),
  })

describe('read-only', () => {
  it('refuses a write from the tenant’s own admin', async () => {
    // The point of putting this on the page rather than in the role: an admin
    // of a read-only tenant is refused too, which is what makes the open demo
    // safe to leave open.
    const response = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/incidents`,
      headers: { cookie: adminCookie },
      payload: { title: 'Nope', body: 'Nope.' },
    })
    expect(response.statusCode).toBe(403)
  })

  it('still lets that admin read', async () => {
    expect((await get('/controls', adminCookie)).statusCode).toBe(200)
  })
})

describe('what a stranger may see', () => {
  it('opens the admin without a session', async () => {
    // Anonymous, no cookie at all. This is the demo.
    expect((await get('/controls')).statusCode).toBe(200)
    expect((await get('/incidents')).statusCode).toBe(200)
    expect((await get('/maintenances')).statusCode).toBe(200)
  })

  it.each([
    ['/settings', 'the SMTP host and user'],
    ['/logs', 'visitor IP addresses'],
    ['/notifications/webhooks', 'subscriber endpoints'],
    ['/agents', 'the fleet'],
  ])('refuses %s — %s', async (path) => {
    // An allowlist, so a permission added later is refused until somebody
    // classifies it. A demo that leaks is not a demo.
    expect((await get(path)).statusCode).toBe(403)
  })
})

describe('an ordinary page', () => {
  it('is unaffected by either flag', async () => {
    const other = await createFixture()
    try {
      const otherAdmin = await login(other.app, other.users.admin.email)
      const response = await other.app.inject({
        method: 'POST',
        url: `/api/v1/${other.slug}/incidents`,
        headers: { cookie: otherAdmin },
        payload: { title: 'Fine', body: 'Fine.' },
      })
      expect(response.statusCode).toBe(201)
      // And a stranger gets nothing there.
      expect(
        (await other.app.inject({ method: 'GET', url: `/api/v1/${other.slug}/controls` }))
          .statusCode,
      ).toBe(401)
    } finally {
      await other.cleanup()
    }
  })
})

describe('what the public page of a demo shows', () => {
  it('keeps internal components off it, even though the demo admin lists them', async () => {
    // The demo visitor holds `status:read:all` so the admin screens they are
    // invited to walk through have something in them. On the public summary
    // that would show a component marked internal to anyone — a demo
    // demonstrating the opposite of the feature it exists to show.
    const summary = (
      await fx.app.inject({ method: 'GET', url: `/api/v1/public/${fx.slug}/summary.json` })
    ).json() as { components: { id: string }[] }

    const ids = summary.components.map((c) => c.id)
    expect(ids).toContain(fx.controls.publicId)
    expect(ids).not.toContain(fx.controls.privateId)

    // And the admin list, reached without a session, still has both.
    const controls = (await get('/controls')).json() as { id: string }[]
    expect(controls.map((c) => c.id)).toContain(fx.controls.privateId)
  })
})

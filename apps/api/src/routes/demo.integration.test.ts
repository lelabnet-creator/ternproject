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

  it('refuses the subscriber endpoints outright', async () => {
    // An allowlist, so a permission added later is refused until somebody
    // classifies it. A demo that leaks is not a demo.
    expect((await get('/notifications/webhooks')).statusCode).toBe(403)
  })

  it('shows the settings screen without the addresses on it', async () => {
    // Withholding the whole screen protected nothing and hid a feature. The
    // hostnames are what must not travel, so those are what is replaced.
    const response = await get('/settings')
    expect(response.statusCode).toBe(200)

    const body = response.json() as {
      instanceSmtp: { host: string }
      smtp: { host: string; user: string | null } | null
    }
    expect(body.instanceSmtp.host).toBe('redacted.example')
    if (body.smtp) {
      expect(body.smtp.host).toBe('redacted.example')
      expect(body.smtp.user).toBeNull()
    }
  })

  it('shows the audit trail without the people in it', async () => {
    const response = await get('/logs')
    expect(response.statusCode).toBe(200)

    const body = response.json() as { entries: { ip: string | null; actor: string }[] }
    // A public demo's trail accumulates the addresses of the strangers who came
    // to look at it, and the email of whoever administers the instance.
    for (const entry of body.entries) {
      expect(entry.ip).toBeNull()
      expect(entry.actor).not.toContain('@')
    }
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

describe('the fleet', () => {
  it('is readable, because a demo with no agents shows nothing at all', async () => {
    // Reading the list used to be gated behind `agent:manage` — the permission
    // that also pairs and revokes — so this screen met an error where its whole
    // content is a list. Every install has at least its own local agent.
    expect((await get('/agents')).statusCode).toBe(200)
  })

  it('still refuses to pair or revoke', async () => {
    const pair = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/pairing-codes`,
      payload: {},
    })
    expect(pair.statusCode).toBe(403)
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

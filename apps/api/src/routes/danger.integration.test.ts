import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { schema } from '@tern/db'
import { createFixture, login, type TestFixture } from '../test/harness.js'

let fx: TestFixture
let cookie: string

beforeAll(async () => {
  fx = await createFixture()
  cookie = await login(fx.app, fx.users.admin.email)
}, 30_000)

afterAll(async () => {
  await fx.cleanup()
})

describe('emptying a tenant', () => {
  it('refuses without the typed confirmation, and deletes nothing', async () => {
    // The gate is on the server, not only in the browser: a confirmation that
    // exists only in the UI is one a stray curl skips.
    const before = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/${fx.slug}/danger/summary`,
      headers: { cookie },
    })
    expect(before.json().controls).toBeGreaterThan(0)

    const response = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/danger/empty`,
      headers: { cookie },
      payload: { confirm: 'not-the-slug', understood: true },
    })
    expect(response.statusCode).toBe(400)

    const after = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/${fx.slug}/danger/summary`,
      headers: { cookie },
    })
    expect(after.json().controls).toBe(before.json().controls)
  })

  it('refuses when the acknowledgement is missing', async () => {
    const response = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/danger/empty`,
      headers: { cookie },
      payload: { confirm: fx.slug },
    })
    expect(response.statusCode).toBe(400)
  })

  it('refuses a member, who can communicate but not erase', async () => {
    const memberCookie = await login(fx.app, fx.users.member.email)
    const response = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/danger/empty`,
      headers: { cookie: memberCookie },
      payload: { confirm: fx.slug, understood: true },
    })
    expect(response.statusCode).toBe(403)
  })

  it('empties what the tenant monitors, and keeps what the tenant is', async () => {
    await fx.app.inject({
      method: 'POST',
      url: '/api/v1/ingest',
      headers: { authorization: `Bearer ${await issueKey()}` },
      payload: { controlKey: 'public-api', status: 'operational', latencyMs: 12 },
    })

    const response = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/danger/empty`,
      headers: { cookie },
      payload: { confirm: fx.slug, understood: true },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().emptied).toBe(true)

    const after = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/${fx.slug}/danger/summary`,
      headers: { cookie },
    })
    const counts = after.json()
    expect(counts.controls).toBe(0)
    expect(counts.checks).toBe(0)
    expect(counts.agents).toBe(0)

    // Emptying is not deleting: the tenant, its settings and its members
    // survive, or this would be a different operation wearing a gentler name.
    const [tenant] = await fx.app.db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, fx.tenantId))
    expect(tenant).toBeDefined()

    const members = await fx.app.db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.tenantId, fx.tenantId))
    expect(members.length).toBeGreaterThan(0)

    // And the trail survives, carrying the record of the wipe — the one entry
    // somebody will certainly go looking for afterwards.
    const trail = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/${fx.slug}/logs?action=tenant.emptied`,
      headers: { cookie },
    })
    expect(trail.json().entries.length).toBeGreaterThan(0)
  })

  async function issueKey(): Promise<string> {
    const { issueApiKey } = await import('../services/apikeys.js')
    const issued = await issueApiKey(fx.app, {
      tenantId: fx.tenantId,
      name: 'wipe-test',
      scopes: ['ingest'],
    })
    return issued.key
  }
})

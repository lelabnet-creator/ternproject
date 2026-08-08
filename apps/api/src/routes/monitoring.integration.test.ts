import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schema } from '@tern/db'
import { createFixture, login, type TestFixture } from '../test/harness.js'

/**
 * Who may read which half of the Monitoring tab.
 *
 * The interesting behaviour is not the arithmetic — that is covered without a
 * server in `http-metrics.test.ts` — but the partition: a tenant admin sees
 * their own agents and nothing about the shared machinery, and the request
 * counters actually move when requests are served.
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

const read = (cookie: string) =>
  fx.app.inject({
    method: 'GET',
    url: `/api/v1/${fx.slug}/monitoring`,
    headers: { cookie },
  })

describe('who may read it', () => {
  it('refuses a visitor', async () => {
    const visitorCookie = await login(fx.app, fx.users.visitor.email)
    expect((await read(visitorCookie)).statusCode).toBe(403)
  })

  it('gives a tenant admin their agents but not the instance figures', async () => {
    const response = await read(adminCookie)
    expect(response.statusCode).toBe(200)

    const body = response.json() as { platform: unknown; agents: unknown[]; instance: unknown }
    // The partition the ticket asked for: on a multi-tenant install, instance
    // figures describe machinery shared with other customers.
    expect(body.platform).toBeNull()
    expect(Array.isArray(body.agents)).toBe(true)
    expect(body.instance).toMatchObject({ name: expect.any(String) })
  })

  it('gives a platform admin the instance figures', async () => {
    // Promote this fixture's tenant to the system tenant for the length of the
    // assertion; the guard is membership of a system tenant with the admin role.
    await fx.app.db
      .update(schema.tenants)
      .set({ isSystem: true })
      .where(eq(schema.tenants.id, fx.tenantId))

    try {
      const body = (await read(adminCookie)).json() as {
        platform: { byClass: Record<string, unknown>; limits: Record<string, number> } | null
      }
      expect(body.platform).not.toBeNull()
      expect(Object.keys(body.platform!.byClass).sort()).toEqual([
        'admin',
        'agent',
        'ingest',
        'public',
      ])
      expect(body.platform!.limits.dbPoolMax).toBeGreaterThan(0)
    } finally {
      await fx.app.db
        .update(schema.tenants)
        .set({ isSystem: false })
        .where(eq(schema.tenants.id, fx.tenantId))
    }
  })
})

describe('the counters', () => {
  it('counts served requests by class', async () => {
    await fx.app.db
      .update(schema.tenants)
      .set({ isSystem: true })
      .where(eq(schema.tenants.id, fx.tenantId))

    try {
      const before = (await read(adminCookie)).json() as {
        platform: { byClass: { public: { requests: number } } }
      }

      // A public route, so it lands in a different class than this admin read.
      await fx.app.inject({ method: 'GET', url: `/api/v1/public/${fx.slug}/summary.json` })

      const after = (await read(adminCookie)).json() as {
        platform: { byClass: { public: { requests: number } } }
      }
      expect(after.platform.byClass.public.requests).toBeGreaterThan(
        before.platform.byClass.public.requests,
      )
    } finally {
      await fx.app.db
        .update(schema.tenants)
        .set({ isSystem: false })
        .where(eq(schema.tenants.id, fx.tenantId))
    }
  })

  it('leaves the in-flight gauge at rest between requests', async () => {
    await fx.app.db
      .update(schema.tenants)
      .set({ isSystem: true })
      .where(eq(schema.tenants.id, fx.tenantId))

    try {
      const body = (await read(adminCookie)).json() as { platform: { inFlight: number } }
      // One request in flight: the one asking. A gauge that only ever climbs is
      // the failure mode this guards.
      expect(body.platform.inFlight).toBeLessThanOrEqual(1)
    } finally {
      await fx.app.db
        .update(schema.tenants)
        .set({ isSystem: false })
        .where(eq(schema.tenants.id, fx.tenantId))
    }
  })
})

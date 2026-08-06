import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { schema } from '@tern/db'
import { createFixture, login, type TestFixture } from '../test/harness.js'

let fx: TestFixture
let adminCookie: string

beforeAll(async () => {
  fx = await createFixture()
  adminCookie = await login(fx.app, fx.users.admin.email)
}, 30_000)

afterAll(async () => {
  await fx.cleanup()
})

describe('platform supervision', () => {
  it('is invisible to an ordinary tenant admin', async () => {
    // 404 rather than 403: probing this path should not reveal that a platform
    // surface exists at all.
    for (const path of [
      '/api/v1/system/overview',
      '/api/v1/system/health',
      '/api/v1/system/load',
    ]) {
      const response = await fx.app.inject({
        method: 'GET',
        url: path,
        headers: { cookie: adminCookie },
      })
      expect(response.statusCode, path).toBe(404)
    }
  })

  it('refuses an anonymous caller outright', async () => {
    const response = await fx.app.inject({ method: 'GET', url: '/api/v1/system/overview' })
    expect(response.statusCode).toBe(401)
  })

  it('reports load per tenant once the tenant is flagged as the system one', async () => {
    // The flag, not a magic slug: a customer signing up as "system" must not
    // inherit the platform by typing.
    await fx.app.db
      .update(schema.tenants)
      .set({ isSystem: true })
      .where(eq(schema.tenants.id, fx.tenantId))

    try {
      const response = await fx.app.inject({
        method: 'GET',
        url: '/api/v1/system/overview',
        headers: { cookie: adminCookie },
      })
      expect(response.statusCode).toBe(200)

      const body = response.json()
      expect(body.instance.tenants).toBeGreaterThan(0)
      expect(body.tenants.some((t: { id: string }) => t.id === fx.tenantId)).toBe(true)

      // Supervision, not administration: nothing here carries a tenant's own
      // data, and a shape test is the cheapest guard against that drifting.
      const [tenant] = body.tenants
      expect(Object.keys(tenant).sort()).toEqual(
        [
          'agents',
          'controls',
          'id',
          'isSystem',
          'lastPointAt',
          'name',
          'pointsLastHour',
          'pointsPerMinute',
          'retentionDays',
          'retentionMode',
          'slug',
        ].sort(),
      )
    } finally {
      await fx.app.db
        .update(schema.tenants)
        .set({ isSystem: false })
        .where(eq(schema.tenants.id, fx.tenantId))
    }
  })

  it('answers the health checks without a 500 when something is wrong', async () => {
    // The one page that must not itself be the broken thing.
    await fx.app.db
      .update(schema.tenants)
      .set({ isSystem: true })
      .where(eq(schema.tenants.id, fx.tenantId))

    try {
      const response = await fx.app.inject({
        method: 'GET',
        url: '/api/v1/system/health',
        headers: { cookie: adminCookie },
      })
      expect(response.statusCode).toBe(200)

      const ids = response.json().checks.map((c: { id: string }) => c.id)
      expect(ids).toEqual(
        expect.arrayContaining(['database', 'aggregates', 'notifications', 'mail', 'agents']),
      )
      for (const check of response.json().checks) {
        expect(['ok', 'warn', 'fail']).toContain(check.state)
        expect(check.detail.length, check.id).toBeGreaterThan(0)
      }
    } finally {
      await fx.app.db
        .update(schema.tenants)
        .set({ isSystem: false })
        .where(eq(schema.tenants.id, fx.tenantId))
    }
  })
})

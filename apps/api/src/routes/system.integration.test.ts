import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { schema } from '@tern/db'
import { config } from '../config.js'
import { resetReleaseCache } from '../services/release.js'
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
      '/api/v1/system/release',
      '/api/v1/system/release/update',
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

describe('release notice', () => {
  const stampedVersion = config.TERN_VERSION

  /** Runs `body` with this instance flagged as the platform's own. */
  async function asPlatformAdmin<T>(body: () => Promise<T>): Promise<T> {
    await fx.app.db
      .update(schema.tenants)
      .set({ isSystem: true })
      .where(eq(schema.tenants.id, fx.tenantId))
    try {
      return await body()
    } finally {
      await fx.app.db
        .update(schema.tenants)
        .set({ isSystem: false })
        .where(eq(schema.tenants.id, fx.tenantId))
    }
  }

  const ask = () =>
    fx.app.inject({
      method: 'GET',
      url: '/api/v1/system/release',
      headers: { cookie: adminCookie },
    })

  afterEach(() => {
    config.TERN_VERSION = stampedVersion
    vi.unstubAllGlobals()
    resetReleaseCache()
  })

  it('says it does not know rather than inventing a version for an unstamped build', async () => {
    config.TERN_VERSION = ''
    // No network stub on purpose: an unstamped build has nothing to compare, so
    // it must not reach for a registry at all. A real fetch here would hang the
    // suite, which is the assertion.
    resetReleaseCache()

    const body = await asPlatformAdmin(async () => {
      const response = await ask()
      expect(response.statusCode).toBe(200)
      return response.json()
    })

    expect(body.state).toBe('unknown')
    expect(body.current).toBeNull()
    expect(body.latest).toBeNull()
    expect(body.detail.length).toBeGreaterThan(0)
  })

  it('reports the newest published release when this build is behind it', async () => {
    config.TERN_VERSION = 'v0.1.0'
    stubRegistry(['latest', '0.1', '0.1.0', '0.1.9', '0.1.10', '0.2.0-rc.1'])
    resetReleaseCache()

    const body = await asPlatformAdmin(async () => (await ask()).json())

    expect(body.state).toBe('update')
    expect(body.current).toBe('0.1.0')
    // The release candidate is published and newer, and deliberately not offered.
    expect(body.latest).toBe('0.1.10')
    expect(body.detail).toContain('0.1.10')
  })

  it('stays quiet when this build is the newest one published', async () => {
    config.TERN_VERSION = 'v0.1.10'
    stubRegistry(['latest', '0.1.9', '0.1.10'])
    resetReleaseCache()

    const body = await asPlatformAdmin(async () => (await ask()).json())

    expect(body.state).toBe('current')
    expect(body.latest).toBe('0.1.10')
  })

  it('says the registry was unreachable instead of claiming the instance is up to date', async () => {
    // The failure this exists to prevent: an unreachable registry reading as
    // "no newer release", which is the reassuring answer and the wrong one.
    config.TERN_VERSION = 'v0.1.0'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND ghcr.io')
      }),
    )
    resetReleaseCache()

    const body = await asPlatformAdmin(async () => (await ask()).json())

    expect(body.state).toBe('unknown')
    expect(body.detail).toContain('ENOTFOUND')
  })

  it('reads the registry once for several readers', async () => {
    config.TERN_VERSION = 'v0.1.0'
    const fetched = stubRegistry(['0.1.0', '0.2.0'])
    resetReleaseCache()

    await asPlatformAdmin(async () => {
      const bodies = await Promise.all([ask(), ask(), ask()])
      for (const response of bodies) expect(response.json().latest).toBe('0.2.0')
    })

    // One token and one tag list, however many admins had the screen open.
    expect(fetched).toHaveBeenCalledTimes(2)
  })
})

describe('applying an update', () => {
  const stampedVersion = config.TERN_VERSION
  const originalDataDir = config.TERN_DATA_DIR
  let dataDir: string

  /** Runs `body` with this instance flagged as the platform's own. */
  async function asPlatformAdmin<T>(body: () => Promise<T>): Promise<T> {
    await fx.app.db
      .update(schema.tenants)
      .set({ isSystem: true })
      .where(eq(schema.tenants.id, fx.tenantId))
    try {
      return await body()
    } finally {
      await fx.app.db
        .update(schema.tenants)
        .set({ isSystem: false })
        .where(eq(schema.tenants.id, fx.tenantId))
    }
  }

  const post = () =>
    fx.app.inject({
      method: 'POST',
      url: '/api/v1/system/release/update',
      headers: { cookie: adminCookie },
    })

  const get = () =>
    fx.app.inject({
      method: 'GET',
      url: '/api/v1/system/release/update',
      headers: { cookie: adminCookie },
    })

  /** A live updater, as far as the API can tell. */
  const heartbeat = () =>
    writeFileSync(
      join(dataDir, 'updater.json'),
      JSON.stringify({ seenAt: new Date().toISOString() }),
    )

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'tern-route-update-'))
    config.TERN_DATA_DIR = dataDir
    config.TERN_VERSION = 'v0.1.0'
    stubRegistry(['0.1.0', '0.1.7'])
    resetReleaseCache()
  })

  afterEach(() => {
    config.TERN_DATA_DIR = originalDataDir
    config.TERN_VERSION = stampedVersion
    vi.unstubAllGlobals()
    resetReleaseCache()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('reports that nothing can be applied when no updater is deployed', async () => {
    const body = await asPlatformAdmin(async () => (await get()).json())
    expect(body.state).toBe('unavailable')
    // The steps are still listed. A screen that has to invent them cannot show
    // what an upgrade would involve before one is running.
    expect(body.steps.map((step: { id: string }) => step.id)).toEqual(['pull', 'verify', 'restart'])
  })

  it('refuses to apply anything with no updater to apply it', async () => {
    const response = await asPlatformAdmin(post)
    // 412, not 500: the instance is fine, the precondition is not met.
    expect(response.statusCode).toBe(412)
  })

  it('writes a request the shell can read, and records who asked', async () => {
    heartbeat()

    const response = await asPlatformAdmin(post)
    expect(response.statusCode).toBe(202)
    expect(response.json().target).toBe('0.1.7')

    const written = readFileSync(join(dataDir, 'update.request'), 'utf8')
    expect(written).toContain('target=0.1.7')
    expect(written).toContain('image=ghcr.io/lelabnet-creator/ternproject')

    const [entry] = await fx.app.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'system.update_requested'))
      .limit(1)
    expect(entry?.meta).toMatchObject({ from: '0.1.0', to: '0.1.7' })
  })

  it('refuses when this instance already runs the newest release', async () => {
    config.TERN_VERSION = 'v0.1.7'
    resetReleaseCache()
    heartbeat()

    const response = await asPlatformAdmin(post)
    expect(response.statusCode).toBe(409)
  })

  it('refuses a second request while one is running', async () => {
    heartbeat()
    writeFileSync(
      join(dataDir, 'update.status.json'),
      JSON.stringify({ id: 'abc', state: 'running', step: 'pull', target: '0.1.7' }),
    )

    const response = await asPlatformAdmin(post)
    expect(response.statusCode).toBe(409)
  })
})

/** A registry answering an anonymous pull token and one page of tags. */
function stubRegistry(tags: string[]) {
  const fetched = vi.fn(async (url: string) =>
    url.includes('/token?')
      ? new Response(JSON.stringify({ token: 'anonymous' }), { status: 200 })
      : new Response(JSON.stringify({ tags }), { status: 200 }),
  )
  vi.stubGlobal('fetch', fetched)
  return fetched
}

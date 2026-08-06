import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { schema } from '@tern/db'
import { hashToken, normalisePin } from '@tern/shared'
import { createFixture, login, type TestFixture } from '../test/harness.js'

let fx: TestFixture

beforeAll(async () => {
  fx = await createFixture()
}, 30_000)

afterAll(async () => {
  await fx.cleanup()
})

async function createPin(
  cookie: string,
  body: Record<string, unknown> = {},
): Promise<{ pin: string; statusCode: number; pairCommand?: string }> {
  const response = await fx.app.inject({
    method: 'POST',
    url: `/api/v1/${fx.slug}/pairing-codes`,
    headers: { cookie },
    payload: body,
  })
  return {
    statusCode: response.statusCode,
    pin: response.statusCode === 200 ? response.json().pin : '',
    pairCommand: response.statusCode === 200 ? response.json().pairCommand : undefined,
  }
}

const redeem = (code: string, extra: Record<string, unknown> = {}) =>
  fx.app.inject({
    method: 'POST',
    url: '/api/v1/pair',
    payload: { code, hostname: 'srv-db-01', os: 'linux', arch: 'x86_64', ...extra },
  })

describe('creating a pairing code', () => {
  it('requires admin', async () => {
    const memberCookie = await login(fx.app, fx.users.member.email)
    expect((await createPin(memberCookie)).statusCode).toBe(403)

    const visitorCookie = await login(fx.app, fx.users.visitor.email)
    expect((await createPin(visitorCookie)).statusCode).toBe(403)
  })

  it('refuses an anonymous caller', async () => {
    const response = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/pairing-codes`,
      payload: {},
    })
    expect(response.statusCode).toBe(401)
  })

  it('returns a readable PIN and a ready-to-paste command', async () => {
    const cookie = await login(fx.app, fx.users.admin.email)
    const { pin, pairCommand } = await createPin(cookie)

    // Crockford base32 without I, L, O or U: no character pair a human can
    // confuse reading it off a screen or dictating it over the phone.
    expect(pin).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(pairCommand).toContain(pin)
    expect(pairCommand).toContain('tern-agent pair')
  })

  it('stores only the hash of the PIN', async () => {
    const cookie = await login(fx.app, fx.users.admin.email)
    const { pin } = await createPin(cookie)

    const [row] = await fx.app.db
      .select()
      .from(schema.pairingCodes)
      .where(eq(schema.pairingCodes.codeHash, hashToken(normalisePin(pin))))
    expect(row).toBeDefined()
    expect(JSON.stringify(row)).not.toContain(pin.replace('-', ''))
  })
})

describe('redeeming', () => {
  it('exchanges a PIN for an ingest key and registers the agent', async () => {
    const cookie = await login(fx.app, fx.users.admin.email)
    const { pin } = await createPin(cookie)

    const response = await redeem(pin)
    expect(response.statusCode).toBe(200)

    const body = response.json()
    expect(body.apiKey).toMatch(/^tern_/)
    expect(body.agentName).toBe('srv-db-01')
    expect(body.tenantSlug).toBe(fx.slug)

    // The issued key must actually work, and only for ingestion.
    const ingest = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/heartbeat/public-api',
      headers: { authorization: `Bearer ${body.apiKey}` },
    })
    expect(ingest.statusCode).toBe(200)
  })

  it('accepts the PIN with or without its separator, in any case', async () => {
    const cookie = await login(fx.app, fx.users.admin.email)
    const { pin } = await createPin(cookie)

    const response = await redeem(pin.replace('-', '').toLowerCase())
    expect(response.statusCode).toBe(200)
  })

  it('refuses a second use of a single-use code', async () => {
    const cookie = await login(fx.app, fx.users.admin.email)
    const { pin } = await createPin(cookie)

    expect((await redeem(pin)).statusCode).toBe(200)
    expect((await redeem(pin)).statusCode).toBe(401)
  })

  it('allows exactly maxUses redemptions and no more', async () => {
    const cookie = await login(fx.app, fx.users.admin.email)
    const { pin } = await createPin(cookie, { maxUses: 3 })

    const codes = [
      (await redeem(pin)).statusCode,
      (await redeem(pin)).statusCode,
      (await redeem(pin)).statusCode,
      (await redeem(pin)).statusCode,
    ]
    expect(codes).toEqual([200, 200, 200, 401])
  })

  it('refuses an expired code', async () => {
    const cookie = await login(fx.app, fx.users.admin.email)
    const { pin } = await createPin(cookie)

    await fx.app.db
      .update(schema.pairingCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.pairingCodes.codeHash, hashToken(normalisePin(pin))))

    expect((await redeem(pin)).statusCode).toBe(401)
  })

  it('refuses a revoked code', async () => {
    const cookie = await login(fx.app, fx.users.admin.email)
    const { pin } = await createPin(cookie)

    await fx.app.db
      .update(schema.pairingCodes)
      .set({ revokedAt: new Date() })
      .where(eq(schema.pairingCodes.codeHash, hashToken(normalisePin(pin))))

    expect((await redeem(pin)).statusCode).toBe(401)
  })

  it('answers identically for wrong, expired and used-up codes', async () => {
    // Distinguishing them would tell a guesser which codes exist.
    const cookie = await login(fx.app, fx.users.admin.email)
    const { pin } = await createPin(cookie)
    await redeem(pin)

    const wrong = await redeem('ZZZZ-ZZZZ')
    const usedUp = await redeem(pin)

    expect(wrong.statusCode).toBe(usedUp.statusCode)
    expect(wrong.json().message).toBe(usedUp.json().message)
  })

  it('grants ingest only — never read or management', async () => {
    const cookie = await login(fx.app, fx.users.admin.email)
    const { pin } = await createPin(cookie)
    const { apiKey } = (await redeem(pin)).json()

    const [key] = await fx.app.db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.keyHash, hashToken(apiKey)))

    expect(key?.scopes).toEqual(['ingest'])

    // A pairing PIN must not become a way into the admin surface.
    const managed = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/${fx.slug}/agents`,
      headers: { authorization: `Bearer ${apiKey}` },
    })
    expect(managed.statusCode).toBe(401)
  })

  it('carries the code scope onto the issued key', async () => {
    const cookie = await login(fx.app, fx.users.admin.email)
    const { pin } = await createPin(cookie, {
      scopeControlIds: [fx.controls.publicId],
      autoRegister: false,
    })
    const { apiKey } = (await redeem(pin)).json()

    const allowed = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/heartbeat/public-api',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    expect(allowed.statusCode).toBe(200)

    const denied = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/heartbeat/internal-job',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    expect(denied.statusCode).toBe(404)
  })
})

describe('brute-force resistance', () => {
  it('rate-limits redemption attempts from one address', async () => {
    // A PIN is only ~40 bits, which is enough solely because guessing is this
    // slow. The suite runs with the limit raised so it does not trip on itself,
    // so the limiter is verified here with a realistic value.
    const previous = process.env.PAIR_RATE_LIMIT_MAX
    process.env.PAIR_RATE_LIMIT_MAX = '3'
    vi.resetModules()

    const { buildApp } = await import('../app.js')
    const app = await buildApp()
    await app.ready()

    try {
      const codes: number[] = []
      for (let i = 0; i < 5; i++) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/pair',
          payload: { code: 'ZZZZ-ZZZZ' },
        })
        codes.push(response.statusCode)
      }
      expect(codes.slice(0, 3)).toEqual([401, 401, 401])
      expect(codes.at(-1)).toBe(429)
    } finally {
      await app.close()
      process.env.PAIR_RATE_LIMIT_MAX = previous
      vi.resetModules()
    }
  }, 30_000)
})

describe('revocation', () => {
  it('kills the agent key immediately', async () => {
    const cookie = await login(fx.app, fx.users.admin.email)
    const { pin } = await createPin(cookie)
    const { apiKey, agentId } = (await redeem(pin)).json()

    const before = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/heartbeat/public-api',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    expect(before.statusCode).toBe(200)

    const revoke = await fx.app.inject({
      method: 'DELETE',
      url: `/api/v1/${fx.slug}/agents/${agentId}`,
      headers: { cookie },
    })
    expect(revoke.statusCode).toBe(200)

    // Revoking the record but leaving a working credential behind would be a
    // revocation in name only.
    const after = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/heartbeat/public-api',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    expect(after.statusCode).toBe(401)
  })

  it('refuses to revoke an agent belonging to another tenant', async () => {
    const other = await createFixture()
    try {
      const otherCookie = await login(other.app, other.users.admin.email)
      const created = await other.app.inject({
        method: 'POST',
        url: `/api/v1/${other.slug}/pairing-codes`,
        headers: { cookie: otherCookie },
        payload: {},
      })
      const otherPin = created.json().pin
      const paired = await other.app.inject({
        method: 'POST',
        url: '/api/v1/pair',
        payload: { code: otherPin, hostname: 'their-host' },
      })
      const foreignAgentId = paired.json().agentId

      const cookie = await login(fx.app, fx.users.admin.email)
      const response = await fx.app.inject({
        method: 'DELETE',
        url: `/api/v1/${fx.slug}/agents/${foreignAgentId}`,
        headers: { cookie },
      })
      expect(response.statusCode).toBe(404)
    } finally {
      await other.cleanup()
    }
  }, 30_000)
})

describe('jobs handed over at pairing', () => {
  let adminCookie: string

  beforeAll(async () => {
    adminCookie = await login(fx.app, fx.users.admin.email)
  }, 30_000)

  it('gives a paired agent the probes it is meant to run', async () => {
    // The point of the feature: a paired agent is a configured agent. Without
    // this the probe list lives on the monitored host and drifts from the
    // server's idea of what is monitored.
    await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/controls`,
      headers: { cookie: adminCookie },
      payload: {
        key: `probe-job-${Date.now()}`,
        name: 'Probed thing',
        kind: 'http',
        config: { url: 'https://example.com/health', assertions: [] },
        downThresholdMs: 4000,
      },
    })

    const code = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/pairing-codes`,
      headers: { cookie: adminCookie },
      payload: {},
    })

    const paired = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code: code.json().pin, hostname: 'jobs-test' },
    })
    expect(paired.statusCode).toBe(200)

    const jobs = paired.json().jobs as {
      controlKey: string
      probe: Record<string, unknown>
      assertions: unknown[]
      payloadShape: string
    }[]

    // Which probes this agent gets depends on the assignment — with a fleet,
    // one agent owns each control. What must hold for whatever it does get is
    // the shape.
    for (const job of jobs) {
      // snake_case on the way out: the agent reads the same shape from JSON and
      // from the TOML it writes, so there is only one spelling to get wrong.
      expect(
        Object.keys(job.probe).every((k) => !/[A-Z]/.test(k)),
        job.controlKey,
      ).toBe(true)
      // A probe with no assertions of its own calls a 500 healthy, so the
      // control's thresholds stand in.
      expect(job.assertions.length, job.controlKey).toBeGreaterThan(0)
      expect(['status', 'value']).toContain(job.payloadShape)
      // A push control has nothing for an agent to run.
      expect(job.probe.type).not.toBe('push')
    }
  })

  it('lets a running agent re-read its assignment with its ingest key', async () => {
    const code = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/pairing-codes`,
      headers: { cookie: adminCookie },
      payload: {},
    })
    const paired = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code: code.json().pin, hostname: 'refresh-test' },
    })

    const refreshed = await fx.app.inject({
      method: 'GET',
      url: '/api/v1/agent/jobs',
      headers: { authorization: `Bearer ${paired.json().apiKey}` },
    })
    expect(refreshed.statusCode).toBe(200)
    expect(refreshed.json().tenantSlug).toBe(fx.slug)
    expect(refreshed.json().jobs).toEqual(paired.json().jobs)
  })

  it('refuses to hand out an assignment without a key', async () => {
    const response = await fx.app.inject({ method: 'GET', url: '/api/v1/agent/jobs' })
    expect(response.statusCode).toBe(401)
  })
})

describe('who runs a probe', () => {
  let adminCookie2: string

  beforeAll(async () => {
    adminCookie2 = await login(fx.app, fx.users.admin.email)
  }, 30_000)

  const pairAgent = async (hostname: string) => {
    const code = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/pairing-codes`,
      headers: { cookie: adminCookie2 },
      payload: {},
    })
    const paired = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      payload: { code: code.json().pin, hostname },
    })
    return paired.json() as { apiKey: string; agentId: string; jobs: unknown[] }
  }

  it('gives a probe to exactly one agent, not to every agent that could run it', async () => {
    // The defect this fixes: an agent's key covers every control by default, so
    // every paired agent ran every probe — eleven agents, eleven identical
    // requests a minute at the same URL.
    const created = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/controls`,
      headers: { cookie: adminCookie2 },
      payload: {
        key: `owned-${Date.now()}`,
        name: 'Owned probe',
        kind: 'http',
        config: { url: 'https://example.com/health', assertions: [] },
      },
    })

    await pairAgent('runner-a')
    await pairAgent('runner-b')
    await pairAgent('runner-c')

    const view = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/${fx.slug}/controls/${created.json().id}/assignment`,
      headers: { cookie: adminCookie2 },
    })
    expect(view.statusCode).toBe(200)
    expect(view.json().candidates.length, 'several agents could run it').toBeGreaterThan(1)
    expect(view.json().runners, 'but only one does').toHaveLength(1)

    // And the agent that owns it is one that could: the election never names an
    // agent whose key does not cover the control.
    const owner = view.json().runners[0]
    const candidate = view.json().candidates.find((c: { id: string }) => c.id === owner)
    expect(candidate?.eligible).toBe(true)
  })

  it('honours an explicit choice, and reports who runs it', async () => {
    const created = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/controls`,
      headers: { cookie: adminCookie2 },
      payload: {
        key: `pinned-${Date.now()}`,
        name: 'Pinned probe',
        kind: 'tcp',
        config: { host: 'example.com', port: 443, assertions: [] },
      },
    })
    const controlId = created.json().id

    const chosen = await pairAgent('the-chosen-one')

    const put = await fx.app.inject({
      method: 'PUT',
      url: `/api/v1/${fx.slug}/controls/${controlId}/assignment`,
      headers: { cookie: adminCookie2 },
      payload: { policy: 'single', agentIds: [chosen.agentId] },
    })
    expect(put.statusCode).toBe(200)
    expect(put.json().runners).toEqual([chosen.agentId])

    const view = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/${fx.slug}/controls/${controlId}/assignment`,
      headers: { cookie: adminCookie2 },
    })
    expect(view.json().pinned).toEqual([chosen.agentId])
    expect(view.json().runners).toEqual([chosen.agentId])

    const jobs = await fx.app.inject({
      method: 'GET',
      url: '/api/v1/agent/jobs',
      headers: { authorization: `Bearer ${chosen.apiKey}` },
    })
    expect(
      (jobs.json().jobs as { controlKey: string }[]).some((j) =>
        j.controlKey.startsWith('pinned-'),
      ),
    ).toBe(true)
  })

  it('runs on every agent when the policy asks for it', async () => {
    // Probing one endpoint from several sites is a real case — it just has to
    // be asked for rather than happening by accident.
    const created = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/controls`,
      headers: { cookie: adminCookie2 },
      payload: {
        key: `everywhere-${Date.now()}`,
        name: 'From everywhere',
        kind: 'tcp',
        config: { host: 'example.com', port: 443, assertions: [] },
      },
    })

    await fx.app.inject({
      method: 'PUT',
      url: `/api/v1/${fx.slug}/controls/${created.json().id}/assignment`,
      headers: { cookie: adminCookie2 },
      payload: { policy: 'all', agentIds: [] },
    })

    const view = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/${fx.slug}/controls/${created.json().id}/assignment`,
      headers: { cookie: adminCookie2 },
    })
    expect(view.json().runners.length).toBeGreaterThan(1)
  })

  it('refuses to pin an agent from another tenant', async () => {
    const other = await createFixture()
    try {
      const otherCookie = await login(other.app, other.users.admin.email)
      const code = await other.app.inject({
        method: 'POST',
        url: `/api/v1/${other.slug}/pairing-codes`,
        headers: { cookie: otherCookie },
        payload: {},
      })
      const theirAgent = await other.app.inject({
        method: 'POST',
        url: '/api/v1/pair',
        payload: { code: code.json().pin, hostname: 'theirs' },
      })

      const created = await fx.app.inject({
        method: 'POST',
        url: `/api/v1/${fx.slug}/controls`,
        headers: { cookie: adminCookie2 },
        payload: {
          key: `cross-${Date.now()}`,
          name: 'Cross tenant',
          kind: 'tcp',
          config: { host: 'example.com', port: 443, assertions: [] },
        },
      })

      const response = await fx.app.inject({
        method: 'PUT',
        url: `/api/v1/${fx.slug}/controls/${created.json().id}/assignment`,
        headers: { cookie: adminCookie2 },
        payload: { policy: 'single', agentIds: [theirAgent.json().agentId] },
      })
      expect(response.statusCode).toBe(404)
    } finally {
      await other.cleanup()
    }
  }, 30_000)
})

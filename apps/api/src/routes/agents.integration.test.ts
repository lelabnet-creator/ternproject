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
): Promise<{ pin: string; id: string; statusCode: number; pairCommand?: string }> {
  const response = await fx.app.inject({
    method: 'POST',
    url: `/api/v1/${fx.slug}/pairing-codes`,
    headers: { cookie },
    payload: body,
  })
  return {
    statusCode: response.statusCode,
    pin: response.statusCode === 200 ? response.json().pin : '',
    id: response.statusCode === 200 ? response.json().id : '',
    pairCommand: response.statusCode === 200 ? response.json().pairCommand : undefined,
  }
}

/** The code's own state, as the admin screen showing the PIN asks for it. */
const codeState = (cookie: string, id: string) =>
  fx.app.inject({
    method: 'GET',
    url: `/api/v1/${fx.slug}/pairing-codes/${id}`,
    headers: { cookie },
  })

const redeem = (code: string, extra: Record<string, unknown> = {}) =>
  fx.app.inject({
    method: 'POST',
    url: '/api/v1/pair',
    headers: { 'x-tern-protocol': '1' },
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
    expect(wrong.json().detail).toBe(usedUp.json().detail)
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
          headers: { 'x-tern-protocol': '1' },
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
        headers: { 'x-tern-protocol': '1' },
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
      headers: { 'x-tern-protocol': '1' },
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
      headers: { 'x-tern-protocol': '1' },
      payload: { code: code.json().pin, hostname: 'refresh-test' },
    })

    const refreshed = await fx.app.inject({
      method: 'GET',
      url: '/api/v1/agent/jobs',
      headers: { 'x-tern-protocol': '1', authorization: `Bearer ${paired.json().apiKey}` },
    })
    expect(refreshed.statusCode).toBe(200)
    expect(refreshed.json().tenantSlug).toBe(fx.slug)
    expect(refreshed.json().jobs).toEqual(paired.json().jobs)
  })

  it('refuses to hand out an assignment without a key', async () => {
    // Speaks the protocol — what is being refused here is the missing key, and
    // without the header the version check answers first with a 400.
    const response = await fx.app.inject({
      method: 'GET',
      url: '/api/v1/agent/jobs',
      headers: { 'x-tern-protocol': '1' },
    })
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
      headers: { 'x-tern-protocol': '1' },
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
      headers: { 'x-tern-protocol': '1', authorization: `Bearer ${chosen.apiKey}` },
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
        headers: { 'x-tern-protocol': '1' },
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

describe('removing agents', () => {
  let cookie: string

  beforeAll(async () => {
    cookie = await login(fx.app, fx.users.admin.email)
  }, 30_000)

  const pair = async (hostname: string) => {
    const code = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/pairing-codes`,
      headers: { cookie },
      payload: {},
    })
    const paired = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      headers: { 'x-tern-protocol': '1' },
      payload: { code: code.json().pin, hostname },
    })
    return paired.json() as { agentId: string; apiKey: string }
  }

  it('revokes several at once, and their keys stop working', async () => {
    const a = await pair('bulk-a')
    const b = await pair('bulk-b')

    const response = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/agents/bulk`,
      headers: { cookie },
      payload: { ids: [a.agentId, b.agentId], action: 'revoke' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().affected).toBe(2)

    // The record surviving is the point of revoke; the key not surviving is
    // what makes it a revocation rather than a label.
    const jobs = await fx.app.inject({
      method: 'GET',
      url: '/api/v1/agent/jobs',
      headers: { 'x-tern-protocol': '1', authorization: `Bearer ${a.apiKey}` },
    })
    expect(jobs.statusCode).toBe(401)
  })

  it('deletes several, revoking their keys on the way out', async () => {
    const a = await pair('gone-a')
    const b = await pair('gone-b')

    const response = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/agents/bulk`,
      headers: { cookie },
      payload: { ids: [a.agentId, b.agentId], action: 'delete' },
    })
    expect(response.statusCode).toBe(200)

    const listed = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/${fx.slug}/agents`,
      headers: { cookie },
    })
    const ids = (listed.json() as { id: string }[]).map((agent) => agent.id)
    expect(ids).not.toContain(a.agentId)
    expect(ids).not.toContain(b.agentId)

    // A deleted record with a live credential would be a deletion in name only.
    const jobs = await fx.app.inject({
      method: 'GET',
      url: '/api/v1/agent/jobs',
      headers: { 'x-tern-protocol': '1', authorization: `Bearer ${b.apiKey}` },
    })
    expect(jobs.statusCode).toBe(401)
  })

  it('changes nothing when one id belongs to another tenant', async () => {
    const mine = await pair('mine-bulk')
    const other = await createFixture()

    try {
      const otherCookie = await login(other.app, other.users.admin.email)
      const code = await other.app.inject({
        method: 'POST',
        url: `/api/v1/${other.slug}/pairing-codes`,
        headers: { cookie: otherCookie },
        payload: {},
      })
      const theirs = await other.app.inject({
        method: 'POST',
        url: '/api/v1/pair',
        headers: { 'x-tern-protocol': '1' },
        payload: { code: code.json().pin, hostname: 'theirs-bulk' },
      })

      const response = await fx.app.inject({
        method: 'POST',
        url: `/api/v1/${fx.slug}/agents/bulk`,
        headers: { cookie },
        payload: { ids: [mine.agentId, theirs.json().agentId], action: 'delete' },
      })
      expect(response.statusCode).toBe(404)

      // And the one that was ours is untouched: validation happens before the
      // transaction, not inside the loop.
      const stillJobs = await fx.app.inject({
        method: 'GET',
        url: '/api/v1/agent/jobs',
        headers: { 'x-tern-protocol': '1', authorization: `Bearer ${mine.apiKey}` },
      })
      expect(stillJobs.statusCode).toBe(200)
    } finally {
      await other.cleanup()
    }
  }, 30_000)
})

/**
 * A proxy declaring the zone it relays for.
 *
 * The agents behind a proxy never reach this server — that is what the relay is
 * for — so without this endpoint the fleet view showed one dot where there were
 * nine machines. What is worth pinning is not the happy path but the two ways it
 * could quietly go wrong: an ordinary agent inventing machines, and a zone that
 * shrinks without the view noticing.
 */
describe('the pairing code', () => {
  it('offers both verbs, because it does not choose the role', () => {
    // The role is decided at pairing, from the version the binary announces —
    // not by the code. So an admin who mints one and changes their mind needs
    // the other line, not another code.
    return login(fx.app, fx.users.admin.email).then(async (cookie) => {
      const { pin, statusCode } = await createPin(cookie)
      expect(statusCode).toBe(200)

      const response = await fx.app.inject({
        method: 'POST',
        url: `/api/v1/${fx.slug}/pairing-codes`,
        headers: { cookie },
        payload: {},
      })
      const body = response.json() as { pairCommand: string; proxyPairCommand: string }

      expect(body.pairCommand).toContain('tern-agent pair')
      expect(body.proxyPairCommand).toContain('tern-proxy init')
      // Same shape, same server, same placeholder position — the two lines must
      // read as the same gesture, because they are.
      expect(body.proxyPairCommand).toContain('--server')
      expect(body.proxyPairCommand).toContain('--pin')
      expect(pin).toBeTruthy()
    })
  })
})

describe('a proxy declaring its zone', () => {
  /** Pairs one, and answers with the key it may speak with. */
  async function pairAs(version: string): Promise<{ key: string; id: string }> {
    const cookie = await login(fx.app, fx.users.admin.email)
    const { pin } = await createPin(cookie)
    const paired = await redeem(pin, { agentVersion: version })
    expect(paired.statusCode).toBe(200)
    return { key: paired.json().apiKey, id: paired.json().agentId }
  }

  const declare = (key: string, agents: unknown[]) =>
    fx.app.inject({
      method: 'POST',
      url: '/api/v1/agent/zone',
      headers: { 'x-tern-protocol': '1', authorization: `Bearer ${key}` },
      payload: { agents },
    })

  const fleet = async () => {
    const cookie = await login(fx.app, fx.users.admin.email)
    const response = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/${fx.slug}/agents`,
      headers: { cookie },
    })
    return response.json() as {
      id: string
      name: string
      role: string
      parentAgentId: string | null
    }[]
  }

  it('is recognised as a proxy by the version it pairs with', async () => {
    // The signal `tern-proxy` already sends. Reading it rather than adding a
    // field is what lets a proxy deployed before this release be recognised.
    const proxy = await pairAs('proxy/0.1.0')
    const rows = await fleet()
    // By the id pairing returned, not by guessing at the name: the server
    // derives the agent name itself, and a test that matched on a hostname
    // would be asserting that derivation rather than the role.
    expect(rows.find((row) => row.id === proxy.id)?.role).toBe('proxy')
  })

  it('files its agents behind it', async () => {
    const proxy = await pairAs('proxy/0.1.0')

    const declared = await declare(proxy.key, [
      { name: 'zone-a', lastSeenAt: '2026-08-06T07:06:40Z', ip: '10.0.0.4' },
      { name: 'zone-b', lastSeenAt: null, ip: null },
    ])
    expect(declared.statusCode).toBe(200)
    expect(declared.json().known).toBe(2)

    const rows = await fleet()
    const a = rows.find((row) => row.name === 'zone-a')
    expect(a?.parentAgentId).toBe(proxy.id)
    expect(a?.role).toBe('agent')
  })

  it('unlinks an agent the zone no longer has, rather than deleting it', async () => {
    const proxy = await pairAs('proxy/0.1.0')
    await declare(proxy.key, [{ name: 'leaving', lastSeenAt: '2026-08-06T07:06:40Z', ip: '10.0.0.9' }])
    await declare(proxy.key, [{ name: 'staying', lastSeenAt: null, ip: null }])

    const rows = await fleet()
    const gone = rows.find((row) => row.name === 'leaving')
    // Still on record — losing the relay must not erase what was behind it,
    // which is exactly what somebody investigates next — but no longer drawn
    // as part of this zone.
    expect(gone).toBeDefined()
    expect(gone?.parentAgentId).toBeNull()
    expect(rows.find((row) => row.name === 'staying')?.parentAgentId).toBe(proxy.id)
  })

  it('does not adopt an agent that paired here under the same name', async () => {
    /*
     * The failure this pins was found by running a proxy and a direct agent on
     * one machine: both send the same hostname, so a match on name alone filed
     * the direct agent behind the proxy and overwrote its last contact. The
     * view then drew a machine inside a zone it was never in.
     */
    const direct = await pairAs('0.1.0')
    const rows = await fleet()
    const name = rows.find((row) => row.id === direct.id)!.name

    const proxy = await pairAs('proxy/0.1.0')
    await declare(proxy.key, [{ name, lastSeenAt: '2026-08-06T07:06:40Z', ip: '10.0.0.4' }])

    const after = await fleet()
    const untouched = after.find((row) => row.id === direct.id)
    expect(untouched?.parentAgentId, 'an agent with a key of ours is behind nothing').toBeNull()

    // And the zone agent exists as its own row, behind this proxy. Narrowed to
    // this proxy on purpose: the fixture is shared, and every agent paired by a
    // test in this file derives the same name from the same hostname.
    const zone = after.filter((row) => row.parentAgentId === proxy.id)
    expect(zone).toHaveLength(1)
    expect(zone[0]?.id).not.toBe(direct.id)
  })

  it('unlinks a keyed agent a previous version had adopted', async () => {
    // The repair clause. Rows written by the first version of this endpoint are
    // already in the wild; the next declaration has to clear them rather than
    // leave somebody to find a machine drawn in the wrong zone.
    const direct = await pairAs('0.1.0')
    const proxy = await pairAs('proxy/0.1.0')

    await fx.app.db
      .update(schema.agents)
      .set({ parentAgentId: proxy.id })
      .where(eq(schema.agents.id, direct.id))

    await declare(proxy.key, [{ name: 'unrelated', lastSeenAt: null, ip: null }])

    const after = await fleet()
    expect(after.find((row) => row.id === direct.id)?.parentAgentId).toBeNull()
  })

  it('refuses an ordinary agent that tries to invent machines', async () => {
    const agent = await pairAs('0.1.0')
    const attempt = await declare(agent.key, [{ name: 'ghost', lastSeenAt: null, ip: null }])
    expect(attempt.statusCode).toBe(403)

    const rows = await fleet()
    expect(rows.find((row) => row.name === 'ghost')).toBeUndefined()
  })

  it('refuses a caller with no key at all', async () => {
    const attempt = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/agent/zone',
      headers: { 'x-tern-protocol': '1' },
      payload: { agents: [] },
    })
    expect(attempt.statusCode).toBe(401)
  })

  /**
   * Where a relay serves its zone, said by the relay.
   *
   * This server used to infer it from the address the pairing arrived from,
   * which with TERN in a container is a Docker bridge gateway — an address that
   * exists only on that one host. The admin then offered it as the address to
   * reach the relay on, and it produced a connection refused on the one machine
   * that could not investigate. Only the relay knows where it binds.
   */
  it('records the address a relay says it serves on', async () => {
    const proxy = await pairAs('proxy/0.1.0')

    await fx.app.inject({
      method: 'POST',
      url: '/api/v1/agent/zone',
      headers: { 'x-tern-protocol': '1', authorization: `Bearer ${proxy.key}` },
      payload: { agents: [], listen: '192.168.1.170:8787' },
    })

    const rows = (await fleet()) as unknown as { id: string; zoneAddress: string | null }[]
    expect(rows.find((row) => row.id === proxy.id)?.zoneAddress).toBe('192.168.1.170:8787')
  })

  it('keeps the zone when the address list is unusable', async () => {
    /*
     * The failure this comes from: a relay on a Docker host reported
     * twenty-four addresses, one per container network. The list was capped at
     * sixteen, the whole declaration was refused with a 400 every five minutes,
     * and the fleet showed an empty zone with nothing on screen to explain it.
     *
     * The addresses are a convenience; the agents are the point. A list that
     * will not fit is dropped, and the machines behind the relay still arrive.
     */
    const proxy = await pairAs('proxy/0.1.0')
    const tooMany = Array.from({ length: 200 }, (_, i) => `10.0.0.${i % 255}`)

    const declared = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/agent/zone',
      headers: { 'x-tern-protocol': '1', authorization: `Bearer ${proxy.key}` },
      payload: {
        agents: [{ name: 'zone-a', lastSeenAt: null, ip: null }],
        listen: '10.0.0.1:38787',
        addresses: tooMany,
      },
    })

    expect(declared.statusCode).toBe(200)
    expect(declared.json().known).toBe(1)

    const rows = (await fleet()) as unknown as {
      id: string
      zoneAddress: string | null
      zoneAddresses: string[]
    }[]
    const row = rows.find((r) => r.id === proxy.id)
    // The address it binds still lands — only the oversized list is dropped.
    expect(row?.zoneAddress).toBe('10.0.0.1:38787')
    expect(row?.zoneAddresses).toEqual([])
  })

  it('leaves it null for a relay too old to say', async () => {
    // A relay deployed before this release sends no such field, and must keep
    // working — the admin falls back to its guess and labels it as one.
    const proxy = await pairAs('proxy/0.1.0')
    await declare(proxy.key, [{ name: 'zone-x', lastSeenAt: null, ip: null }])

    const rows = (await fleet()) as unknown as { id: string; zoneAddress: string | null }[]
    expect(rows.find((row) => row.id === proxy.id)?.zoneAddress).toBeNull()
  })

  /**
   * A relay redeeming, for a machine that cannot reach this server at all.
   *
   * Before this, a code for such a machine could only be minted on the relay
   * itself. The admin could therefore never print a command that worked as
   * pasted: the one value it needed was the one value it could not know.
   *
   * What must stay true is not where the code comes from but what the agent
   * ends up holding — a key minted by the relay, worth nothing here. Nothing
   * in this exchange carries a key, which is what these cases pin.
   */
  describe('redeeming a code for a zone', () => {
    const redeemFor = (key: string, code: string) =>
      fx.app.inject({
        method: 'POST',
        url: '/api/v1/agent/zone/redeem',
        headers: { 'x-tern-protocol': '1', authorization: `Bearer ${key}` },
        payload: { code },
      })

    it('answers a relay with the tenant, and with no key', async () => {
      const proxy = await pairAs('proxy/0.1.0')
      const cookie = await login(fx.app, fx.users.admin.email)
      const { pin } = await createPin(cookie)

      const answer = await redeemFor(proxy.key, pin)
      expect(answer.statusCode).toBe(200)
      expect(answer.json().tenantSlug).toBe(fx.slug)
      // The whole security argument in one assertion: an agent in the zone must
      // never come away holding something this server would accept.
      expect(JSON.stringify(answer.json())).not.toContain('apiKey')
    })

    it('spends the code, so a second machine cannot reuse it', async () => {
      const proxy = await pairAs('proxy/0.1.0')
      const cookie = await login(fx.app, fx.users.admin.email)
      const { pin } = await createPin(cookie)

      expect((await redeemFor(proxy.key, pin)).statusCode).toBe(200)
      expect((await redeemFor(proxy.key, pin)).statusCode).toBe(401)
      // And it is spent for the ordinary path too — one code, one machine,
      // whichever door it walks through.
      expect((await redeem(pin, {})).statusCode).toBe(401)
    })

    it('is closed to anything that is not a relay', async () => {
      // An ordinary agent redeeming codes would be a way to enrol machines
      // nobody added, from a key that was only ever meant to push points.
      const agent = await pairAs('0.1.16')
      const cookie = await login(fx.app, fx.users.admin.email)
      const { pin } = await createPin(cookie)

      expect((await redeemFor(agent.key, pin)).statusCode).toBe(403)
      expect((await redeemFor('ternp_not_a_key', pin)).statusCode).toBe(401)
    })

    it('says the same thing to a wrong code as to a spent one', async () => {
      const proxy = await pairAs('proxy/0.1.0')
      const wrong = await redeemFor(proxy.key, 'ZZZZ-ZZZZ')
      expect(wrong.statusCode).toBe(401)
      expect(wrong.json().detail).toBe('Invalid or expired pairing code')
    })
  })
})

/**
 * Whether a code has been redeemed, asked by the screen that is showing it.
 *
 * A single-use PIN dies the moment a machine pairs with it, and the admin had
 * no way to notice: the panel went on displaying it, counting down, offering a
 * Copy button, for a credential the server would now refuse. This is what the
 * panel polls to replace it.
 */
describe('the state of a pairing code', () => {
  it('reports a fresh code as unused', async () => {
    const cookie = await login(fx.app, fx.users.admin.email)
    const { id } = await createPin(cookie)

    const state = await codeState(cookie, id)
    expect(state.statusCode).toBe(200)
    expect(state.json()).toMatchObject({ usedCount: 0, maxUses: 1, consumedAt: null, agents: [] })
  })

  it('reports it spent, and names what took it', async () => {
    const cookie = await login(fx.app, fx.users.admin.email)
    const { id, pin } = await createPin(cookie)

    expect((await redeem(pin, { hostname: 'srv-app-07' })).statusCode).toBe(200)

    const state = await codeState(cookie, id)
    expect(state.json().usedCount).toBe(1)
    expect(state.json().consumedAt).not.toBeNull()
    // The name matters: it is what the panel says to explain why the PIN it
    // was showing has just been replaced.
    expect(state.json().agents).toHaveLength(1)
    expect(state.json().agents[0].name).toBe('srv-app-07')
  })

  it('is closed to anyone who cannot manage agents', async () => {
    const cookie = await login(fx.app, fx.users.admin.email)
    const { id } = await createPin(cookie)

    const memberCookie = await login(fx.app, fx.users.member.email)
    expect((await codeState(memberCookie, id)).statusCode).toBe(403)

    const anonymous = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/${fx.slug}/pairing-codes/${id}`,
    })
    expect(anonymous.statusCode).toBe(401)
  })

  it('says nothing about a code belonging to nobody here', async () => {
    const cookie = await login(fx.app, fx.users.admin.email)
    const missing = await codeState(cookie, '00000000-0000-4000-8000-000000000000')
    expect(missing.statusCode).toBe(404)
  })

  it("will not read another tenant's code", async () => {
    /*
     * The real isolation test, and it needs a second tenant to be one.
     *
     * Checking a made-up uuid proves nothing here: it answers 404 whether the
     * query is scoped to the tenant or not. Only a code that genuinely exists,
     * somewhere else, can tell the two apart — and dropping the tenant filter
     * would turn this into a 200 that hands one customer the pairing state of
     * another. The answer must be the same as for a code that never existed:
     * a 403 would confirm the id belongs to somebody.
     */
    const other = await createFixture()
    try {
      const otherCookie = await login(other.app, other.users.admin.email)
      const minted = await other.app.inject({
        method: 'POST',
        url: `/api/v1/${other.slug}/pairing-codes`,
        headers: { cookie: otherCookie },
        payload: {},
      })
      expect(minted.statusCode).toBe(200)

      const cookie = await login(fx.app, fx.users.admin.email)
      expect((await codeState(cookie, minted.json().id)).statusCode).toBe(404)
    } finally {
      await other.cleanup()
    }
  })
})

/**
 * Pairing the same install again, instead of growing a twin of it.
 *
 * Pairing used to insert unconditionally: nothing in the request could tell
 * "this machine again" from "a new machine". So re-running an installer put a
 * second identical row in the fleet, and the operator had to work out which of
 * the two was live. The agent now carries an identifier in its own config.
 */
describe('pairing the same install twice', () => {
  const pairWith = (pin: string, body: Record<string, unknown>) =>
    fx.app.inject({
      method: 'POST',
      url: '/api/v1/pair',
      headers: { 'x-tern-protocol': '1' },
      payload: { code: pin, hostname: 'srv-web-01', os: 'linux', arch: 'x86_64', ...body },
    })

  async function rowsFor(installId: string) {
    return fx.app.db.select().from(schema.agents).where(eq(schema.agents.installId, installId))
  }

  it('replaces the row rather than adding one', async () => {
    const cookie = await login(fx.app, fx.users.admin.email)
    const install = 'install-aaaaaaaaaaaa'

    const first = await pairWith((await createPin(cookie)).pin, { installId: install })
    expect(first.statusCode).toBe(200)
    const second = await pairWith((await createPin(cookie)).pin, { installId: install })
    expect(second.statusCode).toBe(200)

    expect(await rowsFor(install)).toHaveLength(1)
    // The same row, not a replacement wearing the same identifier.
    expect(second.json().agentId).toBe(first.json().agentId)
  })

  it('kills the key the row used to hold', async () => {
    // Otherwise a machine that was re-paired leaves a working credential behind
    // it, which is a key nobody is tracking and nobody will revoke.
    const cookie = await login(fx.app, fx.users.admin.email)
    const install = 'install-bbbbbbbbbbbb'

    const first = await pairWith((await createPin(cookie)).pin, { installId: install })
    const oldKey = first.json().apiKey
    const second = await pairWith((await createPin(cookie)).pin, { installId: install })

    const beat = (key: string) =>
      fx.app.inject({
        method: 'POST',
        url: '/api/v1/agent/heartbeat',
        headers: { 'x-tern-protocol': '1', authorization: `Bearer ${key}` },
      })

    expect((await beat(oldKey)).statusCode).toBe(401)
    expect((await beat(second.json().apiKey)).statusCode).toBe(200)
  })

  it('brings a revoked machine back rather than beside itself', async () => {
    const cookie = await login(fx.app, fx.users.admin.email)
    const install = 'install-cccccccccccc'

    const first = await pairWith((await createPin(cookie)).pin, { installId: install })
    await fx.app.db
      .update(schema.agents)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(eq(schema.agents.id, first.json().agentId))

    await pairWith((await createPin(cookie)).pin, { installId: install })

    const rows = await rowsFor(install)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('active')
    expect(rows[0]!.revokedAt).toBeNull()
  })

  it('keeps two installs on one host apart', async () => {
    /*
     * The reason this matches on an identifier and not on a hostname.
     *
     * Two agents on one machine, and two VMs cloned from one image, both send
     * the same hostname, OS and architecture. Merging on those would have fixed
     * the duplicate that prompted this and silently dropped a real machine's
     * monitoring — a failure that looks exactly like success.
     */
    const cookie = await login(fx.app, fx.users.admin.email)

    const a = await pairWith((await createPin(cookie)).pin, { installId: 'install-dddddddddddd' })
    const b = await pairWith((await createPin(cookie)).pin, { installId: 'install-eeeeeeeeeeee' })

    expect(a.json().agentId).not.toBe(b.json().agentId)
  })

  it('still pairs an agent too old to carry one', async () => {
    // No identifier at all: it gets a row of its own, which is the behaviour
    // every agent had before this existed. Refusing it would take a fleet out.
    const cookie = await login(fx.app, fx.users.admin.email)

    const first = await pairWith((await createPin(cookie)).pin, {})
    const second = await pairWith((await createPin(cookie)).pin, {})

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(first.json().agentId).not.toBe(second.json().agentId)
  })

  it('records a version without the prefix that carries the role', async () => {
    // `proxy/0.1.0` in a version column put the same relay at two different
    // versions depending on whether it had heartbeated since pairing.
    const cookie = await login(fx.app, fx.users.admin.email)
    const install = 'install-ffffffffffff'

    await pairWith((await createPin(cookie)).pin, {
      installId: install,
      agentVersion: 'proxy/0.1.28',
    })

    const [row] = await rowsFor(install)
    expect(row!.agentVersion).toBe('0.1.28')
    // The role is still read from what was sent.
    expect(row!.role).toBe('proxy')
  })
})

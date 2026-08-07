import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schema } from '@tern/db'
import { createFixture, login, type TestFixture } from '../test/harness.js'
import { LOCAL_AGENT_NAME, ensureLocalAgent, resolveBinary } from '../services/local-agent.js'
import { issueApiKey } from '../services/apikeys.js'

/**
 * `Agent-local-tern`, and the one thing it must never do: disappear.
 *
 * No process is started anywhere in this file, and none is started by the API
 * either — the agent runs as its own compose service, supervised by Docker.
 * What the server still owns, and what is pinned here, is the record:
 * provisioning (idempotent, one row, a usable key) and the refusal to revoke or
 * delete, which is the behaviour a future change is most likely to break
 * without noticing.
 */

let fx: TestFixture

beforeAll(async () => {
  fx = await createFixture()
}, 30_000)

afterAll(async () => {
  await fx.cleanup()
})

const localAgent = async () => {
  const [row] = await fx.app.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.tenantId, fx.tenantId), eq(schema.agents.isLocal, true)))
    .limit(1)
  return row
}

describe('provisioning', () => {
  it('creates exactly one, and creating it again changes nothing', async () => {
    await ensureLocalAgent(fx.app, fx.tenantId)
    const first = await localAgent()

    expect(first?.name).toBe(LOCAL_AGENT_NAME)
    // Not paired: there is no code to redeem when the server is the machine.
    expect(first?.pairingCodeId).toBeNull()
    expect(first?.apiKeyId).toBeTruthy()

    // Runs at every boot, so a second call must be a no-op rather than a second
    // agent in the fleet.
    await ensureLocalAgent(fx.app, fx.tenantId)
    const rows = await fx.app.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.tenantId, fx.tenantId), eq(schema.agents.isLocal, true)))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(first?.id)
    expect(rows[0]?.apiKeyId).toBe(first?.apiKeyId)
  })

  it('gives it the whole tenant, which is what makes local-probes stand down', async () => {
    await ensureLocalAgent(fx.app, fx.tenantId)
    const agent = await localAgent()

    const [key] = await fx.app.db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, agent!.apiKeyId!))
      .limit(1)

    // An empty scope reads as "every control in the tenant" — see the
    // `tenantsFullyCovered` set in services/local-probes.ts. A non-empty scope
    // here would silently have both runners measuring the same controls.
    expect(key?.scopeControlIds).toEqual([])
    expect(key?.scopes).toContain('ingest')
    expect(key?.revokedAt).toBeNull()
  })
})

describe('it cannot be taken away', () => {
  it('refuses to revoke it', async () => {
    await ensureLocalAgent(fx.app, fx.tenantId)
    const agent = await localAgent()
    const cookie = await login(fx.app, fx.users.admin.email)

    const response = await fx.app.inject({
      method: 'DELETE',
      url: `/api/v1/${fx.slug}/agents/${agent!.id}`,
      headers: { cookie },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().message).toContain(LOCAL_AGENT_NAME)

    // Still active, and its key still works: a refusal that half-applied would
    // leave the running agent pushing with a revoked credential.
    const after = await localAgent()
    expect(after?.status).toBe('active')
    expect(after?.revokedAt).toBeNull()

    const [key] = await fx.app.db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, after!.apiKeyId!))
    expect(key?.revokedAt).toBeNull()
  })

  it('refuses a bulk action that includes it, without touching the others', async () => {
    await ensureLocalAgent(fx.app, fx.tenantId)
    const local = await localAgent()
    const cookie = await login(fx.app, fx.users.admin.email)

    // An ordinary agent alongside it, to prove the refusal is not partial.
    const [ordinary] = await fx.app.db
      .insert(schema.agents)
      .values({ tenantId: fx.tenantId, name: 'srv-ordinary' })
      .returning()

    const response = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/agents/bulk`,
      headers: { cookie },
      payload: { ids: [ordinary!.id, local!.id], action: 'delete' },
    })

    expect(response.statusCode).toBe(409)

    // The whole request is refused, so the ordinary one survives too. A bulk
    // action that acts on five of six is one nobody can predict.
    const survivors = await fx.app.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, ordinary!.id))
    expect(survivors).toHaveLength(1)
    expect(survivors[0]?.status).toBe('active')
  })

  it('is reported as local so the fleet screen can say why', async () => {
    await ensureLocalAgent(fx.app, fx.tenantId)
    const cookie = await login(fx.app, fx.users.admin.email)

    const response = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/${fx.slug}/agents`,
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
    const mine = response.json().find((a: { name: string }) => a.name === LOCAL_AGENT_NAME)
    expect(mine?.isLocal).toBe(true)

    // And nothing else is, or the screen would hide every revoke button.
    const others = response.json().filter((a: { name: string }) => a.name !== LOCAL_AGENT_NAME)
    expect(others.every((a: { isLocal: boolean }) => !a.isLocal)).toBe(true)
  })
})

describe('liveness', () => {
  it('marks the agent seen when it pushes, so local-probes stands down', async () => {
    await ensureLocalAgent(fx.app, fx.tenantId)
    const agent = await localAgent()

    // Deliberately stale: this is the state every agent was permanently in
    // before `touchAgent` existed, because `last_seen_at` was written once at
    // pairing and never again. Ten minutes later the fleet looked dead, and
    // local-probes started measuring controls a healthy agent was already
    // running — two vantage points interleaved into one series.
    await fx.app.db
      .update(schema.agents)
      .set({ lastSeenAt: new Date(Date.now() - 3_600_000) })
      .where(eq(schema.agents.id, agent!.id))

    // Only the hash of the provisioned key was kept, so this issues a fresh one
    // and points the agent at it — the same repair `ensureLocalAgent` performs
    // when the config file has gone missing.
    const issued = await issueApiKey(fx.app, {
      tenantId: fx.tenantId,
      name: 'Agent: liveness probe',
      scopes: ['ingest'],
    })
    await fx.app.db
      .update(schema.agents)
      .set({ apiKeyId: issued.id })
      .where(eq(schema.agents.id, agent!.id))

    const response = await fx.app.inject({
      method: 'GET',
      url: '/api/v1/agent/jobs',
      headers: { authorization: `Bearer ${issued.key}` },
    })
    expect(response.statusCode).toBe(200)

    const after = await localAgent()
    expect(after?.lastSeenAt).not.toBeNull()
    expect(Date.now() - after!.lastSeenAt!.getTime()).toBeLessThan(60_000)
  })
})

describe('the heartbeat', () => {
  it('keeps an agent with nothing to do from looking dead', async () => {
    await ensureLocalAgent(fx.app, fx.tenantId)
    const agent = await localAgent()

    // The state this endpoint exists for: an agent that has never pushed and
    // never asked for an assignment, because it has none. Before it, that agent
    // was indistinguishable from one whose host had been switched off.
    await fx.app.db
      .update(schema.agents)
      .set({ lastSeenAt: null, agentVersion: null })
      .where(eq(schema.agents.id, agent!.id))

    const issued = await issueApiKey(fx.app, {
      tenantId: fx.tenantId,
      name: 'Agent: heartbeat probe',
      scopes: ['ingest'],
    })
    await fx.app.db
      .update(schema.agents)
      .set({ apiKeyId: issued.id })
      .where(eq(schema.agents.id, agent!.id))

    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/agent/heartbeat',
      headers: { authorization: `Bearer ${issued.key}`, 'user-agent': 'tern-agent/9.9.9' },
    })

    expect(response.statusCode).toBe(200)

    const after = await localAgent()
    expect(after?.lastSeenAt).not.toBeNull()
    // And it carries the version, so the fleet stops saying "version unknown"
    // for an agent that never had a pairing handshake to report one.
    expect(after?.agentVersion).toBe('9.9.9')
  })

  it('refuses a caller without a key', async () => {
    const response = await fx.app.inject({ method: 'POST', url: '/api/v1/agent/heartbeat' })
    expect(response.statusCode).toBe(401)
  })
})

describe('the binary', () => {
  it('either resolves to a file for this platform, or to nothing at all', () => {
    // Both are correct outcomes: `clients/agent/bin` is populated by CI, so a
    // source checkout may legitimately have none. What must not happen is a
    // path being returned for a file that is not there — the supervisor would
    // spawn it and fail on every restart.
    const binary = resolveBinary()
    if (binary !== null) expect(binary).toMatch(/tern-agent-/)
  })
})

import { and, eq, isNull } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schema } from '@tern/db'
import { createFixture, login, type TestFixture } from '../test/harness.js'

/**
 * The instruction channel, end to end.
 *
 * This is the one path that had no server-side tests at all: delivery marking,
 * the relay's right to answer for its zone, and the refusals. Every promise
 * the protocol document makes about instructions is asserted here.
 */

let fx: TestFixture
let cookie: string

const PROTO = { 'x-tern-protocol': '1' }

beforeAll(async () => {
  fx = await createFixture()
  cookie = await login(fx.app, fx.users.admin.email)
}, 30_000)

afterAll(async () => {
  await fx.cleanup()
})

/** Pairs a machine and returns its key and row id. */
async function pair(
  name: string,
  extra: Record<string, unknown> = {},
): Promise<{ key: string; agentId: string }> {
  const pinResponse = await fx.app.inject({
    method: 'POST',
    url: `/api/v1/${fx.slug}/pairing-codes`,
    headers: { cookie },
    payload: {},
  })
  const paired = await fx.app.inject({
    method: 'POST',
    url: '/api/v1/pair',
    headers: PROTO,
    payload: { code: pinResponse.json().pin, hostname: name, ...extra },
  })
  expect(paired.statusCode).toBe(200)
  return { key: paired.json().apiKey, agentId: paired.json().agentId }
}

const pairProxy = (name: string) => pair(name, { agentVersion: 'proxy/0.1.0' })

/** The console asking; answers the command id. */
async function ask(agentId: string, kind = 'pause'): Promise<string> {
  const response = await fx.app.inject({
    method: 'POST',
    url: `/api/v1/${fx.slug}/agents/${agentId}/commands`,
    headers: { cookie },
    payload: { kind },
  })
  expect(response.statusCode).toBe(200)
  return response.json().id
}

const poll = (key: string) =>
  fx.app.inject({
    method: 'GET',
    url: '/api/v1/agent/jobs',
    headers: { ...PROTO, authorization: `Bearer ${key}` },
  })

const beat = (key: string, payload?: unknown) =>
  fx.app.inject({
    method: 'POST',
    url: '/api/v1/agent/heartbeat',
    headers: { ...PROTO, authorization: `Bearer ${key}` },
    ...(payload === undefined ? {} : { payload }),
  })

const answer = (key: string, commandId: string, payload: Record<string, unknown>) =>
  fx.app.inject({
    method: 'POST',
    url: `/api/v1/agent/commands/${commandId}/result`,
    headers: { ...PROTO, authorization: `Bearer ${key}` },
    payload,
  })

describe('asking', () => {
  it('records who asked and answers the id', async () => {
    const { agentId } = await pair('cmd-asked')
    const id = await ask(agentId, 'logs')

    const [row] = await fx.app.db
      .select()
      .from(schema.agentCommands)
      .where(eq(schema.agentCommands.id, id))
    expect(row!.kind).toBe('logs')
    expect(row!.deliveredAt).toBeNull()
    expect(row!.completedAt).toBeNull()
  })

  it('refuses a kind nobody defined', async () => {
    const { agentId } = await pair('cmd-bad-kind')
    const response = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/agents/${agentId}/commands`,
      headers: { cookie },
      payload: { kind: 'defragment-the-hyperdrive' },
    })

    // A validation failure, in the problem+json shape with the issue located.
    expect(response.statusCode).toBe(400)
    expect(response.headers['content-type']).toContain('application/problem+json')
    const body = response.json()
    expect(body.code).toBe('validation')
    expect(body.issues.length).toBeGreaterThan(0)
  })

  it('refuses the local agent with a 409 that says why', async () => {
    const [local] = await fx.app.db
      .insert(schema.agents)
      .values({ tenantId: fx.tenantId, name: 'Agent-local-tern', isLocal: true })
      .returning({ id: schema.agents.id })

    const response = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/agents/${local!.id}/commands`,
      headers: { cookie },
      payload: { kind: 'pause' },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().code).toBe('conflict')
    expect(response.json().detail).toMatch(/inside this instance/)
  })
})

describe('delivery', () => {
  it('hands an instruction over exactly once', async () => {
    const { key, agentId } = await pair('cmd-once')
    const id = await ask(agentId, 'restart')

    const first = await poll(key)
    expect(first.statusCode).toBe(200)
    expect(first.json().commands).toEqual([{ id, kind: 'restart' }])

    // Marked as it was read: the second poll gets nothing, even though no
    // result ever arrived. At most once is the promise that keeps a restart
    // from happening twice.
    const second = await poll(key)
    expect(second.json().commands).toEqual([])

    const [row] = await fx.app.db
      .select()
      .from(schema.agentCommands)
      .where(eq(schema.agentCommands.id, id))
    expect(row!.deliveredAt).not.toBeNull()
    expect(row!.completedAt).toBeNull()
  })

  it('tells the agent something waits, on the beat', async () => {
    const { key, agentId } = await pair('cmd-waiting')

    expect((await beat(key)).json()).toEqual({ ok: true, commandsWaiting: false })

    await ask(agentId)
    expect((await beat(key)).json()).toEqual({ ok: true, commandsWaiting: true })

    // The beat only announces; the poll is what takes. Still waiting.
    expect((await beat(key)).json().commandsWaiting).toBe(true)

    await poll(key)
    expect((await beat(key)).json().commandsWaiting).toBe(false)
  })
})

describe('answering', () => {
  it('stores the result against the command', async () => {
    const { key, agentId } = await pair('cmd-result')
    const id = await ask(agentId, 'logs')
    await poll(key)

    const response = await answer(key, id, { result: 'the last 2000 lines', error: null })
    expect(response.statusCode).toBe(200)

    const [row] = await fx.app.db
      .select()
      .from(schema.agentCommands)
      .where(eq(schema.agentCommands.id, id))
    expect(row!.completedAt).not.toBeNull()
    expect(row!.result).toBe('the last 2000 lines')
    expect(row!.error).toBeNull()
  })

  it('refuses one agent answering for another', async () => {
    const alice = await pair('cmd-alice')
    const mallory = await pair('cmd-mallory')
    const id = await ask(alice.agentId)

    const response = await answer(mallory.key, id, { result: 'gotcha' })
    // The same 404 as an id that never existed: whether the command is real
    // is not mallory's to learn.
    expect(response.statusCode).toBe(404)

    const [row] = await fx.app.db
      .select()
      .from(schema.agentCommands)
      .where(eq(schema.agentCommands.id, id))
    expect(row!.completedAt).toBeNull()
  })
})

describe('the relay and its zone', () => {
  /** Declares one machine behind the proxy and returns its row id. */
  async function declareZoneAgent(proxyKey: string, name: string): Promise<string> {
    const declared = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/agent/zone',
      headers: { ...PROTO, authorization: `Bearer ${proxyKey}` },
      payload: { agents: [{ name, lastSeenAt: null, ip: null }] },
    })
    expect(declared.statusCode).toBe(200)

    const [row] = await fx.app.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.name, name), isNull(schema.agents.apiKeyId)))
    return row!.id
  }

  it('carries zone instructions by name, and beats for them', async () => {
    const proxy = await pairProxy('cmd-relay')
    const zoneId = await declareZoneAgent(proxy.key, 'cmd-zone-box')
    const id = await ask(zoneId, 'restart')

    // The relay's beat says its zone is waiting — that is what shortens the
    // zone latency from the refresh interval to the beat interval.
    expect((await beat(proxy.key)).json().commandsWaiting).toBe(true)

    const polled = await poll(proxy.key)
    expect(polled.json().commands).toEqual([])
    // Named, because the relay knows its zone by name, and delivered at most
    // once like everything else.
    expect(polled.json().zoneCommands).toEqual([{ id, kind: 'restart', agent: 'cmd-zone-box' }])
    expect((await poll(proxy.key)).json().zoneCommands).toEqual([])
  })

  it('lets the relay answer for its zone', async () => {
    const proxy = await pairProxy('cmd-relay-answers')
    const zoneId = await declareZoneAgent(proxy.key, 'cmd-zone-box-2')
    const id = await ask(zoneId, 'logs')
    await poll(proxy.key)

    // Under the relay's own key: the zone agent has no key on this server and
    // never will, so this is the only road its answer can travel.
    const response = await answer(proxy.key, id, { result: 'zone lines' })
    expect(response.statusCode).toBe(200)
  })

  it('refuses an unrelated agent answering for somebody else’s zone', async () => {
    const proxy = await pairProxy('cmd-relay-own')
    const stranger = await pair('cmd-stranger')
    const zoneId = await declareZoneAgent(proxy.key, 'cmd-zone-box-3')
    const id = await ask(zoneId)
    await poll(proxy.key)

    expect((await answer(stranger.key, id, { result: 'no' })).statusCode).toBe(404)
  })
})

describe('speaking the protocol', () => {
  it('refuses a poll that does not announce the version', async () => {
    const { key } = await pair('cmd-no-header')
    const response = await fx.app.inject({
      method: 'GET',
      url: '/api/v1/agent/jobs',
      headers: { authorization: `Bearer ${key}` },
    })

    expect(response.statusCode).toBe(400)
    expect(response.headers['content-type']).toContain('application/problem+json')
    const body = response.json()
    expect(body.code).toBe('protocol-mismatch')
    // Both versions named: the log line on the far machine is the whole
    // diagnosis, so it has to carry it.
    expect(body.detail).toContain('protocol 1')
    expect(body.detail).toContain('none')
  })

  it('refuses a version this server does not speak, naming both', async () => {
    const { key } = await pair('cmd-wrong-version')
    const response = await fx.app.inject({
      method: 'GET',
      url: '/api/v1/agent/jobs',
      headers: { 'x-tern-protocol': '2', authorization: `Bearer ${key}` },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().code).toBe('protocol-mismatch')
    expect(response.json().detail).toContain('announced 2')
  })

  it('echoes its version on every protocol reply', async () => {
    const { key } = await pair('cmd-echo')
    const response = await poll(key)
    expect(response.headers['x-tern-protocol']).toBe('1')
  })

  it('leaves the download surface alone', async () => {
    // Under /agent/ but serving browsers and scripts: no header required.
    const response = await fx.app.inject({ method: 'GET', url: '/api/v1/agent/releases' })
    expect(response.statusCode).toBe(200)
  })

  it('answers a valid key with no agent behind it with key-has-no-agent', async () => {
    // A key minted by hand, never paired — real, but speaking for no machine.
    const { issueApiKey } = await import('../services/apikeys.js')
    const minted = await issueApiKey(fx.app, {
      tenantId: fx.tenantId,
      name: 'hand-minted',
      scopes: ['ingest'],
      scopeControlIds: [],
      autoRegister: false,
    })

    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/agent/zone',
      headers: { ...PROTO, authorization: `Bearer ${minted.key}` },
      payload: { agents: [] },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('key-has-no-agent')
  })
})

describe('the heartbeat and the page address', () => {
  const stored = async (agentId: string) => {
    const [row] = await fx.app.db
      .select({ uiAddress: schema.agents.uiAddress })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId))
    return row!.uiAddress
  }

  it('distinguishes null from an absent field', async () => {
    const { key, agentId } = await pair('cmd-ui-null')

    await beat(key, { uiAddress: '192.168.1.50:38788' })
    expect(await stored(agentId)).toBe('192.168.1.50:38788')

    // Absent says nothing, and must leave the stored address alone.
    await beat(key, {})
    expect(await stored(agentId)).toBe('192.168.1.50:38788')

    // Null clears: "there is no page, or it is on loopback".
    await beat(key, { uiAddress: null })
    expect(await stored(agentId)).toBeNull()
  })

  it('accepts a beat with no body at all', async () => {
    const { key } = await pair('cmd-bodiless')
    expect((await beat(key)).statusCode).toBe(200)
  })
})

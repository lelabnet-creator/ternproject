import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schema } from '@tern/db'
import { blindIndex, decryptSecret } from '@tern/shared'
import { config } from '../config.js'
import { enqueueEvent } from '../services/notify.js'
import { createFixture, login, type TestFixture } from '../test/harness.js'

let fx: TestFixture

beforeAll(async () => {
  fx = await createFixture()
}, 30_000)

afterAll(async () => {
  await fx.cleanup()
})

const subscribe = (body: Record<string, unknown>) =>
  fx.app.inject({
    method: 'POST',
    url: `/api/v1/public/${fx.slug}/subscribers`,
    payload: body,
  })

async function findByAddress(address: string) {
  const [row] = await fx.app.db
    .select()
    .from(schema.subscribers)
    .where(eq(schema.subscribers.addressHash, blindIndex(address, config.APP_SECRET)))
  return row
}

describe('signing up', () => {
  it('accepts an email and stores it encrypted, not in clear', async () => {
    const address = `reader-${Date.now()}@example.com`
    const response = await subscribe({ address })
    expect(response.statusCode).toBe(202)

    const row = await findByAddress(address)
    expect(row).toBeDefined()
    // A subscriber list is a company's customer list. A database dump should
    // not hand it over.
    expect(row!.addressEnc).not.toContain(address)
    expect(decryptSecret(row!.addressEnc, config.APP_SECRET)).toBe(address)
  })

  it('does not confirm on signup', async () => {
    const address = `unconfirmed-${Date.now()}@example.com`
    await subscribe({ address })
    const row = await findByAddress(address)
    expect(row!.confirmedAt).toBeNull()
  })

  it('answers identically whether the address is new or already subscribed', async () => {
    // Anything else turns this endpoint into a way to test whether a given
    // person subscribes to a given company's status page.
    const address = `known-${Date.now()}@example.com`
    const first = await subscribe({ address })

    const row = await findByAddress(address)
    await fx.app.db
      .update(schema.subscribers)
      .set({ confirmedAt: new Date() })
      .where(eq(schema.subscribers.id, row!.id))

    const second = await subscribe({ address })
    expect(second.statusCode).toBe(first.statusCode)
    expect(second.json()).toEqual(first.json())
  })

  it('rejects a malformed email', async () => {
    expect((await subscribe({ address: 'not-an-address' })).statusCode).toBe(400)
  })

  it('refuses a plain-HTTP webhook', async () => {
    // Otherwise incident payloads and the signature travel in clear.
    const response = await subscribe({ channel: 'webhook', address: 'http://example.com/hook' })
    expect(response.statusCode).toBe(400)
  })

  it('does not create a duplicate when someone asks twice', async () => {
    const address = `twice-${Date.now()}@example.com`
    await subscribe({ address })
    await subscribe({ address })

    const rows = await fx.app.db
      .select()
      .from(schema.subscribers)
      .where(eq(schema.subscribers.addressHash, blindIndex(address, config.APP_SECRET)))
    expect(rows).toHaveLength(1)
  })
})

describe('confirming', () => {
  it('confirms with a valid token and refuses it a second time', async () => {
    const address = `confirm-${Date.now()}@example.com`
    await subscribe({ address })

    // The token is only ever sent by email, so the test reads it the way the
    // service stores it — hashed — by planting a known one.
    const row = await findByAddress(address)
    const token = 'a'.repeat(32)
    const { hashToken } = await import('@tern/shared')
    await fx.app.db
      .update(schema.subscribers)
      .set({ confirmTokenHash: hashToken(token) })
      .where(eq(schema.subscribers.id, row!.id))

    const first = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/public/${fx.slug}/subscribers/confirm/${token}`,
    })
    expect(first.statusCode).toBe(200)

    const confirmed = await findByAddress(address)
    expect(confirmed!.confirmedAt).not.toBeNull()
    expect(confirmed!.confirmTokenHash).toBeNull()

    // A forwarded confirmation link must not be replayable to re-confirm an
    // address someone has since unsubscribed.
    const second = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/public/${fx.slug}/subscribers/confirm/${token}`,
    })
    expect(second.statusCode).toBe(404)
  })
})

describe('unsubscribing', () => {
  it('works with the token alone and reports success even for an unknown one', async () => {
    const address = `leaving-${Date.now()}@example.com`
    await subscribe({ address })

    const { hashToken } = await import('@tern/shared')
    const token = 'b'.repeat(32)
    const row = await findByAddress(address)
    await fx.app.db
      .update(schema.subscribers)
      .set({ unsubscribeTokenHash: hashToken(token) })
      .where(eq(schema.subscribers.id, row!.id))

    const response = await fx.app.inject({ method: 'POST', url: `/api/v1/unsubscribe/${token}` })
    expect(response.statusCode).toBe(200)
    expect(await findByAddress(address)).toBeUndefined()

    // An unknown token answering differently would let someone probe which
    // unsubscribe links are live.
    const unknown = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/unsubscribe/${'c'.repeat(32)}`,
    })
    expect(unknown.statusCode).toBe(200)
    expect(unknown.json()).toEqual(response.json())
  })
})

describe('fan-out', () => {
  /**
   * Its own tenant. The tests above deliberately leave confirmed, unscoped
   * subscribers behind, and an unscoped subscriber receives every event by
   * design — so counting fan-out in the shared fixture would measure them.
   */
  let iso: TestFixture
  beforeAll(async () => {
    iso = await createFixture()
  }, 30_000)
  afterAll(async () => {
    await iso.cleanup()
  })

  const subscribeTo = (body: Record<string, unknown>) =>
    iso.app.inject({
      method: 'POST',
      url: `/api/v1/public/${iso.slug}/subscribers`,
      payload: body,
    })

  it('queues nothing for an unconfirmed subscriber', async () => {
    // Sending to an address that never agreed is how a status page becomes a
    // spam vector.
    await subscribeTo({ address: `never-confirmed-${Date.now()}@example.com` })

    const queued = await enqueueEvent(iso.app, {
      tenantId: iso.tenantId,
      eventType: 'incident.opened',
      payload: { title: 'Test' },
    })
    expect(queued).toBe(0)
  })

  it('respects a subscriber scoped to specific components', async () => {
    const scoped = `scoped-${Date.now()}@example.com`
    await subscribeTo({ address: scoped, scopeControlIds: [iso.controls.publicId] })

    const [row] = await iso.app.db
      .select()
      .from(schema.subscribers)
      .where(eq(schema.subscribers.addressHash, blindIndex(scoped, config.APP_SECRET)))
    await iso.app.db
      .update(schema.subscribers)
      .set({ confirmedAt: new Date() })
      .where(eq(schema.subscribers.id, row!.id))

    const unrelated = await enqueueEvent(iso.app, {
      tenantId: iso.tenantId,
      eventType: 'incident.opened',
      payload: {},
      controlIds: [iso.controls.privateId],
    })
    expect(unrelated).toBe(0)

    const relevant = await enqueueEvent(iso.app, {
      tenantId: iso.tenantId,
      eventType: 'incident.opened',
      payload: {},
      controlIds: [iso.controls.publicId],
    })
    expect(relevant).toBe(1)
  })
})

describe('admin visibility', () => {
  it('exposes counts, never addresses', async () => {
    // An admin has no operational reason to read subscriber addresses, and a
    // compromised admin account should not hand over a customer list.
    const cookie = await login(fx.app, fx.users.admin.email)
    const response = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/${fx.slug}/subscribers`,
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).not.toContain('@example.com')
    expect(response.json().total).toBeGreaterThan(0)
  })

  it('refuses a non-admin', async () => {
    const cookie = await login(fx.app, fx.users.member.email)
    const response = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/${fx.slug}/subscribers`,
      headers: { cookie },
    })
    expect(response.statusCode).toBe(403)
  })
})

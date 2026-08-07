import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schema } from '@tern/db'
import {
  blindIndex,
  buildUnsubscribeRef,
  encryptSecret,
  generateToken,
  hashToken,
} from '@tern/shared'
import { config } from '../config.js'
import { unsubscribeUrlFor } from '../services/transports.js'
import { createFixture, type TestFixture } from '../test/harness.js'

/**
 * Leaving the list.
 *
 * Nobody could. The address carried by both the `List-Unsubscribe` header and
 * the message body, `/u/<ref>`, matched no route — not in the API, and not in
 * the SPA's path matching either, so it fell through to the catch-all and served
 * the landing page. There was no test, which is how it stayed that way.
 */

let fx: TestFixture

beforeAll(async () => {
  fx = await createFixture()
}, 30_000)

afterAll(async () => {
  await fx.cleanup()
})

async function makeSubscriber(address: string) {
  const [row] = await fx.app.db
    .insert(schema.subscribers)
    .values({
      tenantId: fx.tenantId,
      channel: 'email',
      addressEnc: encryptSecret(address, config.APP_SECRET),
      addressHash: blindIndex(address, config.APP_SECRET),
      unsubscribeTokenHash: hashToken(generateToken(24)),
      confirmedAt: new Date(),
    })
    .returning()
  if (!row) throw new Error('failed to create subscriber')
  return row
}

const stillThere = async (id: string) =>
  (await fx.app.db.select().from(schema.subscribers).where(eq(schema.subscribers.id, id))).length >
  0

describe('the address in the mail', () => {
  it('points somewhere the API actually answers', async () => {
    const subscriber = await makeSubscriber('reader-a@test.local')
    const url = unsubscribeUrlFor(subscriber.id)

    // The bug this replaces: the URL used to be /u/<ref>, which matched no
    // route and fell through to the SPA's landing page.
    expect(url.startsWith(`${config.PUBLIC_BASE_URL}/api/v1/unsubscribe/`)).toBe(true)

    const path = url.slice(config.PUBLIC_BASE_URL.length)
    const response = await fx.app.inject({ method: 'GET', url: path })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
  })

  it('does not unsubscribe on a GET', async () => {
    // Mail clients and security appliances prefetch links. A GET that deleted
    // would unsubscribe readers who never clicked anything.
    const subscriber = await makeSubscriber('reader-b@test.local')
    const ref = buildUnsubscribeRef(subscriber.id, config.APP_SECRET)

    await fx.app.inject({ method: 'GET', url: `/api/v1/unsubscribe/${ref}` })
    expect(await stillThere(subscriber.id)).toBe(true)
  })

  it('unsubscribes on the button press', async () => {
    const subscriber = await makeSubscriber('reader-c@test.local')
    const ref = buildUnsubscribeRef(subscriber.id, config.APP_SECRET)

    const response = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/unsubscribe/${ref}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
      payload: '',
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('unsubscribed')
    expect(await stillThere(subscriber.id)).toBe(false)
  })

  it("accepts a provider's one-click POST", async () => {
    // RFC 8058: the body arrives urlencoded, which nothing else in this API
    // speaks. Without a parser Fastify answers 415 and the unsubscribe fails
    // silently for exactly the callers that matter.
    const subscriber = await makeSubscriber('reader-d@test.local')
    const ref = buildUnsubscribeRef(subscriber.id, config.APP_SECRET)

    const response = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/unsubscribe/${ref}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ unsubscribed: true })
    expect(await stillThere(subscriber.id)).toBe(false)
  })

  it('says the same thing about a token that never existed', async () => {
    // Answering differently would let someone probe which links are live.
    const response = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/unsubscribe/${'z'.repeat(40)}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    })
    expect(response.json()).toEqual({ unsubscribed: true })
  })
})

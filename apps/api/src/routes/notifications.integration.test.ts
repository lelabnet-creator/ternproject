import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

describe('mail settings', () => {
  it('reports the effective settings without handing over the credentials', async () => {
    const response = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/${fx.slug}/notifications/mail`,
      headers: { cookie: adminCookie },
    })
    expect(response.statusCode).toBe(200)

    const body = response.json()
    expect(body.host).toBeTruthy()
    expect(body.source).toBe('environment')
    // The presence of a username is operationally useful; its value is not, and
    // an admin screen is a fine place to be shoulder-read.
    expect(body).not.toHaveProperty('user')
    expect(body).not.toHaveProperty('password')
  })

  it('sends a test message through the real transport', async () => {
    // MailHog is up in CI and locally, so this exercises the actual path rather
    // than a mock that would keep passing after the transport broke.
    const response = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/notifications/mail/test`,
      headers: { cookie: adminCookie },
      payload: { to: 'ops@example.com' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().sent).toBe(true)
  })

  it('stores the weak-TLS allowance and hands it back, defaulting to off', async () => {
    // The relay this exists for cannot be stood up in a test — it would need a
    // server negotiating a 1024-bit Diffie-Hellman group. What is pinned here is
    // the part this repository owns: that the flag survives a round trip and is
    // absent-means-off, so a tenant is never quietly opted into a weaker
    // handshake by a missing key in a JSONB blob.
    const save = (allowWeakTls?: boolean) =>
      fx.app.inject({
        method: 'PATCH',
        url: `/api/v1/${fx.slug}/settings`,
        headers: { cookie: adminCookie },
        payload: {
          smtp: {
            host: 'localhost',
            port: 1025,
            secure: false,
            from: 'TERN <status@test.local>',
            ...(allowWeakTls === undefined ? {} : { allowWeakTls }),
          },
        },
      })

    const read = async () =>
      (
        await fx.app.inject({
          method: 'GET',
          url: `/api/v1/${fx.slug}/settings`,
          headers: { cookie: adminCookie },
        })
      ).json().smtp

    expect((await save()).statusCode).toBe(200)
    expect((await read()).allowWeakTls).toBe(false)

    expect((await save(true)).statusCode).toBe(200)
    expect((await read()).allowWeakTls).toBe(true)

    // And back off again: a setting that can only be turned on is a trap.
    expect((await save(false)).statusCode).toBe(200)
    expect((await read()).allowWeakTls).toBe(false)
  })

  it('still sends after the sender is changed, rather than using the cached transport', async () => {
    // `forgetTenantMailer` existed and nothing called it, so a tenant's cached
    // transporter outlived every settings change until the process restarted —
    // including the change somebody makes precisely because mail is failing.
    await fx.app.inject({
      method: 'PATCH',
      url: `/api/v1/${fx.slug}/settings`,
      headers: { cookie: adminCookie },
      payload: {
        smtp: {
          host: 'localhost',
          port: 1025,
          secure: false,
          from: 'TERN Changed <changed@test.local>',
        },
      },
    })

    const response = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/notifications/mail/test`,
      headers: { cookie: adminCookie },
      payload: { to: 'ops@example.com' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().sent).toBe(true)
  })
})

describe('outbound webhooks', () => {
  it('refuses an endpoint on this server’s own network', async () => {
    // A webhook URL is a request this server makes on an admin's behalf. The
    // first thing that gets tried is the cloud metadata address.
    for (const url of [
      'http://localhost:5432/',
      'http://127.0.0.1/hook',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/internal',
    ]) {
      const response = await fx.app.inject({
        method: 'POST',
        url: `/api/v1/${fx.slug}/notifications/webhooks`,
        headers: { cookie: adminCookie },
        payload: { url },
      })
      expect(response.statusCode, url).toBe(400)
    }
  })

  it('returns the signing secret once and never again', async () => {
    const created = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/notifications/webhooks`,
      headers: { cookie: adminCookie },
      payload: { url: 'https://hooks.example.com/tern' },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json().secret).toHaveLength(32)

    const listed = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/${fx.slug}/notifications/webhooks`,
      headers: { cookie: adminCookie },
    })
    const [hook] = listed.json()
    expect(hook.url).toBe('https://hooks.example.com/tern')
    expect(hook.hasSecret).toBe(true)
    expect(hook).not.toHaveProperty('secret')
  })

  it('removes one without touching another tenant’s', async () => {
    const other = await createFixture()
    try {
      const otherCookie = await login(other.app, other.users.admin.email)
      const theirs = await other.app.inject({
        method: 'POST',
        url: `/api/v1/${other.slug}/notifications/webhooks`,
        headers: { cookie: otherCookie },
        payload: { url: 'https://hooks.example.com/theirs' },
      })

      const cross = await fx.app.inject({
        method: 'DELETE',
        url: `/api/v1/${fx.slug}/notifications/webhooks/${theirs.json().id}`,
        headers: { cookie: adminCookie },
      })
      expect(cross.statusCode).toBe(404)
    } finally {
      await other.cleanup()
    }
  }, 30_000)
})

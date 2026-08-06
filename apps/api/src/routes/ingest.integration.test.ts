import { desc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schema } from '@tern/db'
import { issueApiKey } from '../services/apikeys.js'
import { createFixture, login, type TestFixture } from '../test/harness.js'

let fx: TestFixture
let ingestKey: string
let scopedKey: string
let autoRegisterKey: string

beforeAll(async () => {
  fx = await createFixture()

  ingestKey = (await issueApiKey(fx.app, { tenantId: fx.tenantId, name: 'test ingest' })).key
  scopedKey = (
    await issueApiKey(fx.app, {
      tenantId: fx.tenantId,
      name: 'scoped',
      scopeControlIds: [fx.controls.publicId],
    })
  ).key
  autoRegisterKey = (
    await issueApiKey(fx.app, { tenantId: fx.tenantId, name: 'auto', autoRegister: true })
  ).key
}, 30_000)

afterAll(async () => {
  await fx.cleanup()
})

const bearer = (key: string) => ({ authorization: `Bearer ${key}` })

async function latestCheck(controlId: string) {
  const [row] = await fx.app.db
    .select()
    .from(schema.checks)
    .where(eq(schema.checks.controlId, controlId))
    .orderBy(desc(schema.checks.ts))
    .limit(1)
  return row
}

describe('authentication', () => {
  it('refuses ingestion without a key', async () => {
    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/ingest',
      payload: { controlKey: 'public-api', status: 'operational' },
    })
    expect(response.statusCode).toBe(401)
  })

  it('refuses a key that does not exist', async () => {
    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/ingest',
      headers: bearer('tern_not-a-real-key'),
      payload: { controlKey: 'public-api', status: 'operational' },
    })
    expect(response.statusCode).toBe(401)
  })

  it('refuses a revoked key', async () => {
    const issued = await issueApiKey(fx.app, { tenantId: fx.tenantId, name: 'doomed' })
    await fx.app.db
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(schema.apiKeys.id, issued.id))

    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/ingest',
      headers: bearer(issued.key),
      payload: { controlKey: 'public-api', status: 'operational' },
    })
    expect(response.statusCode).toBe(401)
  })

  it('refuses a read-only key for ingestion', async () => {
    const readOnly = await issueApiKey(fx.app, {
      tenantId: fx.tenantId,
      name: 'read only',
      scopes: ['read'],
    })
    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/ingest',
      headers: bearer(readOnly.key),
      payload: { controlKey: 'public-api', status: 'operational' },
    })
    expect(response.statusCode).toBe(401)
  })
})

describe('ingest', () => {
  it('accepts a single point', async () => {
    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/ingest',
      headers: bearer(ingestKey),
      payload: { controlKey: 'public-api', status: 'degraded', latencyMs: 812, message: 'slow' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().accepted).toBe(1)

    const row = await latestCheck(fx.controls.publicId)
    expect(row?.status).toBe('degraded')
    expect(row?.latencyMs).toBe(812)
    expect(row?.message).toBe('slow')
  })

  it('accepts a batch', async () => {
    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/ingest',
      headers: bearer(ingestKey),
      payload: [
        { controlKey: 'public-api', status: 'operational', latencyMs: 40 },
        { controlKey: 'internal-job', status: 'operational', latencyMs: 900 },
      ],
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().accepted).toBe(2)
  })

  it('keeps the good points when one key in a batch is unknown', async () => {
    // A single typo in a fleet-wide push must not discard everyone else's data.
    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/ingest',
      headers: bearer(ingestKey),
      payload: [
        { controlKey: 'public-api', status: 'operational' },
        { controlKey: 'no-such-control', status: 'down' },
      ],
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().accepted).toBe(1)
    expect(response.json().rejected).toEqual([
      { controlKey: 'no-such-control', reason: 'unknown or out-of-scope control' },
    ])
  })

  it('rejects a control outside the key scope', async () => {
    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/ingest',
      headers: bearer(scopedKey),
      payload: { controlKey: 'internal-job', status: 'down' },
    })
    expect(response.json().accepted).toBe(0)
    expect(response.json().rejected).toHaveLength(1)
  })

  it('does not create controls unless the key allows it', async () => {
    await fx.app.inject({
      method: 'POST',
      url: '/api/v1/ingest',
      headers: bearer(ingestKey),
      payload: { controlKey: 'never-registered', status: 'operational' },
    })
    const [row] = await fx.app.db
      .select()
      .from(schema.controls)
      .where(eq(schema.controls.key, 'never-registered'))
    expect(row).toBeUndefined()
  })

  it('auto-registers a control as internal, never public', async () => {
    // A component appearing on a customer-facing page because of a typo is not
    // a recoverable mistake, so auto-registered controls start hidden.
    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/ingest',
      headers: bearer(autoRegisterKey),
      payload: { controlKey: 'newly-seen-service', status: 'operational' },
    })
    expect(response.json().accepted).toBe(1)

    const [row] = await fx.app.db
      .select()
      .from(schema.controls)
      .where(eq(schema.controls.key, 'newly-seen-service'))
    expect(row?.isPublic).toBe(false)
    expect(row?.name).toBe('Newly seen service')
  })

  it('clamps a wildly future timestamp to now', async () => {
    // A machine clock years ahead would otherwise file the point in a chunk
    // nobody queries — the check silently never appears, which is worse than
    // being visibly wrong.
    const future = new Date(Date.now() + 365 * 24 * 3600 * 1000)
    await fx.app.inject({
      method: 'POST',
      url: '/api/v1/ingest',
      headers: bearer(ingestKey),
      payload: { controlKey: 'public-api', status: 'operational', ts: future.toISOString() },
    })

    const row = await latestCheck(fx.controls.publicId)
    expect(row!.ts.getTime()).toBeLessThan(Date.now() + 60_000)
  })

  it('rejects a batch larger than the limit', async () => {
    const payload = Array.from({ length: 501 }, () => ({
      controlKey: 'public-api',
      status: 'operational' as const,
    }))
    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/ingest',
      headers: bearer(ingestKey),
      payload,
    })
    expect(response.statusCode).toBe(400)
  })
})

describe('heartbeat', () => {
  it('accepts a bare POST with no body', async () => {
    // The simplest possible client: one curl in a cron job, no JSON, no
    // dependency. If this needs a body, the first working check needs a
    // scripting language.
    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/heartbeat/public-api',
      headers: bearer(ingestKey),
    })
    expect(response.statusCode).toBe(200)

    const row = await latestCheck(fx.controls.publicId)
    expect(row?.status).toBe('operational')
  })

  it('takes status and latency from the query string', async () => {
    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/heartbeat/public-api?status=down&message=disk+full',
      headers: bearer(ingestKey),
    })
    expect(response.statusCode).toBe(200)

    const row = await latestCheck(fx.controls.publicId)
    expect(row?.status).toBe('down')
    expect(row?.message).toBe('disk full')
  })

  it('404s on an unknown control', async () => {
    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/heartbeat/not-a-control',
      headers: bearer(ingestKey),
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('tenant isolation', () => {
  it('cannot write to another tenant using its own control key', async () => {
    const other = await createFixture()
    try {
      // `other` has a control with the same key. The write must land in the
      // key's tenant or nowhere — never across the boundary.
      const response = await fx.app.inject({
        method: 'POST',
        url: '/api/v1/ingest',
        headers: bearer(ingestKey),
        payload: { controlKey: 'public-api', status: 'down' },
      })
      expect(response.json().accepted).toBe(1)

      const row = await latestCheck(other.controls.publicId)
      expect(row).toBeUndefined()
    } finally {
      await other.cleanup()
    }
  }, 30_000)
})

describe('session callers', () => {
  it('does not accept a browser session in place of an API key', async () => {
    // Ingestion is a machine path. Letting a logged-in admin's cookie write
    // measurements would make CSRF a data-integrity problem.
    const cookie = await login(fx.app, fx.users.admin.email)
    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/ingest',
      headers: { cookie },
      payload: { controlKey: 'public-api', status: 'down' },
    })
    expect(response.statusCode).toBe(401)
  })
})

describe('named metrics', () => {
  it('accepts a point carrying only metrics, and stores them', async () => {
    // A caller measuring three things should not have to pick the one field the
    // schema named first, nor invent a status it has no opinion about.
    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/ingest',
      headers: { authorization: `Bearer ${ingestKey}` },
      payload: {
        controlKey: 'public-api',
        metrics: { queueDepth: 42, tempC: 61.5 },
      },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().accepted).toBe(1)

    const [row] = await fx.app.db
      .select()
      .from(schema.checks)
      .where(eq(schema.checks.controlId, fx.controls.publicId))
      .orderBy(desc(schema.checks.ts))
      .limit(1)

    expect(row!.metrics).toEqual({ queueDepth: 42, tempC: 61.5 })
    // No status was sent and none was invented beyond the default.
    expect(row!.status).toBe('operational')
  })

  it('refuses a metric name that would not survive being a chart label', async () => {
    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/ingest',
      headers: { authorization: `Bearer ${ingestKey}` },
      payload: { controlKey: 'public-api', metrics: { '9lives': 1 } },
    })
    expect(response.statusCode).toBe(400)
  })

  it('still refuses a point that carries nothing at all', async () => {
    const response = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/ingest',
      headers: { authorization: `Bearer ${ingestKey}` },
      payload: { controlKey: 'public-api', metrics: {} },
    })
    expect(response.statusCode).toBe(400)
  })
})

import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

const create = (body: Record<string, unknown>) =>
  fx.app.inject({
    method: 'POST',
    url: `/api/v1/${fx.slug}/controls`,
    headers: { cookie: adminCookie },
    payload: { key: `c-${Date.now()}-${Math.floor(performance.now())}`, name: 'Test', ...body },
  })

describe('creating a control', () => {
  it('requires admin', async () => {
    const memberCookie = await login(fx.app, fx.users.member.email)
    const response = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/controls`,
      headers: { cookie: memberCookie },
      payload: { key: 'nope', name: 'Nope' },
    })
    // A user can communicate about incidents but not reconfigure what is
    // monitored.
    expect(response.statusCode).toBe(403)
  })

  it('constrains the key to what is safe in a URL, a script and an alert label', async () => {
    for (const key of ['Has Space', 'UPPER', 'quote"key', 'slash/key', '-leading']) {
      const response = await create({ key })
      expect(response.statusCode, `key ${key} should be rejected`).toBe(400)
    }
    expect((await create({ key: 'good.key_1-2' })).statusCode).toBe(201)
  })

  it('reports a duplicate key plainly', async () => {
    const key = `dupe-${Date.now()}`
    expect((await create({ key })).statusCode).toBe(201)

    const second = await create({ key })
    expect(second.statusCode).toBe(409)
    expect(second.json().message).toMatch(/already exists/i)
  })

  it('refuses a degraded threshold at or above the down threshold', async () => {
    // Otherwise the degraded band is unreachable: the control jumps straight
    // from healthy to down and the middle state silently never appears.
    const response = await create({ degradedThresholdMs: 3000, downThresholdMs: 1000 })
    expect(response.statusCode).toBe(400)
    expect(response.json().message).toMatch(/degraded/i)

    expect((await create({ degradedThresholdMs: 500, downThresholdMs: 3000 })).statusCode).toBe(201)
  })

  it('refuses a probe control with no usable probe configuration', async () => {
    // A non-push control without a valid probe would simply never run, and
    // nothing downstream would say why.
    const bad = await create({ kind: 'http', config: { method: 'GET' } })
    expect(bad.statusCode).toBe(400)

    const good = await create({
      kind: 'http',
      config: { url: 'https://example.com', assertions: [] },
    })
    expect(good.statusCode).toBe(201)
  })
})

describe('tenant isolation', () => {
  it('404s on a control belonging to another tenant', async () => {
    const other = await createFixture()
    try {
      const response = await fx.app.inject({
        method: 'PATCH',
        url: `/api/v1/${fx.slug}/controls/${other.controls.publicId}`,
        headers: { cookie: adminCookie },
        payload: { name: 'Hijacked' },
      })
      expect(response.statusCode).toBe(404)
    } finally {
      await other.cleanup()
    }
  }, 30_000)
})

describe('simulation', () => {
  it('marks generated rows synthetic so they cannot become an SLA figure', async () => {
    const created = await create({ key: `sim-${Date.now()}` })
    const id = created.json().id

    const response = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/controls/${id}/simulate`,
      headers: { cookie: adminCookie },
      payload: { days: 2, intervalS: 3600 },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().inserted).toBeGreaterThan(0)

    const rows = await fx.app.db.select().from(schema.checks).where(eq(schema.checks.controlId, id))
    expect(rows.length).toBeGreaterThan(0)
    // The continuous aggregates filter on this flag, so a demo can never leak
    // into a published uptime number.
    expect(rows.every((r) => r.synthetic)).toBe(true)
  })

  it('replaces rather than appends when run twice', async () => {
    const created = await create({ key: `sim2-${Date.now()}` })
    const id = created.json().id

    const simulate = (days: number) =>
      fx.app.inject({
        method: 'POST',
        url: `/api/v1/${fx.slug}/controls/${id}/simulate`,
        headers: { cookie: adminCookie },
        payload: { days, intervalS: 3600 },
      })

    await simulate(4)
    const second = await simulate(2)

    const rows = await fx.app.db.select().from(schema.checks).where(eq(schema.checks.controlId, id))

    // Running the simulation again with different settings should show the
    // second result, not both overlaid.
    expect(rows).toHaveLength(second.json().inserted)
  })

  it('purges simulation data in one call, leaving real data alone', async () => {
    const created = await create({ key: `sim3-${Date.now()}` })
    const id = created.json().id

    await fx.app.db.insert(schema.checks).values({
      tenantId: fx.tenantId,
      controlId: id,
      status: 'operational',
      synthetic: false,
    })
    await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/controls/${id}/simulate`,
      headers: { cookie: adminCookie },
      payload: { days: 1, intervalS: 3600 },
    })

    const purge = await fx.app.inject({
      method: 'DELETE',
      url: `/api/v1/${fx.slug}/controls/${id}/simulate`,
      headers: { cookie: adminCookie },
    })
    expect(purge.json().deleted).toBeGreaterThan(0)

    const left = await fx.app.db
      .select()
      .from(schema.checks)
      .where(and(eq(schema.checks.controlId, id), eq(schema.checks.synthetic, false)))
    expect(left).toHaveLength(1)
  })
})

describe('listing controls', () => {
  const listed = async (id: string) => {
    const response = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/${fx.slug}/controls`,
      headers: { cookie: adminCookie },
    })
    expect(response.statusCode).toBe(200)
    return response.json().find((c: { id: string }) => c.id === id)
  }

  it('reports nothing for a control that has never been checked', async () => {
    const id = (await create({ key: `quiet-${Date.now()}` })).json().id

    const row = await listed(id)
    expect(row.lastCheckAt).toBeNull()
    expect(row.lastCheckStatus).toBeNull()
    expect(row.lastSuccessAt).toBeNull()
    expect(row.lastFailureAt).toBeNull()
  })

  it('separates the last check from the last success and the last failure', async () => {
    const id = (await create({ key: `activity-${Date.now()}` })).json().id
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000)

    // Failed an hour ago, recovered, and is currently degraded: the three
    // timestamps must all differ, which is the whole reason for showing three.
    await fx.app.db.insert(schema.checks).values([
      { tenantId: fx.tenantId, controlId: id, status: 'down', ts: at(60) },
      { tenantId: fx.tenantId, controlId: id, status: 'operational', ts: at(30) },
      { tenantId: fx.tenantId, controlId: id, status: 'degraded', ts: at(1) },
    ])

    const row = await listed(id)
    expect(row.lastCheckStatus).toBe('degraded')
    expect(Date.parse(row.lastCheckAt)).toBeGreaterThan(Date.parse(row.lastSuccessAt))
    expect(Date.parse(row.lastSuccessAt)).toBeGreaterThan(Date.parse(row.lastFailureAt))
  })

  it('counts partial as a failure and degraded as neither', async () => {
    const id = (await create({ key: `partial-${Date.now()}` })).json().id
    await fx.app.db.insert(schema.checks).values([
      { tenantId: fx.tenantId, controlId: id, status: 'degraded', ts: new Date(Date.now() - 6e4) },
      { tenantId: fx.tenantId, controlId: id, status: 'partial', ts: new Date(Date.now() - 3e4) },
    ])

    const row = await listed(id)
    // Degraded is slow, not broken — counting it as a failure would reset
    // "last failure" on every busy afternoon.
    expect(row.lastFailureAt).not.toBeNull()
    expect(row.lastSuccessAt).toBeNull()
  })

  it('reports a check that is neither a success nor a failure, and why', async () => {
    // The scheduler's staleness marker. It is a real row with a real timestamp,
    // so the card shows a last check — while `unknown` counts as neither
    // outcome, which reads as a contradiction unless the status and its message
    // travel with it.
    const id = (await create({ key: `stale-${Date.now()}` })).json().id
    await fx.app.db.insert(schema.checks).values({
      tenantId: fx.tenantId,
      controlId: id,
      status: 'unknown',
      message: 'No data received within the expected interval',
    })

    const row = await listed(id)
    expect(row.lastCheckAt).not.toBeNull()
    expect(row.lastCheckStatus).toBe('unknown')
    expect(row.lastCheckMessage).toMatch(/no data received/i)
    expect(row.lastSuccessAt).toBeNull()
    expect(row.lastFailureAt).toBeNull()
  })

  it('ignores simulated history', async () => {
    const id = (await create({ key: `sim-activity-${Date.now()}` })).json().id
    await fx.app.db.insert(schema.checks).values({
      tenantId: fx.tenantId,
      controlId: id,
      status: 'down',
      synthetic: true,
    })

    // A demo outage must never show up as the moment this control last broke.
    const row = await listed(id)
    expect(row.lastFailureAt).toBeNull()
    expect(row.lastCheckAt).toBeNull()
  })
})

describe('forcing a check', () => {
  const force = (id: string, cookie = adminCookie) =>
    fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/controls/${id}/check`,
      headers: { cookie },
    })

  it('records what it measured, so the control stops sitting at unknown', async () => {
    const id = (
      await create({
        key: `forced-${Date.now()}`,
        kind: 'http',
        // Nothing listens here, so the probe fails — which is a real outcome
        // and exactly what has to be recorded. The point of the test is that a
        // row appears, not which colour it is.
        config: { url: 'http://127.0.0.1:9/nothing', assertions: [] },
      })
    ).json().id

    const before = await fx.app.db
      .select()
      .from(schema.checks)
      .where(eq(schema.checks.controlId, id))
    expect(before).toHaveLength(0)

    const response = await force(id)
    expect(response.statusCode).toBe(200)
    expect(response.json().at).toBeTruthy()

    const after = await fx.app.db
      .select()
      .from(schema.checks)
      .where(eq(schema.checks.controlId, id))
    expect(after).toHaveLength(1)
    expect(after[0]!.synthetic).toBe(false)
    expect(after[0]!.status).toBe(response.json().status)
  })

  it('refuses a pushed control, which has no probe to run', async () => {
    const id = (await create({ key: `pushed-${Date.now()}`, kind: 'push' })).json().id

    const response = await force(id)
    expect(response.statusCode).toBe(400)
    expect(response.json().message).toMatch(/pushed to/i)

    // And nothing was written for it.
    const rows = await fx.app.db.select().from(schema.checks).where(eq(schema.checks.controlId, id))
    expect(rows).toHaveLength(0)
  })

  it('refuses a disabled control rather than putting a point on a stopped series', async () => {
    const id = (
      await create({
        key: `off-${Date.now()}`,
        kind: 'http',
        config: { url: 'http://127.0.0.1:9/nothing', assertions: [] },
      })
    ).json().id

    // Set on the row rather than through the API: `enabled` is not part of any
    // request body today, but `local-probes` already skips on it, so the state
    // is reachable and the endpoint has to handle it.
    await fx.app.db
      .update(schema.controls)
      .set({ enabled: false })
      .where(eq(schema.controls.id, id))

    const response = await force(id)
    expect(response.statusCode).toBe(400)
    expect(response.json().message).toMatch(/disabled/i)
  })

  it('requires admin', async () => {
    const id = (
      await create({
        key: `perm-${Date.now()}`,
        kind: 'http',
        config: { url: 'http://127.0.0.1:9/nothing', assertions: [] },
      })
    ).json().id

    const memberCookie = await login(fx.app, fx.users.member.email)
    expect((await force(id, memberCookie)).statusCode).toBe(403)
  })
})

describe('script generation', () => {
  it('returns all ten languages with the control key and thresholds baked in', async () => {
    const created = await create({
      key: `scripted-${Date.now()}`,
      degradedThresholdMs: 750,
      downThresholdMs: 4000,
    })
    const id = created.json().id
    const key = created.json().key

    const response = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/${fx.slug}/controls/${id}/scripts`,
      headers: { cookie: adminCookie },
    })
    expect(response.statusCode).toBe(200)

    const body = response.json()
    expect(body.languages).toHaveLength(10)
    for (const language of body.languages) {
      const script: string = body.scripts[language.id]
      expect(script, language.id).toContain(key)
      expect(script, language.id).toContain('750')
      expect(script, language.id).toContain('4000')
    }
  })

  it('inlines a placeholder rather than pretending it can recover a stored key', async () => {
    // Existing keys are stored only as hashes. Returning anything that looked
    // like a real key here would be a lie.
    const created = await create({ key: `placeholder-${Date.now()}` })
    const response = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/${fx.slug}/controls/${created.json().id}/scripts`,
      headers: { cookie: adminCookie },
    })
    expect(response.json().scripts.python).toContain('tern_YOUR_API_KEY')
  })

  it('generates a measurement script when the control is drawn as a value', async () => {
    // The widget chosen in the editor decides the payload. Without this, someone
    // picks a bullet chart, copies the script it offers, gets 200s back, and
    // watches an empty graph — the worst kind of failure, because everything
    // reports success.
    const created = await create({
      key: `valued-${Date.now()}`,
      widget: 'value-bullet',
      valueUnit: 'jobs',
      valueLabel: 'Pending jobs',
    })

    const response = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/${fx.slug}/controls/${created.json().id}/scripts`,
      headers: { cookie: adminCookie },
    })
    expect(response.statusCode).toBe(200)

    const scripts = response.json().scripts as Record<string, string>
    for (const [id, script] of Object.entries(scripts)) {
      // Each language spells the field its own way (`payload.value`,
      // `$payload.value`, `"value":`), so the assertion is on the field name.
      // The value label is the discriminator: it appears only in this shape,
      // so its presence proves the route passed the widget's shape through.
      expect(script, id).toMatch(/\bvalue\b/)
      expect(script, id).toContain('Pending jobs')
    }
  })
})

describe('probe dry run', () => {
  it('reports a connection failure as down with the reason', async () => {
    // Port 9 on localhost refuses; the message must name that rather than say
    // "check failed".
    const response = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/probe/run`,
      headers: { cookie: adminCookie },
      payload: {
        probe: { type: 'tcp', host: '127.0.0.1', port: 9, timeoutMs: 2000, assertions: [] },
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().status).toBe('down')
    expect(response.json().message).toBeTruthy()
  }, 15_000)

  it('does not return the raw response body', async () => {
    // `debug` can hold a full response, and this endpoint is reachable by
    // anyone who can edit a control.
    const response = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/probe/run`,
      headers: { cookie: adminCookie },
      payload: {
        probe: { type: 'tcp', host: '127.0.0.1', port: 9, timeoutMs: 2000, assertions: [] },
      },
    })
    expect(response.json().debug).toBeUndefined()
  }, 15_000)
})

describe('page layout', () => {
  it('applies a density and a total order in one call', async () => {
    const a = (await create({ key: `lay-a-${Date.now()}` })).json().id
    const b = (await create({ key: `lay-b-${Date.now()}` })).json().id

    const response = await fx.app.inject({
      method: 'PATCH',
      url: `/api/v1/${fx.slug}/layout`,
      headers: { cookie: adminCookie },
      payload: { layout: 'grid', order: [{ controlId: b }, { controlId: a }] },
    })
    expect(response.statusCode).toBe(200)

    const [tenant] = await fx.app.db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, fx.tenantId))
    expect(tenant!.layout).toBe('grid')

    const rows = await fx.app.db
      .select({ id: schema.controls.id, position: schema.controls.position })
      .from(schema.controls)
      .where(eq(schema.controls.tenantId, fx.tenantId))
    const positionOf = (id: string) => rows.find((r) => r.id === id)!.position
    // Renumbered from zero server-side, so a client that sends duplicate or
    // sparse positions still produces a total order.
    expect(positionOf(b)).toBeLessThan(positionOf(a))
  })

  it('moves nothing when one id in the order belongs to another tenant', async () => {
    const mine = (await create({ key: `lay-mine-${Date.now()}` })).json().id
    const before = await fx.app.db
      .select({ position: schema.controls.position })
      .from(schema.controls)
      .where(eq(schema.controls.id, mine))

    const other = await createFixture()
    try {
      const response = await fx.app.inject({
        method: 'PATCH',
        url: `/api/v1/${fx.slug}/layout`,
        headers: { cookie: adminCookie },
        payload: { order: [{ controlId: mine }, { controlId: other.controls.publicId }] },
      })
      expect(response.statusCode).toBe(404)
    } finally {
      await other.cleanup()
    }

    // The point of validating before the transaction: a rejected request must
    // not leave the first few controls already moved.
    const after = await fx.app.db
      .select({ position: schema.controls.position })
      .from(schema.controls)
      .where(eq(schema.controls.id, mine))
    expect(after[0]!.position).toBe(before[0]!.position)
  }, 30_000)

  it('refuses a member, who can communicate but not rearrange the page', async () => {
    const memberCookie = await login(fx.app, fx.users.member.email)
    const response = await fx.app.inject({
      method: 'PATCH',
      url: `/api/v1/${fx.slug}/layout`,
      headers: { cookie: memberCookie },
      payload: { layout: 'compact' },
    })
    expect(response.statusCode).toBe(403)
  })
})

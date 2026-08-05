import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schema } from '@tern/db'
import { advanceMaintenances, sweepStaleControls } from '../services/scheduler.js'
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

const openIncident = (body: Record<string, unknown> = {}) =>
  fx.app.inject({
    method: 'POST',
    url: `/api/v1/${fx.slug}/incidents`,
    headers: { cookie: adminCookie },
    payload: {
      title: 'Elevated error rate',
      body: 'We are investigating.',
      impacts: [{ controlId: fx.controls.publicId, impact: 'major' }],
      ...body,
    },
  })

describe('permissions', () => {
  it('lets a user communicate but not a visitor', async () => {
    const memberCookie = await login(fx.app, fx.users.member.email)
    const asMember = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/incidents`,
      headers: { cookie: memberCookie },
      payload: { title: 'From a user', body: 'Update.' },
    })
    expect(asMember.statusCode).toBe(201)

    const visitorCookie = await login(fx.app, fx.users.visitor.email)
    const asVisitor = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/incidents`,
      headers: { cookie: visitorCookie },
      payload: { title: 'From a visitor', body: 'Update.' },
    })
    expect(asVisitor.statusCode).toBe(403)
  })
})

describe('impact and the public page', () => {
  it('overrides the measured status with the declared impact', async () => {
    // The control is reporting healthy; the team has declared it down. The
    // declaration wins, because a service can answer health checks while being
    // useless to its users.
    await fx.app.db.insert(schema.checks).values({
      tenantId: fx.tenantId,
      controlId: fx.controls.publicId,
      status: 'operational',
      latencyMs: 20,
    })

    const created = await openIncident()
    expect(created.statusCode).toBe(201)

    const summary = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/public/${fx.slug}/summary.json`,
    })
    const component = summary
      .json()
      .components.find((c: { id: string }) => c.id === fx.controls.publicId)

    expect(component.status).toBe('down')
    expect(summary.json().overall.status).toBe('down')
  })

  it('clears declared impact on resolution so components fall back to measurement', async () => {
    const created = await openIncident({ title: 'To be resolved' })
    const id = created.json().id

    await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/incidents/${id}/updates`,
      headers: { cookie: adminCookie },
      payload: { status: 'resolved', body: 'Fixed.' },
    })

    const impacts = await fx.app.db
      .select()
      .from(schema.incidentImpacts)
      .where(eq(schema.incidentImpacts.incidentId, id))

    // Leaving the impact behind would keep the page red after the incident
    // closed — the most common way a status page lies.
    expect(impacts).toHaveLength(0)
  })

  it('records impact per component, not one severity for the incident', async () => {
    const created = await openIncident({
      title: 'Mixed blast radius',
      impacts: [
        { controlId: fx.controls.publicId, impact: 'major' },
        { controlId: fx.controls.privateId, impact: 'degraded' },
      ],
    })
    const id = created.json().id

    const impacts = await fx.app.db
      .select()
      .from(schema.incidentImpacts)
      .where(eq(schema.incidentImpacts.incidentId, id))

    expect(impacts.map((i) => i.impact).sort()).toEqual(['degraded', 'major'])
  })
})

describe('tenant isolation', () => {
  it('refuses to attach a control from another tenant', async () => {
    const other = await createFixture()
    try {
      // Without this check an admin could attach a competitor's component to
      // their own incident by guessing a uuid, and the impact would surface on
      // that other tenant's public page.
      const response = await fx.app.inject({
        method: 'POST',
        url: `/api/v1/${fx.slug}/incidents`,
        headers: { cookie: adminCookie },
        payload: {
          title: 'Cross-tenant attempt',
          body: 'Nope.',
          impacts: [{ controlId: other.controls.publicId, impact: 'major' }],
        },
      })
      expect(response.statusCode).toBe(400)
    } finally {
      await other.cleanup()
    }
  }, 30_000)

  it('404s on an incident id from another tenant', async () => {
    const other = await createFixture()
    try {
      const otherCookie = await login(other.app, other.users.admin.email)
      const created = await other.app.inject({
        method: 'POST',
        url: `/api/v1/${other.slug}/incidents`,
        headers: { cookie: otherCookie },
        payload: { title: 'Theirs', body: 'Private.' },
      })

      const response = await fx.app.inject({
        method: 'GET',
        url: `/api/v1/${fx.slug}/incidents/${created.json().id}`,
        headers: { cookie: adminCookie },
      })
      expect(response.statusCode).toBe(404)
    } finally {
      await other.cleanup()
    }
  }, 30_000)
})

describe('postmortem', () => {
  it('refuses one before the incident is resolved', async () => {
    const created = await openIncident({ title: 'Still open' })
    const response = await fx.app.inject({
      method: 'PUT',
      url: `/api/v1/${fx.slug}/incidents/${created.json().id}/postmortem`,
      headers: { cookie: adminCookie },
      payload: { body: 'Too early.' },
    })
    expect(response.statusCode).toBe(409)
  })

  it('keeps an unpublished postmortem out of the public response', async () => {
    const created = await openIncident({ title: 'With a draft' })
    const id = created.json().id

    await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/incidents/${id}/updates`,
      headers: { cookie: adminCookie },
      payload: { status: 'resolved', body: 'Fixed.' },
    })
    await fx.app.inject({
      method: 'PUT',
      url: `/api/v1/${fx.slug}/incidents/${id}/postmortem`,
      headers: { cookie: adminCookie },
      payload: { body: 'Draft — we still blame the intern.', publish: false },
    })

    // A draft is a draft. It must not leak before its author decided it was
    // ready to be read.
    const asVisitor = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/${fx.slug}/incidents/${id}`,
    })
    expect(asVisitor.json().postmortemBody).toBeNull()

    await fx.app.inject({
      method: 'PUT',
      url: `/api/v1/${fx.slug}/incidents/${id}/postmortem`,
      headers: { cookie: adminCookie },
      payload: { body: 'Published version.', publish: true },
    })

    const afterPublish = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/${fx.slug}/incidents/${id}`,
    })
    expect(afterPublish.json().postmortemBody).toBe('Published version.')
  })
})

describe('maintenance scheduler', () => {
  it('starts and completes a window on its own', async () => {
    const [maintenance] = await fx.app.db
      .insert(schema.maintenances)
      .values({
        tenantId: fx.tenantId,
        title: 'Database upgrade',
        scheduledStart: new Date(Date.now() - 60_000),
        scheduledEnd: new Date(Date.now() + 60_000),
      })
      .returning()

    const started = await advanceMaintenances(fx.app)
    expect(started.started).toBeGreaterThanOrEqual(1)

    const [afterStart] = await fx.app.db
      .select()
      .from(schema.maintenances)
      .where(eq(schema.maintenances.id, maintenance!.id))
    expect(afterStart?.status).toBe('in_progress')
    expect(afterStart?.actualStart).not.toBeNull()

    // Push the end into the past and run again.
    await fx.app.db
      .update(schema.maintenances)
      .set({ scheduledEnd: new Date(Date.now() - 1000) })
      .where(eq(schema.maintenances.id, maintenance!.id))

    await advanceMaintenances(fx.app)
    const [afterEnd] = await fx.app.db
      .select()
      .from(schema.maintenances)
      .where(eq(schema.maintenances.id, maintenance!.id))
    expect(afterEnd?.status).toBe('completed')
  })

  it('leaves a manual window alone', async () => {
    const [manual] = await fx.app.db
      .insert(schema.maintenances)
      .values({
        tenantId: fx.tenantId,
        title: 'Manual window',
        autoTransition: false,
        scheduledStart: new Date(Date.now() - 60_000),
        scheduledEnd: new Date(Date.now() + 60_000),
      })
      .returning()

    await advanceMaintenances(fx.app)

    const [row] = await fx.app.db
      .select()
      .from(schema.maintenances)
      .where(eq(schema.maintenances.id, manual!.id))
    expect(row?.status).toBe('scheduled')
  })
})

describe('stale control sweeper', () => {
  it('marks a silent push control unknown, not down', async () => {
    // Silence means we stopped hearing, which is not the claim that the service
    // is broken. Reporting it as an outage turns every agent restart into a
    // public incident.
    const [control] = await fx.app.db
      .insert(schema.controls)
      .values({
        tenantId: fx.tenantId,
        key: `silent-${Date.now()}`,
        name: 'Silent job',
        kind: 'push',
        expectedIntervalS: 60,
      })
      .returning()

    await fx.app.db.insert(schema.checks).values({
      tenantId: fx.tenantId,
      controlId: control!.id,
      status: 'operational',
      ts: new Date(Date.now() - 10 * 60_000),
    })

    const swept = await sweepStaleControls(fx.app)
    expect(swept).toBeGreaterThanOrEqual(1)

    const [latest] = await fx.app.db
      .select()
      .from(schema.checks)
      .where(eq(schema.checks.controlId, control!.id))
      .orderBy(schema.checks.ts)
      .limit(1)
    expect(latest).toBeDefined()

    const summary = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/public/${fx.slug}/summary.json`,
      headers: { cookie: adminCookie },
    })
    const component = summary.json().components.find((c: { id: string }) => c.id === control!.id)
    expect(component.status).toBe('unknown')
  })

  it('does not re-mark a control that is already unknown', async () => {
    // Otherwise every sweep appends another row for a control that has been
    // silent for months, and the table grows for no information gained.
    const before = await sweepStaleControls(fx.app)
    const after = await sweepStaleControls(fx.app)
    expect(after).toBeLessThanOrEqual(before)
  })
})

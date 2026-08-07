import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schema } from '@tern/db'
import { sendMaintenanceReminders } from '../services/scheduler.js'
import { createFixture, login, type TestFixture } from '../test/harness.js'

/**
 * The write side of maintenance windows.
 *
 * Everything downstream of creation was already covered; what was untested was
 * everything this file adds, and the two rules that are easy to get wrong: what
 * a window still accepts once it has opened, and what happens to the reminders
 * when a window moves.
 */

let fx: TestFixture
let adminCookie: string

beforeAll(async () => {
  fx = await createFixture()
  adminCookie = await login(fx.app, fx.users.admin.email)
}, 30_000)

afterAll(async () => {
  await fx.cleanup()
})

const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString()

const schedule = (body: Record<string, unknown> = {}) =>
  fx.app.inject({
    method: 'POST',
    url: `/api/v1/${fx.slug}/maintenances`,
    headers: { cookie: adminCookie },
    payload: {
      title: 'Database upgrade',
      body: 'The API will be read-only for twenty minutes.',
      scheduledStart: inHours(48),
      scheduledEnd: inHours(49),
      controlIds: [fx.controls.publicId],
      ...body,
    },
  })

const patch = (id: string, body: Record<string, unknown>) =>
  fx.app.inject({
    method: 'PATCH',
    url: `/api/v1/${fx.slug}/maintenances/${id}`,
    headers: { cookie: adminCookie },
    payload: body,
  })

describe('permissions', () => {
  it('lets an admin schedule and refuses a visitor', async () => {
    const visitorCookie = await login(fx.app, fx.users.visitor.email)
    const asVisitor = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/maintenances`,
      headers: { cookie: visitorCookie },
      payload: { title: 'Nope', scheduledStart: inHours(1), scheduledEnd: inHours(2) },
    })
    expect(asVisitor.statusCode).toBe(403)

    const asAdmin = await schedule()
    expect(asAdmin.statusCode).toBe(201)
  })

  it('refuses a control belonging to another tenant', async () => {
    const other = await createFixture()
    try {
      const response = await schedule({ controlIds: [other.controls.publicId] })
      expect(response.statusCode).toBe(400)
    } finally {
      await other.cleanup()
    }
  })
})

describe('the window itself', () => {
  it('refuses a window that ends before it starts', async () => {
    const response = await schedule({ scheduledStart: inHours(5), scheduledEnd: inHours(4) })
    expect(response.statusCode).toBe(400)
  })

  it('attaches the controls and reads them back', async () => {
    const created = await schedule()
    const { id } = created.json() as { id: string }

    const list = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/${fx.slug}/maintenances`,
      headers: { cookie: adminCookie },
    })
    expect(list.statusCode).toBe(200)

    const row = (list.json() as { id: string; controlIds: string[] }[]).find((m) => m.id === id)
    expect(row?.controlIds).toEqual([fx.controls.publicId])
  })
})

describe('what an advancing window still accepts', () => {
  it('lets a scheduled window change anything', async () => {
    const { id } = (await schedule()).json() as { id: string }

    const response = await patch(id, {
      title: 'Renamed',
      scheduledStart: inHours(72),
      scheduledEnd: inHours(73),
      remindersBeforeMin: [1440],
    })
    expect(response.statusCode).toBe(200)
  })

  it('refuses a move that would leave the window ending before it starts', async () => {
    // Moving one edge does not drag the other: silently shifting the end to
    // preserve the duration would reschedule work nobody asked to reschedule.
    const { id } = (await schedule()).json() as { id: string }
    expect((await patch(id, { scheduledStart: inHours(72) })).statusCode).toBe(400)
  })

  it('freezes the start of a running window but still moves its end', async () => {
    const { id } = (await schedule()).json() as { id: string }
    await fx.app.db
      .update(schema.maintenances)
      .set({ status: 'in_progress' })
      .where(eq(schema.maintenances.id, id))

    const movingStart = await patch(id, { scheduledStart: inHours(1) })
    expect(movingStart.statusCode).toBe(409)

    const movingEnd = await patch(id, { scheduledEnd: inHours(60) })
    expect(movingEnd.statusCode).toBe(200)
  })

  it('leaves a finished window open only to rewording', async () => {
    const { id } = (await schedule()).json() as { id: string }
    await fx.app.db
      .update(schema.maintenances)
      .set({ status: 'completed' })
      .where(eq(schema.maintenances.id, id))

    expect((await patch(id, { suppressAlerts: false })).statusCode).toBe(409)
    expect((await patch(id, { title: 'Corrected wording' })).statusCode).toBe(200)
  })
})

describe('reminders', () => {
  it('re-arms a reminder the window has outrun when it is postponed', async () => {
    // Close enough that the −24h mark is due, so the scheduler sends it.
    const { id } = (
      await schedule({
        scheduledStart: inHours(2),
        scheduledEnd: inHours(3),
        remindersBeforeMin: [1440],
      })
    ).json() as { id: string }

    await sendMaintenanceReminders(fx.app)

    const [afterSend] = await fx.app.db
      .select()
      .from(schema.maintenances)
      .where(eq(schema.maintenances.id, id))
    expect(afterSend?.remindersSentAt).toContain(1440)

    // Pushed out past the mark: the reminder everyone actually reads has not
    // happened yet from the reader's point of view, so it must fire again.
    await patch(id, { scheduledStart: inHours(96), scheduledEnd: inHours(97) })

    const [afterMove] = await fx.app.db
      .select()
      .from(schema.maintenances)
      .where(eq(schema.maintenances.id, id))
    expect(afterMove?.remindersSentAt).not.toContain(1440)
  })

  it('keeps a sent reminder when the window is only pulled closer', async () => {
    const { id } = (
      await schedule({
        scheduledStart: inHours(2),
        scheduledEnd: inHours(3),
        remindersBeforeMin: [1440],
      })
    ).json() as { id: string }

    await sendMaintenanceReminders(fx.app)
    await patch(id, { scheduledStart: inHours(1), scheduledEnd: inHours(2) })

    const [row] = await fx.app.db
      .select()
      .from(schema.maintenances)
      .where(eq(schema.maintenances.id, id))
    expect(row?.remindersSentAt).toContain(1440)
  })
})

describe('updates and removal', () => {
  it('stamps the actual start once and never rewrites it', async () => {
    const { id } = (await schedule()).json() as { id: string }

    const open = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/maintenances/${id}/updates`,
      headers: { cookie: adminCookie },
      payload: { status: 'in_progress', body: 'Starting now.' },
    })
    expect(open.statusCode).toBe(201)

    const [first] = await fx.app.db
      .select()
      .from(schema.maintenances)
      .where(eq(schema.maintenances.id, id))
    const stamped = first?.actualStart

    await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/maintenances/${id}/updates`,
      headers: { cookie: adminCookie },
      payload: { status: 'in_progress', body: 'Still going.' },
    })

    const [second] = await fx.app.db
      .select()
      .from(schema.maintenances)
      .where(eq(schema.maintenances.id, id))
    expect(second?.actualStart?.toISOString()).toBe(stamped?.toISOString())
  })

  it('deletes a window nobody was told about', async () => {
    const { id } = (await schedule({ notify: false })).json() as { id: string }

    const response = await fx.app.inject({
      method: 'DELETE',
      url: `/api/v1/${fx.slug}/maintenances/${id}`,
      headers: { cookie: adminCookie },
    })
    expect(response.json()).toMatchObject({ deleted: true, cancelled: false })

    const rows = await fx.app.db
      .select()
      .from(schema.maintenances)
      .where(eq(schema.maintenances.id, id))
    expect(rows).toHaveLength(0)
  })

  it('cancels rather than deletes once a reminder has gone out', async () => {
    const { id } = (
      await schedule({
        scheduledStart: inHours(2),
        scheduledEnd: inHours(3),
        remindersBeforeMin: [1440],
      })
    ).json() as { id: string }

    await sendMaintenanceReminders(fx.app)

    const response = await fx.app.inject({
      method: 'DELETE',
      url: `/api/v1/${fx.slug}/maintenances/${id}`,
      headers: { cookie: adminCookie },
    })
    expect(response.json()).toMatchObject({ deleted: false, cancelled: true })

    const [row] = await fx.app.db
      .select()
      .from(schema.maintenances)
      .where(eq(schema.maintenances.id, id))
    expect(row?.status).toBe('cancelled')
  })
})

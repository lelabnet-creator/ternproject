import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFixture, login, type TestFixture } from '../test/harness.js'

/**
 * What the public summary says, beyond which tiles are red.
 *
 * The endpoint has always carried open incidents and maintenance windows and
 * nothing rendered them, so nothing tested them either. These pin the three
 * things that were wrong once something finally read the fields.
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

const summary = async () =>
  (
    await fx.app.inject({ method: 'GET', url: `/api/v1/public/${fx.slug}/summary.json` })
  ).json() as {
    incidents: { title: string; latestUpdate: { body: string } | null }[]
    maintenances: { title: string; status: string; controlIds: string[] }[]
    components: { id: string; status: string }[]
  }

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()

describe('incidents', () => {
  it('carries the latest update on an open one', async () => {
    await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/incidents`,
      headers: { cookie: adminCookie },
      payload: { title: 'Checkout failing', body: 'First word.', severity: 'major' },
    })

    const incident = (await summary()).incidents.find((i) => i.title === 'Checkout failing')
    // A page that names an incident without saying what is happening sends the
    // reader somewhere else to find out, which is the moment it has failed.
    expect(incident?.latestUpdate?.body).toBe('First word.')
  })
})

describe('maintenance windows', () => {
  it('announces one before it opens', async () => {
    const created = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/maintenances`,
      headers: { cookie: adminCookie },
      payload: {
        title: 'Window one',
        scheduledStart: inHours(24),
        scheduledEnd: inHours(25),
        controlIds: [fx.controls.publicId],
        notify: false,
      },
    })
    expect(created.statusCode).toBe(201)

    // Only `in_progress` used to be loaded, so planned work first appeared on
    // the page at the moment it began — announcing it in advance being the
    // entire reason the window exists.
    const window = (await summary()).maintenances.find((m) => m.title === 'Window one')
    expect(window?.status).toBe('scheduled')
  })

  it('gives each window its own components', async () => {
    await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/maintenances`,
      headers: { cookie: adminCookie },
      payload: {
        title: 'Window two',
        scheduledStart: inHours(48),
        scheduledEnd: inHours(49),
        controlIds: [],
        notify: false,
      },
    })

    const all = (await summary()).maintenances
    const one = all.find((m) => m.title === 'Window one')
    const two = all.find((m) => m.title === 'Window two')

    // This used to hand every window the union of all of them, so two windows
    // on one page each claimed the other's components.
    expect(one?.controlIds).toEqual([fx.controls.publicId])
    expect(two?.controlIds).toEqual([])
  })

  it('does not paint a component blue for work scheduled next week', async () => {
    // Suppression follows what is running, not what is announced.
    const component = (await summary()).components.find((c) => c.id === fx.controls.publicId)
    expect(component?.status).not.toBe('maintenance')
  })
})

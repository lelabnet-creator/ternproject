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

/**
 * The availability figure, end to end.
 *
 * `uptime.json` had no test at all — the endpoint that publishes the number the
 * whole ribbon is built from, and the one this change rewrote. The unit suite
 * pins what the rules mean; nothing ran the SQL that feeds them, which is
 * exactly how a malformed query ships green.
 *
 * These write real checks, refresh the real continuous aggregate, and read the
 * real endpoint.
 */
describe('uptime.json', () => {
  const MINUTE = 60_000

  /** Minute-by-minute checks over the last `minutes`, with a contiguous outage. */
  async function seedChecks(minutes: number, outage: { from: number; to: number }) {
    const now = Date.now()
    const rows: { ts: string; status: 'operational' | 'down' }[] = []
    for (let age = minutes; age > 0; age--) {
      rows.push({
        ts: new Date(now - age * MINUTE).toISOString(),
        status: age > outage.from && age <= outage.to ? 'down' : 'operational',
      })
    }

    // One statement rather than a hundred and eighty: a round trip per check
    // put half a minute on every run of the suite, for nothing.
    await fx.app.sql`
      INSERT INTO checks (ts, tenant_id, control_id, status, latency_ms)
      SELECT v.ts::timestamptz, ${fx.tenantId}::uuid, ${fx.controls.publicId}::uuid,
             v.status::check_status, 100
        FROM json_to_recordset(${JSON.stringify(rows)}::json)
          AS v(ts text, status text)
    `

    // The endpoint reads the aggregate, not the table. Without this the query
    // is correct and returns nothing, which is the failure that looks like a
    // passing test.
    await fx.app.sql.unsafe(`CALL refresh_continuous_aggregate('checks_1m', NULL, NULL)`)
  }

  it('weights an outage by its duration, and says which resolution answered', async () => {
    // Three hours of history with a ten-minute outage in the middle of it.
    await seedChecks(180, { from: 60, to: 70 })

    const response = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/public/${fx.slug}/uptime.json?period=24h`,
    })
    expect(response.statusCode).toBe(200)

    const body = response.json() as {
      resolution: string
      days: { controlId: string; uptimePct: number | null; samples: number }[]
    }

    // Declared rather than implicit: a reader comparing two windows deserves to
    // know which one is sharper.
    expect(body.resolution).toBe('checks_1m')

    const mine = body.days.filter((d) => d.controlId === fx.controls.publicId)
    expect(mine.length).toBeGreaterThan(0)

    const measured = mine.reduce((sum, d) => sum + d.samples, 0)
    expect(measured).toBeGreaterThan(0)

    /*
     * Ten minutes out of the time actually observed. Not `10/1440`: the rest of
     * the day has no buckets, and unobserved time leaves the denominator rather
     * than being credited as available — which is the difference between an
     * honest figure and a flattering one.
     */
    const worst = mine.reduce(
      (low, d) => (d.uptimePct !== null && d.uptimePct < low ? d.uptimePct : low),
      100,
    )
    expect(worst).toBeLessThan(100)
    expect(worst).toBeGreaterThan(80)
  }, 60_000)
})

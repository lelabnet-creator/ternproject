import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schema } from '@tern/db'
import { __testables as badge } from './badge.js'
import { __testables as feeds } from './feeds.js'
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

describe('badge rendering', () => {
  it('escapes markup in a component name', () => {
    // Names are tenant-controlled and the badge is embedded in third-party
    // pages. Without escaping, a component called `"><script>` becomes script
    // execution on every site that embeds it.
    const svg = badge.renderBadge('"><script>alert(1)</script>', 'operational', '#000', 'flat')
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
  })

  it('sizes the badge to its text', () => {
    expect(badge.textWidth('operational')).toBeGreaterThan(badge.textWidth('down'))
  })

  it('serves an SVG for the tenant', async () => {
    const response = await fx.app.inject({ method: 'GET', url: `/badge/${fx.slug}.svg` })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('image/svg+xml')
    expect(response.body).toContain('<svg')
  })

  it('renders unknown rather than 404 for a missing component', async () => {
    // A broken image on someone's README is a worse failure than a badge that
    // honestly says it has no data.
    const response = await fx.app.inject({
      method: 'GET',
      url: `/badge/${fx.slug}/no-such-control.svg`,
    })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('no data')
  })

  it('does not reveal an internal component to an anonymous caller', async () => {
    await fx.app.db.insert(schema.checks).values({
      tenantId: fx.tenantId,
      controlId: fx.controls.privateId,
      status: 'down',
    })

    const anonymous = await fx.app.inject({
      method: 'GET',
      url: `/badge/${fx.slug}/internal-job.svg`,
    })
    expect(anonymous.body).toContain('no data')

    const asAdmin = await fx.app.inject({
      method: 'GET',
      url: `/badge/${fx.slug}/internal-job.svg`,
      headers: { cookie: adminCookie },
    })
    expect(asAdmin.body).toContain('major outage')
  })
})

describe('iCalendar escaping', () => {
  it('escapes the separators iCalendar reserves', () => {
    // Commas and semicolons are field separators. An unescaped title splits the
    // event into fields a parser cannot make sense of.
    expect(feeds.icsEscape('Upgrade; phase 1, then 2')).toBe('Upgrade\\; phase 1\\, then 2')
    expect(feeds.icsEscape('line one\nline two')).toBe('line one\\nline two')
  })

  it('folds lines past 75 octets', () => {
    // RFC 5545 caps a line at 75. Skipping this works until a title is long, at
    // which point strict parsers reject the whole calendar — a failure that only
    // appears for tenants who write descriptive titles.
    const folded = feeds.foldIcsLine(`SUMMARY:${'x'.repeat(200)}`)
    expect(folded).toContain('\r\n ')
    for (const line of folded.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(75)
    }
  })

  it('leaves a short line alone', () => {
    expect(feeds.foldIcsLine('SUMMARY:short')).toBe('SUMMARY:short')
  })

  it('formats timestamps as UTC basic form', () => {
    expect(feeds.icsDate(new Date('2026-03-01T14:30:00.000Z'))).toBe('20260301T143000Z')
  })
})

describe('feeds', () => {
  it('serves an RSS feed of public incidents', async () => {
    await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/incidents`,
      headers: { cookie: adminCookie },
      payload: { title: 'Feed incident & <test>', body: 'Investigating.' },
    })

    const response = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/public/${fx.slug}/incidents.rss`,
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/rss+xml')
    expect(response.body).toContain('<rss')
    // The ampersand and angle brackets must not break the document.
    expect(response.body).toContain('Feed incident &amp; &lt;test&gt;')
  })

  it('omits an internal incident from the public feed', async () => {
    await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/incidents`,
      headers: { cookie: adminCookie },
      payload: { title: 'Internal only incident', body: 'Not for customers.', isPublic: false },
    })

    const response = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/public/${fx.slug}/incidents.rss`,
    })
    expect(response.body).not.toContain('Internal only incident')
  })

  it('serves maintenance windows as a calendar', async () => {
    await fx.app.db.insert(schema.maintenances).values({
      tenantId: fx.tenantId,
      title: 'Storage migration; phase 1',
      body: 'Brief failovers expected.',
      scheduledStart: new Date(Date.now() + 86_400_000),
      scheduledEnd: new Date(Date.now() + 90_000_000),
    })

    const response = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/public/${fx.slug}/maintenances.ics`,
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/calendar')
    expect(response.body).toContain('BEGIN:VCALENDAR')
    expect(response.body).toContain('BEGIN:VEVENT')
    expect(response.body).toContain('Storage migration\\; phase 1')
    // Outlook rejects LF-only calendars.
    expect(response.body).toContain('\r\n')
  })
})

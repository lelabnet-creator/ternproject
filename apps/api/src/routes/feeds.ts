import { and, desc, eq, gte, inArray, or } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import { config } from '../config.js'

/**
 * Feeds — the subscription channels that need no subscription.
 *
 * RSS and iCalendar cost a tenant nothing to offer and cost a reader no personal
 * data to consume. For anyone who wants to follow a status page without handing
 * over an email address, this is the whole feature.
 */

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/public/:slug/incidents.rss',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('history:read')],
      schema: { params: z.object({ slug: z.string() }) },
    },
    async (req, reply) => {
      const tenant = req.tenant!
      const [tenantRow] = await app.db
        .select()
        .from(schema.tenants)
        .where(eq(schema.tenants.id, tenant.id))
        .limit(1)

      const incidents = await app.db
        .select()
        .from(schema.incidents)
        .where(and(eq(schema.incidents.tenantId, tenant.id), eq(schema.incidents.isPublic, true)))
        .orderBy(desc(schema.incidents.startedAt))
        .limit(50)

      const updates = incidents.length
        ? await app.db
            .select()
            .from(schema.incidentUpdates)
            .where(
              inArray(
                schema.incidentUpdates.incidentId,
                incidents.map((i) => i.id),
              ),
            )
            .orderBy(desc(schema.incidentUpdates.createdAt))
        : []

      const base = `${config.PUBLIC_BASE_URL}/s/${tenant.slug}`
      const items = incidents.map((incident) => {
        const latest = updates.find((u) => u.incidentId === incident.id)
        return `    <item>
      <title>${escapeXml(incident.title)}</title>
      <link>${escapeXml(`${base}/incidents/${incident.id}`)}</link>
      <guid isPermaLink="false">${incident.id}</guid>
      <pubDate>${new Date(latest?.createdAt ?? incident.startedAt).toUTCString()}</pubDate>
      <category>${escapeXml(incident.status)}</category>
      <description>${escapeXml(latest?.body ?? '')}</description>
    </item>`
      })

      reply.type('application/rss+xml; charset=utf-8')
      reply.header('Cache-Control', 'public, max-age=60')
      return reply.send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(tenantRow?.name ?? tenant.slug)} — status</title>
    <link>${escapeXml(base)}</link>
    <description>Incident history</description>
    <language>${escapeXml(tenantRow?.defaultLocale ?? 'en')}</language>
    <atom:link href="${escapeXml(`${base}/incidents.rss`)}" rel="self" type="application/rss+xml"/>
${items.join('\n')}
  </channel>
</rss>`)
    },
  )

  /**
   * Maintenance windows as a calendar feed.
   *
   * Subscribing in a calendar is how a customer actually remembers a maintenance
   * window — far more reliably than an email sent a day ahead and buried by
   * lunchtime.
   */
  app.get(
    '/public/:slug/maintenances.ics',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('status:read')],
      schema: { params: z.object({ slug: z.string() }) },
    },
    async (req, reply) => {
      const tenant = req.tenant!

      const windows = await app.db
        .select()
        .from(schema.maintenances)
        .where(
          and(
            eq(schema.maintenances.tenantId, tenant.id),
            eq(schema.maintenances.isPublic, true),
            or(
              // Past windows stay in the feed for a while: a calendar that
              // forgets last week's maintenance is useless when someone is
              // working out what changed.
              gte(schema.maintenances.scheduledEnd, new Date(Date.now() - 90 * 86_400_000)),
              eq(schema.maintenances.status, 'scheduled'),
            ),
          ),
        )
        .orderBy(schema.maintenances.scheduledStart)

      const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//TERN//Status//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        `X-WR-CALNAME:${icsEscape(tenant.slug)} maintenance`,
      ]

      for (const window of windows) {
        lines.push(
          'BEGIN:VEVENT',
          `UID:${window.id}@tern`,
          `DTSTAMP:${icsDate(window.createdAt)}`,
          `DTSTART:${icsDate(window.scheduledStart)}`,
          `DTEND:${icsDate(window.scheduledEnd)}`,
          `SUMMARY:${icsEscape(window.title)}`,
          `DESCRIPTION:${icsEscape(window.body ?? '')}`,
          // Cancelled windows are published as CANCELLED rather than dropped, so
          // a subscribed calendar removes the entry instead of keeping a stale
          // one forever.
          `STATUS:${window.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
          `URL:${config.PUBLIC_BASE_URL}/s/${tenant.slug}`,
          'END:VEVENT',
        )
      }

      lines.push('END:VCALENDAR')

      reply.type('text/calendar; charset=utf-8')
      reply.header('Cache-Control', 'public, max-age=300')
      // RFC 5545 requires CRLF. Some clients tolerate LF; Outlook does not.
      return reply.send(lines.map(foldIcsLine).join('\r\n') + '\r\n')
    },
  )
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function icsDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
}

/** Commas, semicolons and newlines are field separators in iCalendar. */
function icsEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

/**
 * RFC 5545 caps a line at 75 octets, continued by a leading space.
 *
 * Skipping this works until a maintenance title is long, at which point strict
 * parsers reject the whole calendar — a failure that only appears for the
 * tenants who write descriptive titles.
 */
function foldIcsLine(line: string): string {
  if (line.length <= 75) return line
  const parts = [line.slice(0, 75)]
  let rest = line.slice(75)
  while (rest.length > 74) {
    parts.push(` ${rest.slice(0, 74)}`)
    rest = rest.slice(74)
  }
  if (rest.length > 0) parts.push(` ${rest}`)
  return parts.join('\r\n')
}

export const __testables = { icsEscape, foldIcsLine, icsDate, escapeXml }
export default routes

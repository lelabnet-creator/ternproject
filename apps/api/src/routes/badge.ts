import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import { worstStatus, type CheckStatusValue } from '@tern/shared'

/**
 * Embeddable status badges.
 *
 * Rendered server-side as SVG rather than served as an image or an iframe: it
 * scales, it needs no JavaScript on the host page, it works in a README, and it
 * cannot execute anything in the embedding site.
 */

/** Deliberately not the theme tokens: a badge sits on someone else's page. */
const BADGE_COLORS: Record<CheckStatusValue, string> = {
  operational: '#22a15c',
  degraded: '#c99a06',
  partial: '#e06a1b',
  down: '#d1364f',
  maintenance: '#0b7ec4',
  unknown: '#6b7280',
}

const LABELS: Record<CheckStatusValue, string> = {
  operational: 'operational',
  degraded: 'degraded',
  partial: 'partial outage',
  down: 'major outage',
  maintenance: 'maintenance',
  unknown: 'no data',
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/badge/:slug.svg',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('status:read')],
      schema: {
        params: z.object({ slug: z.string() }),
        querystring: z.object({
          label: z.string().max(40).default('status'),
          style: z.enum(['flat', 'plastic']).default('flat'),
        }),
      },
    },
    async (req, reply) => {
      const status = await tenantStatus(app, req.tenant!.id, req.can('status:read:all'))
      return sendBadge(reply, req.query.label, status, req.query.style)
    },
  )

  app.get(
    '/badge/:slug/:controlKey.svg',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('status:read')],
      schema: {
        params: z.object({ slug: z.string(), controlKey: z.string() }),
        querystring: z.object({
          label: z.string().max(40).optional(),
          style: z.enum(['flat', 'plastic']).default('flat'),
        }),
      },
    },
    async (req, reply) => {
      const [control] = await app.db
        .select()
        .from(schema.controls)
        .where(
          and(
            eq(schema.controls.tenantId, req.tenant!.id),
            eq(schema.controls.key, req.params.controlKey),
            req.can('status:read:all') ? undefined : eq(schema.controls.isPublic, true),
          ),
        )
        .limit(1)

      if (!control) {
        // A badge for a component that does not exist, or that this caller may
        // not see, renders as "unknown" rather than 404. A broken image on
        // someone's README is a worse failure than a badge saying nothing.
        return sendBadge(reply, req.params.controlKey, 'unknown', req.query.style)
      }

      const [latest] = await app.sql<{ status: CheckStatusValue }[]>`
        SELECT status FROM checks
         WHERE control_id = ${control.id}::uuid
         ORDER BY ts DESC LIMIT 1
      `

      return sendBadge(
        reply,
        req.query.label ?? control.name.toLowerCase(),
        latest?.status ?? 'unknown',
        req.query.style,
      )
    },
  )
}

async function tenantStatus(
  app: Parameters<FastifyPluginAsyncZod>[0],
  tenantId: string,
  seeAll: boolean,
): Promise<CheckStatusValue> {
  const rows = await app.sql<{ status: CheckStatusValue }[]>`
    SELECT DISTINCT ON (c.id) last.status
      FROM controls c
      LEFT JOIN LATERAL (
        SELECT status, ts FROM checks WHERE control_id = c.id ORDER BY ts DESC LIMIT 1
      ) last ON TRUE
     WHERE c.tenant_id = ${tenantId}::uuid
       AND c.enabled
       ${seeAll ? app.sql`` : app.sql`AND c.is_public`}
  `

  const statuses = rows.map((r) => r.status ?? 'unknown')
  return statuses.length === 0 ? 'unknown' : worstStatus(statuses)
}

interface BadgeReply {
  header(key: string, value: string): unknown
  type(contentType: string): unknown
  send(body: string): unknown
}

function sendBadge(
  reply: BadgeReply,
  label: string,
  status: CheckStatusValue,
  style: 'flat' | 'plastic',
) {
  const value = LABELS[status]
  const svg = renderBadge(label, value, BADGE_COLORS[status], style)

  // 60s, and stale-while-revalidate so a CDN or GitHub's camo proxy keeps
  // serving the last badge instead of a broken image while it refreshes.
  reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
  reply.type('image/svg+xml; charset=utf-8')
  return reply.send(svg)
}

/**
 * Renders a shields.io-shaped badge.
 *
 * Width is estimated from character count rather than measured — an SVG served
 * standalone has no font metrics available, and the estimate only has to be
 * close enough that the text is not clipped.
 */
function renderBadge(label: string, value: string, color: string, style: 'flat' | 'plastic') {
  const labelWidth = textWidth(label)
  const valueWidth = textWidth(value)
  const total = labelWidth + valueWidth
  const radius = style === 'plastic' ? 4 : 3

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${escapeXml(label)}: ${escapeXml(value)}">
  <title>${escapeXml(label)}: ${escapeXml(value)}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#fff" stop-opacity=".7"/>
    <stop offset=".1" stop-color="#aaa" stop-opacity=".1"/>
    <stop offset=".9" stop-color="#000" stop-opacity=".3"/>
    <stop offset="1" stop-color="#000" stop-opacity=".5"/>
  </linearGradient>
  <clipPath id="r"><rect width="${total}" height="20" rx="${radius}" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#444"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>
    ${style === 'plastic' ? `<rect width="${total}" height="20" fill="url(#s)"/>` : ''}
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(label)}</text>
    <text x="${labelWidth / 2}" y="14">${escapeXml(label)}</text>
    <text x="${labelWidth + valueWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(value)}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14">${escapeXml(value)}</text>
  </g>
</svg>`
}

function textWidth(text: string): number {
  return Math.round(text.length * 6.6) + 20
}

/**
 * Tenant and control names reach this string. Without escaping, a component
 * named `"><script>` would become script in every page that embeds the badge.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export const __testables = { renderBadge, escapeXml, textWidth }
export default routes

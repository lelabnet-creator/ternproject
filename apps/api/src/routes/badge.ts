import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import { worstStatus, type CheckStatusValue } from '@tern/shared'
import { BADGE_STYLES, type BadgeStyle } from '@tern/shared/badges'

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

/**
 * The pale wash behind an alert block.
 *
 * Fixed values rather than the solid colour at low opacity: a badge is embedded
 * over a background this code cannot see, and a translucent fill would take its
 * hue from whatever is underneath — pastel on white, muddy on grey, and wrong
 * on a dark README.
 */
const BADGE_TINTS: Record<CheckStatusValue, string> = {
  operational: '#e6f6ec',
  degraded: '#fbf2d5',
  partial: '#fcecdf',
  down: '#fce8ec',
  maintenance: '#e0f0fb',
  unknown: '#eef0f2',
}

const LABELS: Record<CheckStatusValue, string> = {
  operational: 'operational',
  degraded: 'degraded',
  partial: 'partial outage',
  down: 'major outage',
  maintenance: 'maintenance',
  unknown: 'no data',
}

const styleSchema = z.enum(BADGE_STYLES).default('flat')

/** Text that stays legible whatever the badge is dropped onto. */
const INK = '#1f2328'
const MUTED = '#57606a'
const SLATE = '#2b3137'

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
          style: styleSchema,
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
          style: styleSchema,
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

function sendBadge(reply: BadgeReply, label: string, status: CheckStatusValue, style: BadgeStyle) {
  const svg = renderBadge(label, status, style)

  // 60s, and stale-while-revalidate so a CDN or GitHub's camo proxy keeps
  // serving the last badge instead of a broken image while it refreshes.
  reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
  reply.type('image/svg+xml; charset=utf-8')
  return reply.send(svg)
}

const FONT = 'Verdana,Geneva,DejaVu Sans,sans-serif'

/** Dispatches to the shape asked for. Every one of them returns standalone SVG. */
function renderBadge(label: string, status: CheckStatusValue, style: BadgeStyle): string {
  const value = LABELS[status]
  const color = BADGE_COLORS[status]

  switch (style) {
    case 'circle':
      return renderCircle(value, color)
    case 'alert-block':
      return renderAlertBlock(label, value, color, BADGE_TINTS[status])
    case 'status-bar':
      return renderStatusBar(label, value, color)
    default:
      return renderPill(label, value, color, style)
  }
}

/**
 * The shields.io pill.
 *
 * Width is estimated from character count rather than measured — an SVG served
 * standalone has no font metrics available, and the estimate only has to be
 * close enough that the text is not clipped.
 */
function renderPill(label: string, value: string, color: string, style: BadgeStyle): string {
  const labelWidth = textWidth(label)
  const valueWidth = textWidth(value)
  const total = labelWidth + valueWidth
  const radius = style === 'plastic' ? 4 : 3

  return frame(
    total,
    20,
    label,
    value,
    `<linearGradient id="s" x2="0" y2="100%">
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
  <g fill="#fff" text-anchor="middle" font-family="${FONT}" font-size="11">
    <text x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(label)}</text>
    <text x="${labelWidth / 2}" y="14">${escapeXml(label)}</text>
    <text x="${labelWidth + valueWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(value)}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14">${escapeXml(value)}</text>
  </g>`,
  )
}

/**
 * A dot and the word beside it.
 *
 * The word is not decoration. A bare coloured circle is the one badge in this
 * set that would say nothing at all to a colourblind reader — operational green
 * and down red are the pair that collapses first — and the rest of this product
 * refuses colour as the only channel everywhere it appears. The dot is what
 * makes it glanceable; the word is what makes it true.
 */
function renderCircle(value: string, color: string): string {
  const width = 26 + textLength(value)

  return frame(
    width,
    20,
    value,
    value,
    `<rect width="${width}" height="20" rx="10" fill="${SLATE}"/>
  <circle cx="11" cy="10" r="5" fill="${color}"/>
  <text x="21" y="14" fill="#fff" font-family="${FONT}" font-size="11">${escapeXml(value)}</text>`,
  )
}

/**
 * A callout, for the top of a README or a docs page.
 *
 * The colour carries in the rule and the wash; the words stay near-black. Dark
 * text on a pale tint clears contrast at every status, which coloured text on
 * the same tint does not — green on green is the case that fails.
 */
function renderAlertBlock(label: string, value: string, color: string, tint: string): string {
  const width = Math.max(200, 28 + Math.max(textLength(label), textLength(value, 13)))

  return frame(
    width,
    46,
    label,
    value,
    `<clipPath id="r"><rect width="${width}" height="46" rx="6" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${width}" height="46" fill="${tint}"/>
    <rect width="4" height="46" fill="${color}"/>
  </g>
  <g font-family="${FONT}">
    <text x="18" y="19" fill="${MUTED}" font-size="11">${escapeXml(label)}</text>
    <text x="18" y="36" fill="${INK}" font-size="13" font-weight="600">${escapeXml(value)}</text>
  </g>`,
  )
}

/**
 * A strip meant to span something — the head of a page, the width of a column.
 *
 * The status sits in its own coloured chip rather than being tinted text on the
 * bar: white on the solid status colour is the one pairing that holds for all
 * six of them.
 */
function renderStatusBar(label: string, value: string, color: string): string {
  const chipWidth = textLength(value) + 18
  const width = Math.max(240, 12 + textLength(label) + 16 + chipWidth + 10)
  const chipX = width - chipWidth - 10

  return frame(
    width,
    28,
    label,
    value,
    `<rect width="${width}" height="28" rx="4" fill="${SLATE}"/>
  <rect x="${chipX}" y="5" width="${chipWidth}" height="18" rx="9" fill="${color}"/>
  <g font-family="${FONT}" font-size="11">
    <text x="12" y="18" fill="#fff">${escapeXml(label)}</text>
    <text x="${chipX + chipWidth / 2}" y="18" fill="#fff" text-anchor="middle">${escapeXml(value)}</text>
  </g>`,
  )
}

/**
 * The wrapper every style shares.
 *
 * `role="img"` plus the label is what a screen reader announces — without it an
 * embedded SVG is read out as the whole soup of its shapes, or skipped.
 */
function frame(width: number, height: number, label: string, value: string, body: string): string {
  const name = `${escapeXml(label)}: ${escapeXml(value)}`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" role="img" aria-label="${name}">
  <title>${name}</title>
  ${body}
</svg>`
}

/** Verdana at 11px averages about 0.6em per character; close enough not to clip. */
function textLength(text: string, fontSize = 11): number {
  return Math.round(text.length * fontSize * 0.6)
}

function textWidth(text: string): number {
  return textLength(text) + 20
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

export const __testables = { renderBadge, escapeXml, textWidth, textLength }
export default routes

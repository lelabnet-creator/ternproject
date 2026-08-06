import { and, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema, toDate } from '@tern/db'
import {
  checkStatusSchema,
  impactToStatus,
  overallStatus,
  rollupStatus,
  worstStatus,
  type CheckStatusValue,
} from '@tern/shared'

/**
 * The public status API.
 *
 * Versioned and stable on purpose: a status page is meant to be consumed by the
 * customers of the tenant — embedded in their own dashboards, polled by their
 * own monitoring. That only works if the shape does not move underneath them.
 */

const PERIODS = {
  '24h': { days: 1, bucket: 'checks_1m' },
  '7d': { days: 7, bucket: 'checks_5m' },
  '30d': { days: 30, bucket: 'checks_1h' },
  '90d': { days: 90, bucket: 'checks_1h' },
  '1y': { days: 365, bucket: 'checks_1h' },
} as const

type Period = keyof typeof PERIODS

const componentSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  groupId: z.string().nullable(),
  status: checkStatusSchema,
  lastCheckAt: z.string().nullable(),
  latencyMs: z.number().nullable(),
  value: z.number().nullable(),
  valueUnit: z.string().nullable(),
  valueLabel: z.string().nullable(),
  slaTarget: z.number().nullable(),
  widget: z.string(),
  widgetOptions: z.record(z.string(), z.unknown()),
})

const routes: FastifyPluginAsyncZod = async (app) => {
  /**
   * Which status page this instance serves, if the answer is unambiguous.
   *
   * An instance carries one status page: nothing in the API creates a tenant,
   * so the only one that exists is the one provisioning made. The root of the
   * web app asks this so it can go straight there instead of asking a visitor
   * to type a name they were never given.
   *
   * Two cases are excluded:
   *
   * - The system tenant is not a status page, it is the instance's own
   *   supervision scope.
   * - More than one tenant means the answer is not unambiguous — a database
   *   seeded or migrated into several keeps the picker rather than having one
   *   of them silently win.
   *
   * No authentication, and nothing to protect: a status page is readable by
   * whoever has its address, so naming the only one this instance serves
   * discloses nothing that `/s/<slug>` does not already serve.
   */
  app.get(
    '/public/instance.json',
    {
      schema: {
        response: {
          200: z.object({
            tenant: z
              .object({
                slug: z.string(),
                name: z.string(),
              })
              .nullable(),
          }),
        },
      },
    },
    async () => {
      // Two rows are enough to tell "exactly one" from "several", and it keeps
      // an instance that somehow holds many from reading them all.
      const rows = await app.db
        .select({ slug: schema.tenants.slug, name: schema.tenants.name })
        .from(schema.tenants)
        .where(eq(schema.tenants.isSystem, false))
        .limit(2)

      return { tenant: rows.length === 1 ? rows[0]! : null }
    },
  )

  /**
   * Everything the public page needs in one request.
   *
   * One round trip rather than five: the page is often loaded during an
   * incident, when the tenant's own infrastructure — and the visitor's
   * patience — is already under strain.
   */
  app.get(
    '/public/:slug/summary.json',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('status:read')],
      schema: {
        params: z.object({ slug: z.string() }),
        response: {
          200: z.object({
            tenant: z.object({
              slug: z.string(),
              name: z.string(),
              retentionMode: z.enum(['live', 'historical']),
              retentionDays: z.number(),
              defaultLocale: z.string(),
              defaultTimezone: z.string(),
              /** Consent text for the subscribe form; null when unset. */
              subscriberDisclaimer: z.string().nullable(),
              layout: z.enum(['list', 'grid', 'compact']),
              branding: z.record(z.string(), z.unknown()),
            }),
            overall: z.object({
              status: checkStatusSchema,
              affectedCount: z.number(),
            }),
            groups: z.array(
              z.object({
                id: z.string(),
                parentId: z.string().nullable(),
                name: z.string(),
                position: z.number(),
                status: checkStatusSchema,
              }),
            ),
            components: z.array(componentSchema),
            incidents: z.array(
              z.object({
                id: z.string(),
                title: z.string(),
                severity: z.string(),
                status: z.string(),
                startedAt: z.string(),
                resolvedAt: z.string().nullable(),
                impacts: z.array(z.object({ controlId: z.string(), impact: z.string() })),
              }),
            ),
            maintenances: z.array(
              z.object({
                id: z.string(),
                title: z.string(),
                status: z.string(),
                scheduledStart: z.string(),
                scheduledEnd: z.string(),
                controlIds: z.array(z.string()),
              }),
            ),
            generatedAt: z.string(),
          }),
        },
      },
    },
    async (req, reply) => {
      const tenant = req.tenant!
      const seeAll = req.can('status:read:all')

      const [tenantRow] = await app.db
        .select()
        .from(schema.tenants)
        .where(eq(schema.tenants.id, tenant.id))
        .limit(1)
      if (!tenantRow) throw app.httpErrors.notFound('Not found')

      const controls = await app.db
        .select()
        .from(schema.controls)
        .where(
          and(
            eq(schema.controls.tenantId, tenant.id),
            eq(schema.controls.enabled, true),
            // Internal controls are filtered in the query, not in the response
            // mapping: a component a visitor may not see must not travel over
            // the wire at all.
            seeAll ? undefined : eq(schema.controls.isPublic, true),
            visibleToViewer(req.actor.scopeControlIds),
          ),
        )
        .orderBy(schema.controls.position)

      const controlIds = controls.map((c) => c.id)
      const latest = await latestChecks(app, controlIds)

      const now = new Date()
      const activeIncidents = await app.db
        .select()
        .from(schema.incidents)
        .where(
          and(
            eq(schema.incidents.tenantId, tenant.id),
            eq(schema.incidents.isPublic, true),
            isNull(schema.incidents.resolvedAt),
          ),
        )

      const impacts = activeIncidents.length
        ? await app.db
            .select()
            .from(schema.incidentImpacts)
            .where(
              inArray(
                schema.incidentImpacts.incidentId,
                activeIncidents.map((i) => i.id),
              ),
            )
        : []

      const activeMaintenances = await app.db
        .select()
        .from(schema.maintenances)
        .where(
          and(
            eq(schema.maintenances.tenantId, tenant.id),
            eq(schema.maintenances.isPublic, true),
            eq(schema.maintenances.status, 'in_progress'),
          ),
        )

      const maintenanceControlIds = activeMaintenances.length
        ? new Set(
            (
              await app.db
                .select()
                .from(schema.maintenanceControls)
                .where(
                  inArray(
                    schema.maintenanceControls.maintenanceId,
                    activeMaintenances.map((m) => m.id),
                  ),
                )
            ).map((row) => row.controlId),
          )
        : new Set<string>()

      // Declared incident impact overrides the measured status. A team that has
      // said "this is a major outage" is making a judgement the raw samples
      // cannot: a service can answer health checks while being useless.
      const declared = new Map<string, CheckStatusValue>()
      for (const impact of impacts) {
        const asStatus = impactToStatus(impact.impact)
        const current = declared.get(impact.controlId)
        declared.set(impact.controlId, current ? worstStatus([current, asStatus]) : asStatus)
      }

      const components = controls.map((control) => {
        const last = latest.get(control.id)
        const measured: CheckStatusValue = last?.status ?? 'unknown'
        const status =
          declared.get(control.id) ??
          (maintenanceControlIds.has(control.id) && measured === 'operational'
            ? 'maintenance'
            : measured)

        return {
          id: control.id,
          key: control.key,
          name: control.name,
          description: control.description,
          groupId: control.groupId,
          status,
          lastCheckAt: last?.ts?.toISOString() ?? null,
          latencyMs: last?.latencyMs ?? null,
          value: last?.value ?? null,
          valueUnit: control.valueUnit,
          valueLabel: control.valueLabel,
          slaTarget: control.slaTarget,
          widget: control.widget,
          widgetOptions: control.widgetOptions,
        }
      })

      const groupRows = await app.db
        .select()
        .from(schema.controlGroups)
        .where(eq(schema.controlGroups.tenantId, tenant.id))
        .orderBy(schema.controlGroups.position)

      const groups = groupRows.map((group) => {
        const children = components.filter((c) => c.groupId === group.id).map((c) => c.status)
        return {
          id: group.id,
          parentId: group.parentId,
          name: group.name,
          position: group.position,
          status: rollupStatus(children, group.statusRollup),
        }
      })

      const affected = components.filter(
        (c) => c.status !== 'operational' && c.status !== 'unknown' && c.status !== 'maintenance',
      )

      // Short cache: during an incident this endpoint is hammered by every
      // customer refreshing at once, and five seconds of staleness costs far
      // less than the origin falling over.
      void reply.header('Cache-Control', 'public, max-age=5, stale-while-revalidate=30')

      return {
        tenant: {
          slug: tenantRow.slug,
          name: tenantRow.name,
          retentionMode: tenantRow.retentionMode,
          retentionDays: tenantRow.retentionDays,
          defaultLocale: tenantRow.defaultLocale,
          defaultTimezone: tenantRow.defaultTimezone,
          subscriberDisclaimer: tenantRow.subscriberDisclaimer,
          layout: tenantRow.layout,
          branding: tenantRow.branding,
        },
        overall: {
          status: overallStatus(components.map((c) => c.status)),
          affectedCount: affected.length,
        },
        groups,
        components,
        incidents: activeIncidents.map((incident) => ({
          id: incident.id,
          title: incident.title,
          severity: incident.severity,
          status: incident.status,
          startedAt: incident.startedAt.toISOString(),
          resolvedAt: incident.resolvedAt?.toISOString() ?? null,
          impacts: impacts
            .filter((i) => i.incidentId === incident.id)
            .map((i) => ({ controlId: i.controlId, impact: i.impact })),
        })),
        maintenances: activeMaintenances.map((m) => ({
          id: m.id,
          title: m.title,
          status: m.status,
          scheduledStart: m.scheduledStart.toISOString(),
          scheduledEnd: m.scheduledEnd.toISOString(),
          controlIds: [...maintenanceControlIds],
        })),
        generatedAt: now.toISOString(),
      }
    },
  )

  /**
   * Daily uptime for the ribbon, and bucketed latency percentiles for the
   * band chart. Both come from the continuous aggregates, so a one-year window
   * costs about what a one-week window does.
   */
  app.get(
    '/public/:slug/uptime.json',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('history:read')],
      schema: {
        params: z.object({ slug: z.string() }),
        querystring: z.object({
          period: z.enum(['24h', '7d', '30d', '90d', '1y']).default('90d'),
        }),
        response: {
          200: z.object({
            period: z.string(),
            days: z.array(
              z.object({
                controlId: z.string(),
                day: z.string(),
                uptimePct: z.number().nullable(),
                samples: z.number(),
                worstStatus: checkStatusSchema,
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const tenant = req.tenant!
      const period: Period = req.query.period
      const { days } = PERIODS[period]

      // Live-mode tenants keep no long history, so asking for a year of it
      // would return a misleading wall of "no data". The window is clamped to
      // what the tenant actually retains.
      const effectiveDays = clampToRetention(days, tenant)

      const rows = await app.sql<
        {
          control_id: string
          day: string
          uptime_pct: number | null
          samples: number
          down_samples: number
          degraded_samples: number
        }[]
      >`
        SELECT a.control_id,
               time_bucket(INTERVAL '1 day', a.bucket) AS day,
               CASE WHEN sum(a.samples) > 0
                    THEN round(100.0 * sum(a.ok_samples) / sum(a.samples), 4)
                    END AS uptime_pct,
               sum(a.samples)          AS samples,
               sum(a.down_samples)     AS down_samples,
               sum(a.degraded_samples) AS degraded_samples
          FROM checks_1h a
         WHERE a.tenant_id = ${tenant.id}::uuid
           AND a.bucket >= now() - (${effectiveDays} || ' days')::interval
         GROUP BY 1, 2
         ORDER BY 2
      `

      const visible = new Set(req.actor.scopeControlIds)

      return {
        period,
        days: rows
          .filter((row) => visible.size === 0 || visible.has(row.control_id))
          .map((row) => ({
            controlId: row.control_id,
            day: toDate(row.day).toISOString().slice(0, 10),
            uptimePct: row.uptime_pct === null ? null : Number(row.uptime_pct),
            samples: Number(row.samples),
            worstStatus: dayStatus(row),
          })),
      }
    },
  )
}

/**
 * A day is coloured by its worst moment, not its average. An hour of downtime
 * inside a 99.9% day is exactly what a reader is looking for, and averaging
 * hides it.
 */
function dayStatus(row: {
  samples: number
  down_samples: number
  degraded_samples: number
}): CheckStatusValue {
  if (Number(row.down_samples) > 0) return 'down'
  if (Number(row.degraded_samples) > 0) return 'degraded'
  return Number(row.samples) > 0 ? 'operational' : 'unknown'
}

/** A viewer token may be scoped to a subset of controls. */
function visibleToViewer(scopeControlIds: string[]) {
  if (scopeControlIds.length === 0) return undefined
  return inArray(schema.controls.id, scopeControlIds)
}

function clampToRetention(days: number, tenant: { retentionMode: string; retentionDays: number }) {
  if (tenant.retentionMode === 'live') return 1
  return Math.min(days, tenant.retentionDays)
}

/**
 * The most recent check per control.
 *
 * DISTINCT ON with a matching index turns this into one index scan per control
 * rather than a sort over the whole hypertable — which, at 300k rows for a
 * demo tenant, is the difference between a page that loads and one that does
 * not.
 */
async function latestChecks(app: Parameters<FastifyPluginAsyncZod>[0], controlIds: string[]) {
  if (controlIds.length === 0) return new Map<string, never>()

  const rows = await app.sql<
    {
      control_id: string
      ts: string
      status: CheckStatusValue
      latency_ms: number | null
      value: number | null
    }[]
  >`
    SELECT DISTINCT ON (control_id) control_id, ts, status, latency_ms, value
      FROM checks
     WHERE control_id = ANY(${controlIds}::uuid[])
     ORDER BY control_id, ts DESC
  `

  return new Map(
    rows.map((row) => [
      row.control_id,
      {
        ts: toDate(row.ts),
        status: row.status,
        latencyMs: row.latency_ms,
        value: row.value === null ? null : Number(row.value),
      },
    ]),
  )
}

export default routes

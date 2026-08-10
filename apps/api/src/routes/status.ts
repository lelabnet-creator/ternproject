import { and, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema, toDate } from '@tern/db'
import {
  checkStatusSchema,
  computeAvailability,
  impactToStatus,
  overallStatus,
  publishedUptime,
  rollupStatus,
  worstStatus,
  type AvailabilityBucket,
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
              layout: z.enum(['list', 'grid', 'compact', 'custom']),
              /** Carries synthetic data, and the page says so rather than pretending. */
              isDemo: z.boolean(),
              /** Refuses every write. Travels with `isDemo`; not only with it. */
              readOnly: z.boolean(),
              /**
               * The document a `custom` layout renders, and null for every
               * other layout — there is no reason to put a hundred kilobytes of
               * someone's unused draft on the path every visitor hits.
               */
              custom: z
                .object({
                  html: z.string(),
                  css: z.string(),
                  js: z.string(),
                })
                .nullable(),
              /** Blocks on a grid. The arrangement *is* the page in `custom`. */
              customBlocks: z.array(z.unknown()),
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
                latestUpdate: z
                  .object({ status: z.string(), body: z.string(), createdAt: z.string() })
                  .nullable(),
                impacts: z.array(z.object({ controlId: z.string(), impact: z.string() })),
              }),
            ),
            maintenances: z.array(
              z.object({
                id: z.string(),
                title: z.string(),
                body: z.string().nullable(),
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
      /*
       * Membership, not merely the permission.
       *
       * A demo visitor holds `status:read:all` so the admin screens they are
       * invited to walk through have something in them. On *this* endpoint that
       * would put components marked internal on the public page — a demo
       * demonstrating the opposite of the feature it exists to show. Whoever is
       * reading the public summary of a page they do not belong to sees what
       * the public sees.
       */
      const seeAll = req.can('status:read:all') && req.role !== 'demo'

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

      const updates = activeIncidents.length
        ? await app.db
            .select()
            .from(schema.incidentUpdates)
            .where(
              inArray(
                schema.incidentUpdates.incidentId,
                activeIncidents.map((i) => i.id),
              ),
            )
            .orderBy(schema.incidentUpdates.createdAt)
        : []

      /*
       * Running *and* upcoming.
       *
       * Only `in_progress` used to be loaded, which meant planned work first
       * appeared on the page at the moment it began — announcing it in advance
       * being the entire reason a maintenance window exists. Subscribers got
       * their reminder and readers of the page got nothing.
       */
      const shownMaintenances = await app.db
        .select()
        .from(schema.maintenances)
        .where(
          and(
            eq(schema.maintenances.tenantId, tenant.id),
            eq(schema.maintenances.isPublic, true),
            inArray(schema.maintenances.status, ['in_progress', 'scheduled']),
          ),
        )
        .orderBy(schema.maintenances.scheduledStart)

      const maintenanceLinks = shownMaintenances.length
        ? await app.db
            .select()
            .from(schema.maintenanceControls)
            .where(
              inArray(
                schema.maintenanceControls.maintenanceId,
                shownMaintenances.map((m) => m.id),
              ),
            )
        : []

      /*
       * Only what is running suppresses a component's measured status. A window
       * announced for next Tuesday must not paint anything blue today.
       */
      const maintenanceControlIds = new Set(
        maintenanceLinks
          .filter((link) =>
            shownMaintenances.some(
              (m) => m.id === link.maintenanceId && m.status === 'in_progress',
            ),
          )
          .map((link) => link.controlId),
      )

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
          isDemo: tenantRow.isDemo,
          readOnly: tenantRow.readOnly,
          customBlocks: tenantRow.layout === 'custom' ? tenantRow.customBlocks : [],
          custom:
            tenantRow.layout === 'custom'
              ? {
                  html: tenantRow.customHtml ?? '',
                  css: tenantRow.customCss ?? '',
                  js: tenantRow.customJs ?? '',
                }
              : null,
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
          // The most recent thing said about it. A page that names an incident
          // without saying what is happening sends the reader to look elsewhere,
          // which is the moment a status page has failed at its one job.
          latestUpdate: latestUpdateFor(incident.id, updates),
          impacts: impacts
            .filter((i) => i.incidentId === incident.id)
            .map((i) => ({ controlId: i.controlId, impact: i.impact })),
        })),
        maintenances: shownMaintenances.map((m) => ({
          id: m.id,
          title: m.title,
          body: m.body,
          status: m.status,
          scheduledStart: m.scheduledStart.toISOString(),
          scheduledEnd: m.scheduledEnd.toISOString(),
          // Its own components. This used to hand every window the union of all
          // of them, so two windows on one page each claimed the other's.
          controlIds: maintenanceLinks
            .filter((link) => link.maintenanceId === m.id)
            .map((link) => link.controlId),
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
            /**
             * Which continuous aggregate answered, so a reader knows how sharp
             * the figure is. An hourly bucket cannot say where inside the hour
             * an outage fell.
             */
            resolution: z.enum(['checks_1m', 'checks_5m', 'checks_1h']),
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
      const { days: windowDays } = PERIODS[period]

      // Live-mode tenants keep no long history, so asking for a year of it
      // would return a misleading wall of "no data". The window is clamped to
      // what the tenant actually retains.
      const effectiveDays = clampToRetention(windowDays, tenant)

      /*
       * ── Buckets, not a percentage computed in SQL ─────────────────────────
       *
       * This used to be `sum(ok_samples) / sum(samples)` — a ratio of points.
       * A ten-minute outage cost a control probed every ten seconds six hundred
       * failed points and one probed every five minutes two, so the same outage
       * on the same service published two very different figures; and changing
       * a control's interval rewrote the meaning of its whole history.
       *
       * The buckets now come back raw and `computeAvailability` weights them by
       * duration. It also carries the four rules SQL had nowhere to put: the
       * debounce, planned maintenance leaving the denominator, silence on a
       * push control, and time nobody observed leaving it too.
       *
       * The resolution is `PERIODS[period].bucket`, which already existed —
       * a day of history is read minute by minute, a year hour by hour. It is
       * returned to the caller rather than left implicit: an hourly bucket
       * cannot say where inside the hour an outage fell, and a reader comparing
       * two windows deserves to know which one is sharper.
       */
      const { bucket } = PERIODS[period]
      const source =
        bucket === 'checks_1m'
          ? app.sql`checks_1m`
          : bucket === 'checks_5m'
            ? app.sql`checks_5m`
            : app.sql`checks_1h`
      const bucketMs =
        bucket === 'checks_1m' ? 60_000 : bucket === 'checks_5m' ? 5 * 60_000 : 60 * 60_000

      const rows = await app.sql<
        {
          control_id: string
          bucket: string
          samples: number
          ok_samples: number
          degraded_samples: number
          down_samples: number
          maintenance_samples: number
          unknown_samples: number
        }[]
      >`
        SELECT a.control_id,
               a.bucket,
               a.samples,
               a.ok_samples,
               a.degraded_samples,
               a.down_samples,
               a.maintenance_samples,
               a.unknown_samples
          FROM ${source} a
         WHERE a.tenant_id = ${tenant.id}::uuid
           AND a.bucket >= now() - (${effectiveDays} || ' days')::interval
         ORDER BY a.bucket
      `

      /*
       * Planned work, and only what actually happened.
       *
       * `actual_start`/`actual_end` when the window ran, falling back to what
       * was scheduled — a maintenance announced for two hours and finished in
       * twenty minutes must not remove two hours from the denominator, or the
       * figure would improve by over-announcing.
       */
      const windows = await app.sql<{ control_id: string; starts_at: string; ends_at: string }[]>`
        SELECT mc.control_id,
               coalesce(m.actual_start, m.scheduled_start) AS starts_at,
               coalesce(m.actual_end, m.scheduled_end)     AS ends_at
          FROM maintenance_controls mc
          JOIN maintenances m ON m.id = mc.maintenance_id
         WHERE m.tenant_id = ${tenant.id}::uuid
           AND coalesce(m.actual_end, m.scheduled_end) >= now() - (${effectiveDays} || ' days')::interval
      `

      const exclusionsByControl = new Map<string, { from: number; to: number }[]>()
      for (const row of windows) {
        const list = exclusionsByControl.get(row.control_id) ?? []
        list.push({ from: toDate(row.starts_at).getTime(), to: toDate(row.ends_at).getTime() })
        exclusionsByControl.set(row.control_id, list)
      }

      /** Buckets, grouped by control and by the day they fall in. */
      const byControlDay = new Map<string, AvailabilityBucket[]>()
      const countsByControlDay = new Map<
        string,
        { samples: number; down: number; degraded: number }
      >()

      for (const row of rows) {
        const from = toDate(row.bucket).getTime()
        const day = new Date(from).toISOString().slice(0, 10)
        const key = `${row.control_id} ${day}`

        const list = byControlDay.get(key) ?? []
        list.push({
          from,
          to: from + bucketMs,
          samples: Number(row.samples),
          ok: Number(row.ok_samples),
          degraded: Number(row.degraded_samples),
          down: Number(row.down_samples),
          maintenance: Number(row.maintenance_samples),
          unknown: Number(row.unknown_samples),
        })
        byControlDay.set(key, list)

        const counts = countsByControlDay.get(key) ?? { samples: 0, down: 0, degraded: 0 }
        counts.samples += Number(row.samples)
        counts.down += Number(row.down_samples)
        counts.degraded += Number(row.degraded_samples)
        countsByControlDay.set(key, counts)
      }

      const visible = new Set(req.actor.scopeControlIds)

      const days = [...byControlDay.entries()]
        .map(([key, buckets]) => {
          const [controlId, day] = key.split(' ') as [string, string]
          const dayStart = Date.parse(`${day}T00:00:00.000Z`)

          const availability = computeAvailability({
            window: { from: dayStart, to: dayStart + 86_400_000 },
            // Ignored on the bucket path — a bucket states its own span — but
            // the field is required, so it is given the truth rather than a
            // placeholder somebody would later mistake for a setting.
            intervalMs: bucketMs,
            buckets,
            exclusions: exclusionsByControl.get(controlId) ?? [],
          })

          const counts = countsByControlDay.get(key)!
          return {
            controlId,
            day,
            uptimePct: publishedUptime(availability, counts.samples),
            samples: counts.samples,
            worstStatus: dayStatus({
              samples: counts.samples,
              down_samples: counts.down,
              degraded_samples: counts.degraded,
            }),
          }
        })
        .filter((row) => visible.size === 0 || visible.has(row.controlId))
        .sort((a, b) => a.day.localeCompare(b.day))

      return { period, resolution: bucket, days }
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

/** The newest update on an incident, which is the line a reader wants first. */
function latestUpdateFor(
  incidentId: string,
  updates: { incidentId: string; status: string; body: string; createdAt: Date }[],
): { status: string; body: string; createdAt: string } | null {
  const mine = updates.filter((u) => u.incidentId === incidentId)
  const newest = mine[mine.length - 1]
  return newest
    ? { status: newest.status, body: newest.body, createdAt: newest.createdAt.toISOString() }
    : null
}

export default routes

import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import {
  generateMockSeries,
  payloadShapeForWidget,
  probeSchema,
  renderAgentConfig,
  renderAgentPairCommand,
  renderAgentRunCommand,
  renderAllTemplates,
  SCRIPT_TEMPLATES,
} from '@tern/shared'
import { blocksSchema } from '@tern/shared/blocks'
import { config } from '../config.js'
import { audit } from '../services/audit.js'
import { runProbe } from '../services/probe-transport.js'
import { purgeSyntheticChecks } from '../services/scheduler.js'
import { agentCoverage } from '../services/local-probes.js'
import { assignmentsFor } from '../services/jobs.js'
import { downsample } from '../services/series.js'

/**
 * Controls, and everything the indicator editor needs behind it.
 *
 * The editor's whole point is that someone can go from "I want to monitor this"
 * to "my script is pushing data" without leaving the screen or reading the
 * documentation — so simulating, probing and script generation all live here
 * next to the CRUD.
 */

interface Activity {
  lastCheckAt: string | null
  lastCheckStatus: string | null
  lastCheckMessage: string | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
}

/**
 * When each of a tenant's controls last reported, last succeeded, last failed.
 *
 * Two queries rather than one, because they cost very different things. The
 * latest row per control walks `checks_control_ts_idx` backwards and stops at
 * the first hit — cheap however much history there is. "When did this last
 * fail" cannot stop early on a control that never has: there is no row to find,
 * so it reads the retained window either way, and a filtered aggregate does
 * that once for the whole tenant instead of once per control.
 *
 * Bounded by retention rather than by a window chosen here. `retention_days`
 * already decides how far back anything is knowable, so "no failure recorded"
 * means exactly that — within what the instance still keeps.
 *
 * Synthetic rows are excluded for the same reason they are excluded from SLA:
 * a simulated outage is not an outage, and the editor's preview data should
 * never make a healthy control look like it broke.
 *
 * Failure follows `countsAsDown` — down or partial. Degraded is deliberately
 * not a failure here, or every slow minute would reset a figure people read as
 * "when did this last break".
 */
async function lastActivity(
  app: Parameters<FastifyPluginAsyncZod>[0],
  tenantId: string,
): Promise<Map<string, Activity>> {
  const iso = (v: unknown): string | null =>
    v === null || v === undefined ? null : new Date(v as string).toISOString()

  const latest = (await app.db.execute(sql`
    select distinct on (control_id) control_id, ts, status, message
    from checks
    where tenant_id = ${tenantId} and synthetic = false
    order by control_id, ts desc
  `)) as unknown as {
    control_id: string
    ts: string
    status: string
    message: string | null
  }[]

  const extremes = (await app.db.execute(sql`
    select control_id,
           max(ts) filter (where status = 'operational') as last_success_at,
           max(ts) filter (where status in ('down', 'partial')) as last_failure_at
    from checks
    where tenant_id = ${tenantId} and synthetic = false
    group by control_id
  `)) as unknown as {
    control_id: string
    last_success_at: string | null
    last_failure_at: string | null
  }[]

  const out = new Map<string, Activity>()
  const at = (id: string): Activity => {
    const existing = out.get(id)
    if (existing) return existing
    const fresh: Activity = {
      lastCheckAt: null,
      lastCheckStatus: null,
      lastCheckMessage: null,
      lastSuccessAt: null,
      lastFailureAt: null,
    }
    out.set(id, fresh)
    return fresh
  }

  for (const row of latest) {
    const entry = at(row.control_id)
    entry.lastCheckAt = iso(row.ts)
    entry.lastCheckStatus = row.status
    entry.lastCheckMessage = row.message ?? null
  }

  for (const row of extremes) {
    const entry = at(row.control_id)
    entry.lastSuccessAt = iso(row.last_success_at)
    entry.lastFailureAt = iso(row.last_failure_at)
  }

  return out
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/:slug/controls',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('status:read:all')],
      schema: {
        params: z.object({ slug: z.string() }),
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              key: z.string(),
              name: z.string(),
              description: z.string().nullable(),
              groupId: z.string().nullable(),
              kind: z.string(),
              /* The probe spec. Returned so the editor can reopen a control on
                 the target it is actually checking, rather than on a blank form
                 that would overwrite it on save. */
              config: z.record(z.string(), z.unknown()),
              isPublic: z.boolean(),
              enabled: z.boolean(),
              expectedIntervalS: z.number().nullable(),
              degradedThresholdMs: z.number().nullable(),
              downThresholdMs: z.number().nullable(),
              valueUnit: z.string().nullable(),
              valueLabel: z.string().nullable(),
              slaTarget: z.number().nullable(),
              widget: z.string(),
              widgetOptions: z.record(z.string(), z.unknown()),
              position: z.number(),
              /* When this control last reported, and what it said. Null on a
                 control nothing has ever pushed to. */
              lastCheckAt: z.string().nullable(),
              lastCheckStatus: z.string().nullable(),
              /* Why it says what it says. The one that matters most here is the
                 scheduler's "no data received within the expected interval":
                 without it, an `unknown` with neither a success nor a failure
                 beside it looks like a contradiction rather than silence. */
              lastCheckMessage: z.string().nullable(),
              /* The last time it was well, and the last time it was not —
                 which are not derivable from the line above: a control that is
                 down now still has a last good moment, and knowing how long ago
                 it was is the difference between "just broke" and "nobody
                 noticed for a week". */
              lastSuccessAt: z.string().nullable(),
              lastFailureAt: z.string().nullable(),
            }),
          ),
        },
      },
    },
    async (req) => {
      const tenantId = req.tenant!.id

      const rows = await app.db
        .select()
        .from(schema.controls)
        .where(eq(schema.controls.tenantId, tenantId))
        .orderBy(schema.controls.position)

      const activity = await lastActivity(app, tenantId)

      return rows.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        description: r.description,
        groupId: r.groupId,
        kind: r.kind,
        config: r.config,
        isPublic: r.isPublic,
        enabled: r.enabled,
        expectedIntervalS: r.expectedIntervalS,
        degradedThresholdMs: r.degradedThresholdMs,
        downThresholdMs: r.downThresholdMs,
        valueUnit: r.valueUnit,
        valueLabel: r.valueLabel,
        slaTarget: r.slaTarget,
        widget: r.widget,
        widgetOptions: r.widgetOptions,
        position: r.position,
        lastCheckAt: activity.get(r.id)?.lastCheckAt ?? null,
        lastCheckStatus: activity.get(r.id)?.lastCheckStatus ?? null,
        lastCheckMessage: activity.get(r.id)?.lastCheckMessage ?? null,
        lastSuccessAt: activity.get(r.id)?.lastSuccessAt ?? null,
        lastFailureAt: activity.get(r.id)?.lastFailureAt ?? null,
      }))
    },
  )

  const controlBody = z.object({
    key: z
      .string()
      .min(1)
      .max(200)
      // Constrained because the key appears in URLs, in generated scripts and in
      // alert labels. A space or a quote in any of those is a bug somewhere.
      .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Use lowercase letters, digits, dot, dash or underscore'),
    name: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
    groupId: z.string().uuid().nullable().optional(),
    kind: z.enum(['push', 'http', 'tcp', 'ping', 'dns', 'cert']).default('push'),
    config: z.record(z.string(), z.unknown()).default({}),
    expectedIntervalS: z.number().int().min(10).max(86_400).nullable().optional(),
    degradedThresholdMs: z.number().int().positive().nullable().optional(),
    downThresholdMs: z.number().int().positive().nullable().optional(),
    valueUnit: z.string().max(30).nullable().optional(),
    valueLabel: z.string().max(60).nullable().optional(),
    slaTarget: z.number().int().min(0).max(10_000).nullable().optional(),
    /** Resolved against the web app's widget registry; unknown ids fall back. */
    widget: z.string().max(60).optional(),
    widgetOptions: z.record(z.string(), z.unknown()).optional(),
    isPublic: z.boolean().default(true),
    /**
     * Whether this control is measured at all.
     *
     * The column has been on the table from the start and the schedulers have
     * always honoured it — `local-probes` skips a disabled control, and so does
     * the agent assignment. It was simply never on this body, so nothing could
     * ever set it: every control was created enabled and stayed that way for
     * life. Pausing one meant deleting it and losing its history, which is the
     * opposite of what somebody silencing a noisy check wants.
     *
     * Default true, because a control created without an opinion is one
     * somebody wants measured.
     */
    enabled: z.boolean().default(true),
    position: z.number().int().min(0).default(0),
  })

  app.post(
    '/:slug/controls',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('control:write')],
      schema: {
        params: z.object({ slug: z.string() }),
        body: controlBody,
        response: { 201: z.object({ id: z.string(), key: z.string() }) },
      },
    },
    async (req, reply) => {
      assertThresholdOrder(app, req.body.degradedThresholdMs, req.body.downThresholdMs)
      if (req.body.kind !== 'push') assertProbeConfig(app, req.body.kind, req.body.config)

      const [control] = await app.db
        .insert(schema.controls)
        .values({ ...req.body, tenantId: req.tenant!.id })
        .onConflictDoNothing()
        .returning()

      // The unique index is on (tenant_id, key); a collision means the key is
      // taken, which is worth saying plainly rather than as a constraint error.
      if (!control) throw app.httpErrors.conflict('A control with that key already exists')

      await audit(app, {
        action: 'control.created',
        tenantId: req.tenant!.id,
        actorId: req.actor.userId,
        target: control.id,
        ip: req.ip,
      })

      return reply.code(201).send({ id: control.id, key: control.key })
    },
  )

  app.patch(
    '/:slug/controls/:id',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('control:write')],
      schema: {
        params: z.object({ slug: z.string(), id: z.string().uuid() }),
        body: controlBody.partial(),
        response: { 200: z.object({ ok: z.boolean() }) },
      },
    },
    async (req) => {
      const control = await loadControl(app, req.tenant!.id, req.params.id)
      assertThresholdOrder(
        app,
        req.body.degradedThresholdMs ?? control.degradedThresholdMs,
        req.body.downThresholdMs ?? control.downThresholdMs,
      )

      await app.db
        .update(schema.controls)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(schema.controls.id, control.id))

      await audit(app, {
        action: 'control.updated',
        tenantId: req.tenant!.id,
        actorId: req.actor.userId,
        target: control.id,
        ip: req.ip,
      })

      return { ok: true }
    },
  )

  app.delete(
    '/:slug/controls/:id',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('control:write')],
      schema: {
        params: z.object({ slug: z.string(), id: z.string().uuid() }),
        response: { 200: z.object({ ok: z.boolean() }) },
      },
    },
    async (req) => {
      const control = await loadControl(app, req.tenant!.id, req.params.id)
      await app.db.delete(schema.controls).where(eq(schema.controls.id, control.id))

      await audit(app, {
        action: 'control.deleted',
        tenantId: req.tenant!.id,
        actorId: req.actor.userId,
        target: control.id,
        meta: { key: control.key },
        ip: req.ip,
      })

      return { ok: true }
    },
  )

  /**
   * How the public page is arranged: its density, and the order of the
   * components on it.
   *
   * One endpoint rather than a PATCH per control, and one transaction, because
   * a half-applied reordering is a page with two components claiming position 3
   * — a state no reader could make sense of and no retry would repair.
   *
   * The order is applied exactly as sent. Positions are renumbered from zero on
   * the server so a client that sends 0,1,1,4 still ends up with a total order.
   */
  app.patch(
    '/:slug/layout',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('tenant:settings')],
      schema: {
        params: z.object({ slug: z.string() }),
        body: z.object({
          layout: z.enum(['list', 'grid', 'compact', 'custom']).optional(),
          /*
           * The document a `custom` layout renders.
           *
           * Bounded, and that is the only validation there is. Nothing here
           * parses or sanitises it: it is rendered inside a sandboxed frame
           * with no same-origin and no network, so what it may do is decided by
           * the sandbox rather than by a filter someone will eventually find a
           * way around. A validator here would suggest a safety it is not the
           * one providing.
           */
          customHtml: z.string().max(200_000).nullable().optional(),
          customCss: z.string().max(200_000).nullable().optional(),
          customJs: z.string().max(200_000).nullable().optional(),
          /*
           * The arranged form of the same layout. Validated properly, unlike
           * the document beside it — these are coordinates the server renders
           * from, so a bad one is a broken page rather than a sandboxed one.
           */
          customBlocks: blocksSchema.optional(),
          order: z
            .array(
              z.object({
                controlId: z.string().uuid(),
                groupId: z.string().uuid().nullable().optional(),
              }),
            )
            .max(1000)
            .optional(),
        }),
        response: { 200: z.object({ ok: z.boolean(), reordered: z.number() }) },
      },
    },
    async (req) => {
      const tenantId = req.tenant!.id

      // Every id must belong to this tenant before anything is written. Checking
      // inside the loop would leave the first few controls already moved when a
      // foreign id turned up halfway through.
      const order = req.body.order ?? []
      if (order.length > 0) {
        const owned = await app.db
          .select({ id: schema.controls.id })
          .from(schema.controls)
          .where(eq(schema.controls.tenantId, tenantId))
        const ownedIds = new Set(owned.map((row) => row.id))

        const foreign = order.find((entry) => !ownedIds.has(entry.controlId))
        if (foreign) throw app.httpErrors.notFound('Unknown control in the requested order')
      }

      await app.db.transaction(async (tx) => {
        const document = {
          ...(req.body.customBlocks !== undefined && { customBlocks: req.body.customBlocks }),
          ...(req.body.customHtml !== undefined && { customHtml: req.body.customHtml }),
          ...(req.body.customCss !== undefined && { customCss: req.body.customCss }),
          ...(req.body.customJs !== undefined && { customJs: req.body.customJs }),
        }

        if (req.body.layout || Object.keys(document).length > 0) {
          await tx
            .update(schema.tenants)
            .set({ ...(req.body.layout && { layout: req.body.layout }), ...document })
            .where(eq(schema.tenants.id, tenantId))
        }

        for (const [position, entry] of order.entries()) {
          await tx
            .update(schema.controls)
            .set({
              position,
              // Sent only when the move crossed groups; `undefined` leaves the
              // column alone, which is not the same as clearing it to null.
              ...(entry.groupId === undefined ? {} : { groupId: entry.groupId }),
              updatedAt: new Date(),
            })
            .where(eq(schema.controls.id, entry.controlId))
        }
      })

      await audit(app, {
        action: 'tenant.layout_updated',
        tenantId,
        actorId: req.actor.userId,
        target: tenantId,
        meta: { layout: req.body.layout, reordered: order.length },
        ip: req.ip,
      })

      return { ok: true, reordered: order.length }
    },
  )

  /**
   * Fills a control with plausible history so a widget can be judged on what it
   * looks like with data rather than on an empty axis.
   *
   * Rows are marked `synthetic`, which keeps them out of the continuous
   * aggregates and therefore out of every published uptime figure. A demo must
   * never be able to become someone's SLA number.
   */
  app.post(
    '/:slug/controls/:id/simulate',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('control:write')],
      schema: {
        params: z.object({ slug: z.string(), id: z.string().uuid() }),
        body: z.object({
          days: z.number().int().min(1).max(90).default(30),
          intervalS: z.number().int().min(60).max(3600).default(300),
          targetUptime: z.number().min(0.5).max(1).default(0.995),
          baseLatencyMs: z.number().int().min(1).max(60_000).default(120),
          incidents: z.number().int().min(0).max(20).default(3),
          seed: z.number().int().default(1234),
        }),
        response: { 200: z.object({ inserted: z.number() }) },
      },
    },
    async (req) => {
      const control = await loadControl(app, req.tenant!.id, req.params.id)

      // Replaced rather than appended: running the simulation twice with
      // different settings should show the second result, not both overlaid.
      await purgeSyntheticChecks(app, control.id)

      const to = new Date()
      const from = new Date(to.getTime() - req.body.days * 86_400_000)

      const series = generateMockSeries({
        seed: req.body.seed,
        from,
        to,
        intervalS: req.body.intervalS,
        targetUptime: req.body.targetUptime,
        baseLatencyMs: req.body.baseLatencyMs,
        incidents: req.body.incidents,
      })

      const BATCH = 2000
      for (let i = 0; i < series.length; i += BATCH) {
        await app.db.insert(schema.checks).values(
          series.slice(i, i + BATCH).map((point) => ({
            ts: point.ts,
            tenantId: req.tenant!.id,
            controlId: control.id,
            status: point.status,
            latencyMs: point.latencyMs,
            value: point.value,
            message: point.message,
            synthetic: true,
          })),
        )
      }

      await audit(app, {
        action: 'control.simulated',
        tenantId: req.tenant!.id,
        actorId: req.actor.userId,
        target: control.id,
        meta: { points: series.length },
        ip: req.ip,
      })

      return { inserted: series.length }
    },
  )

  /**
   * Who runs this control's probe, and who could.
   *
   * The question the editor could not answer: it said "11 agents cover this
   * control", which was true and useless — they were all running it. This says
   * which one is responsible, why, and offers the others.
   */
  app.get(
    '/:slug/controls/:id/assignment',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('control:write')],
      schema: {
        params: z.object({ slug: z.string(), id: z.string().uuid() }),
        response: {
          200: z.object({
            policy: z.enum(['single', 'all']),
            /** Explicitly chosen. Empty means the server elects one. */
            pinned: z.array(z.string()),
            /** Who runs it right now, after policy and election. */
            runners: z.array(z.string()),
            candidates: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                site: z.string().nullable(),
                status: z.string(),
                lastSeenAt: z.string().nullable(),
                /** Whether its key allows this control at all. */
                eligible: z.boolean(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const control = await loadControl(app, req.tenant!.id, req.params.id)

      const [assignments, pins, agentRows, keyRows] = await Promise.all([
        assignmentsFor(app, req.tenant!.id),
        app.db
          .select({ agentId: schema.controlAgents.agentId })
          .from(schema.controlAgents)
          .where(eq(schema.controlAgents.controlId, control.id)),
        app.db
          .select()
          .from(schema.agents)
          .where(eq(schema.agents.tenantId, req.tenant!.id))
          .orderBy(schema.agents.createdAt),
        app.db
          .select({ id: schema.apiKeys.id, scopeControlIds: schema.apiKeys.scopeControlIds })
          .from(schema.apiKeys)
          .where(eq(schema.apiKeys.tenantId, req.tenant!.id)),
      ])

      const scopeById = new Map(keyRows.map((k) => [k.id, k.scopeControlIds]))

      return {
        policy: control.probePolicy,
        pinned: pins.map((p) => p.agentId),
        runners: assignments.get(control.id)?.runners ?? [],
        candidates: agentRows
          .filter((agent) => agent.status !== 'revoked')
          .map((agent) => {
            const scope = (agent.apiKeyId ? scopeById.get(agent.apiKeyId) : undefined) ?? []
            return {
              id: agent.id,
              name: agent.name,
              site: agent.site,
              status: agent.status,
              lastSeenAt: agent.lastSeenAt?.toISOString() ?? null,
              // Shown rather than hidden: "this agent cannot run it, and here is
              // why" beats a list that silently omits half the fleet.
              eligible: scope.length === 0 || scope.includes(control.id),
            }
          }),
      }
    },
  )

  app.put(
    '/:slug/controls/:id/assignment',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('control:write')],
      schema: {
        params: z.object({ slug: z.string(), id: z.string().uuid() }),
        body: z.object({
          policy: z.enum(['single', 'all']),
          /** Empty hands the choice back to the election. */
          agentIds: z.array(z.string().uuid()).max(100).default([]),
        }),
        response: { 200: z.object({ ok: z.boolean(), runners: z.array(z.string()) }) },
      },
    },
    async (req) => {
      const control = await loadControl(app, req.tenant!.id, req.params.id)

      // Every id checked against this tenant before anything is written: a
      // foreign agent id must not end up pinned to a control it cannot see.
      if (req.body.agentIds.length > 0) {
        const owned = await app.db
          .select({ id: schema.agents.id })
          .from(schema.agents)
          .where(
            and(
              eq(schema.agents.tenantId, req.tenant!.id),
              inArray(schema.agents.id, req.body.agentIds),
            ),
          )
        if (owned.length !== req.body.agentIds.length) {
          throw app.httpErrors.notFound('Unknown agent in the requested assignment')
        }
      }

      await app.db.transaction(async (tx) => {
        await tx
          .update(schema.controls)
          .set({ probePolicy: req.body.policy, updatedAt: new Date() })
          .where(eq(schema.controls.id, control.id))

        await tx.delete(schema.controlAgents).where(eq(schema.controlAgents.controlId, control.id))

        if (req.body.agentIds.length > 0) {
          await tx
            .insert(schema.controlAgents)
            .values(req.body.agentIds.map((agentId) => ({ controlId: control.id, agentId })))
        }
      })

      await audit(app, {
        action: 'control.assignment_updated',
        tenantId: req.tenant!.id,
        actorId: req.actor.userId,
        target: control.id,
        meta: { policy: req.body.policy, agents: req.body.agentIds.length },
        ip: req.ip,
      })

      const assignments = await assignmentsFor(app, req.tenant!.id)
      return { ok: true, runners: assignments.get(control.id)?.runners ?? [] }
    },
  )

  /**
   * This control's recent points, simulation included.
   *
   * The public uptime endpoint reads the continuous aggregates, which exclude
   * synthetic rows by design — so it can never show what a simulation produced.
   * The editor needs exactly that: the widget drawn on the data just generated,
   * which is the only way to judge a chart before any real data exists.
   */
  app.get(
    '/:slug/controls/:id/series',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('control:write')],
      schema: {
        params: z.object({ slug: z.string(), id: z.string().uuid() }),
        querystring: z.object({
          days: z.coerce.number().int().min(1).max(90).default(30),
          /** Bucketed down to this many points before leaving the server. */
          points: z.coerce.number().int().min(10).max(2000).default(720),
        }),
        response: {
          200: z.object({
            synthetic: z.boolean(),
            points: z.array(
              z.object({
                ts: z.string(),
                status: z.string(),
                latencyMs: z.number().nullable(),
                value: z.number().nullable(),
                metrics: z.record(z.string(), z.number()).optional(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const control = await loadControl(app, req.tenant!.id, req.params.id)
      const from = new Date(Date.now() - req.query.days * 86_400_000)

      const rows = await app.db
        .select({
          ts: schema.checks.ts,
          status: schema.checks.status,
          latencyMs: schema.checks.latencyMs,
          value: schema.checks.value,
          metrics: schema.checks.metrics,
          synthetic: schema.checks.synthetic,
        })
        .from(schema.checks)
        .where(and(eq(schema.checks.controlId, control.id), gte(schema.checks.ts, from)))
        .orderBy(schema.checks.ts)

      const points = downsample(
        rows.map((row) => ({
          ts: row.ts,
          status: row.status,
          latencyMs: row.latencyMs,
          value: row.value === null ? null : Number(row.value),
          metrics: row.metrics ?? undefined,
        })),
        req.query.points,
      )

      return {
        // Said out loud so the editor can label the chart: a preview drawn on
        // simulated data must never be mistaken for the real thing.
        synthetic: rows.length > 0 && rows.every((row) => row.synthetic),
        points: points.map((point) => ({
          ts: point.ts.toISOString(),
          status: point.status,
          latencyMs: point.latencyMs,
          value: point.value,
          metrics: point.metrics,
        })),
      }
    },
  )

  app.delete(
    '/:slug/controls/:id/simulate',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('control:write')],
      schema: {
        params: z.object({ slug: z.string(), id: z.string().uuid() }),
        response: { 200: z.object({ deleted: z.number() }) },
      },
    },
    async (req) => {
      const control = await loadControl(app, req.tenant!.id, req.params.id)
      const deleted = await purgeSyntheticChecks(app, control.id)
      return { deleted }
    },
  )

  /**
   * Runs a probe once and reports what each assertion saw.
   *
   * Discovering that a probe is misconfigured during an actual outage is the
   * worst possible moment, so it can be tried before it is saved.
   */
  app.post(
    '/:slug/probe/run',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('control:write')],
      schema: {
        params: z.object({ slug: z.string() }),
        body: z.object({ probe: probeSchema }),
        response: {
          200: z.object({
            status: z.string(),
            latencyMs: z.number().nullable(),
            value: z.number().nullable(),
            message: z.string().nullable(),
            assertions: z.array(
              z.object({
                type: z.string(),
                passed: z.boolean(),
                severity: z.string(),
                detail: z.string(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const result = await runProbe(req.body.probe)
      // `debug` is deliberately not returned: it can hold a full response body,
      // and this endpoint is reachable by anyone who can edit a control.
      return {
        status: result.status,
        latencyMs: result.latencyMs,
        value: result.value,
        message: result.message,
        assertions: result.assertions,
      }
    },
  )

  /**
   * Runs one control's own probe now, and records the result.
   *
   * The difference from `/probe/run` above is the recording. That one is the
   * editor's dry run — it answers "is this spec right" and writes nothing. This
   * one is the operator's "measure it now, I am not waiting for the interval",
   * so what comes back lands in `checks` like any other sample and the control
   * stops sitting at `unknown`.
   *
   * Three things it refuses, each for a different reason:
   *
   *  - A **push** control has no probe. Nothing here could run it; the thing
   *    that pushes to it is the only thing that can.
   *  - A **disabled** control is one somebody switched off. Writing a sample
   *    for it would put a point on a series that is supposed to have stopped.
   *  - A control a **live remote agent** owns is measured from somewhere this
   *    process cannot see — that is why the agent exists. A result taken here
   *    would be the server's opinion of a network it is not on, interleaved
   *    into the agent's series. The instance's own agent does not count: it
   *    shares this machine, so there is no second vantage point to create.
   */
  app.post(
    '/:slug/controls/:id/check',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('control:write')],
      schema: {
        params: z.object({ slug: z.string(), id: z.string().uuid() }),
        response: {
          200: z.object({
            at: z.string(),
            status: z.string(),
            latencyMs: z.number().nullable(),
            value: z.number().nullable(),
            message: z.string().nullable(),
          }),
        },
      },
    },
    async (req) => {
      const tenantId = req.tenant!.id

      const [control] = await app.db
        .select()
        .from(schema.controls)
        .where(and(eq(schema.controls.id, req.params.id), eq(schema.controls.tenantId, tenantId)))
        .limit(1)

      if (!control) throw app.httpErrors.notFound('No such control')

      if (control.kind === 'push') {
        throw app.httpErrors.badRequest(
          'This control is pushed to, so there is no probe to run. It updates when whatever reports to it next reports.',
        )
      }

      if (!control.enabled) {
        throw app.httpErrors.badRequest('This control is disabled. Enable it before checking it.')
      }

      const parsed = probeSchema.safeParse({ type: control.kind, ...control.config })
      if (!parsed.success) {
        throw app.httpErrors.badRequest(
          'This control has no valid probe configuration — open it and fix the target first.',
        )
      }

      const coverage = await agentCoverage(app, Date.now())
      if (coverage.fullyCoveredRemote.has(tenantId) || coverage.claimedRemote.has(control.id)) {
        throw app.httpErrors.conflict(
          'An agent runs this control from its own network, which this server cannot see. It will report on its next interval.',
        )
      }

      const result = await runProbe(parsed.data)
      const at = new Date()

      await app.db.insert(schema.checks).values({
        ts: at,
        tenantId,
        controlId: control.id,
        status: result.status,
        latencyMs: result.latencyMs,
        value: result.value,
        message: result.message,
      })

      await audit(app, {
        action: 'control.check.forced',
        tenantId,
        actorId: req.actor.userId,
        target: control.id,
        meta: { key: control.key, status: result.status },
      })

      return {
        at: at.toISOString(),
        status: result.status,
        latencyMs: result.latencyMs,
        value: result.value,
        // As with the dry run, `debug` stays out: it can carry a whole response
        // body, and this is reachable by anyone who can edit a control.
        message: result.message,
      }
    },
  )

  /**
   * The generated push scripts, all ten at once, with this control's key and
   * thresholds already in place.
   */
  app.get(
    '/:slug/controls/:id/scripts',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('control:write')],
      schema: {
        params: z.object({ slug: z.string(), id: z.string().uuid() }),
        querystring: z.object({
          /** Optional: inline a key the caller has just created. */
          apiKey: z.string().max(200).optional(),
        }),
        response: {
          200: z.object({
            languages: z.array(
              z.object({
                id: z.string(),
                label: z.string(),
                extension: z.string(),
                syntax: z.string(),
              }),
            ),
            scripts: z.record(z.string(), z.string()),
            /** The Rust agent's equivalent: a config file and two commands. */
            agent: z.object({
              config: z.string(),
              pairCommand: z.string(),
              runCommand: z.string(),
            }),
          }),
        },
      },
    },
    async (req) => {
      const control = await loadControl(app, req.tenant!.id, req.params.id)

      const scripts = renderAllTemplates({
        baseUrl: config.PUBLIC_BASE_URL,
        controlKey: control.key,
        // A placeholder unless the caller passes a freshly minted key: existing
        // keys are stored only as hashes and cannot be recovered to inline here.
        apiKey: req.query.apiKey ?? 'tern_YOUR_API_KEY',
        degradedMs: control.degradedThresholdMs ?? undefined,
        downMs: control.downThresholdMs ?? undefined,
        // The widget decides what the script sends. Choosing a numeric chart
        // and receiving a script that pushes only a status is how someone ends
        // up with a working cron job and an empty graph.
        payloadShape: payloadShapeForWidget(control.widget),
        valueUnit: control.valueUnit ?? undefined,
        valueLabel: control.valueLabel ?? undefined,
      })

      return {
        languages: SCRIPT_TEMPLATES.map((t) => ({
          id: t.id,
          label: t.label,
          extension: t.extension,
          syntax: t.syntax,
        })),
        scripts,
        agent: {
          config: renderAgentConfig({
            baseUrl: config.PUBLIC_BASE_URL,
            controlKey: control.key,
            apiKey: req.query.apiKey ?? 'tern_YOUR_API_KEY',
            intervalS: control.expectedIntervalS ?? undefined,
            // The control's own probe, so the file the editor shows is the one
            // that would run this control — not a generic example.
            probe:
              control.kind === 'push'
                ? undefined
                : { type: control.kind, ...(control.config as Record<string, unknown>) },
            degradedMs: control.degradedThresholdMs ?? undefined,
            downMs: control.downThresholdMs ?? undefined,
          }),
          // The PIN is deliberately absent: it is minted on demand from the
          // agent tab, so one is never left sitting in a cached response.
          pairCommand: renderAgentPairCommand(config.PUBLIC_BASE_URL),
          runCommand: renderAgentRunCommand(),
        },
      }
    },
  )
}

async function loadControl(
  app: Parameters<FastifyPluginAsyncZod>[0],
  tenantId: string,
  id: string,
) {
  const [control] = await app.db
    .select()
    .from(schema.controls)
    // Scoped by tenant: an id from elsewhere must 404, not load.
    .where(and(eq(schema.controls.id, id), eq(schema.controls.tenantId, tenantId)))
    .limit(1)
  if (!control) throw app.httpErrors.notFound('Unknown control')
  return control
}

/**
 * A `degraded` threshold above `down` would make the degraded band
 * unreachable — the control would jump straight from healthy to down and the
 * middle state would silently never appear.
 */
function assertThresholdOrder(
  app: Parameters<FastifyPluginAsyncZod>[0],
  degraded: number | null | undefined,
  down: number | null | undefined,
) {
  if (degraded != null && down != null && degraded >= down) {
    throw app.httpErrors.badRequest(
      'The degraded threshold must be below the down threshold, or the degraded state can never occur',
    )
  }
}

/** A non-push control without a valid probe would silently never run. */
function assertProbeConfig(
  app: Parameters<FastifyPluginAsyncZod>[0],
  kind: string,
  probeConfig: Record<string, unknown>,
) {
  const parsed = probeSchema.safeParse({ type: kind, ...probeConfig })
  if (!parsed.success) {
    throw app.httpErrors.badRequest(
      `Invalid probe configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    )
  }
}

export default routes

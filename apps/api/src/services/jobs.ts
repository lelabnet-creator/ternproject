import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { schema } from '@tern/db'
import { defaultAssertions, payloadShapeForWidget, toAgentProbe } from '@tern/shared'
import { runnersFor, type EligibleAgent } from './assignment.js'

/**
 * What an agent is supposed to run.
 *
 * Handed over at pairing and readable again afterwards, so an agent is
 * configured by the server rather than by someone editing TOML on the host it
 * monitors. The alternative — a paired agent that knows a credential and
 * nothing else — puts the list of probes in two places and lets them drift.
 *
 * Scope comes from the pairing code: a code created for particular controls
 * yields exactly those, and an unscoped one yields every probe control the
 * tenant has. That is the assignment mechanism, already in the schema, rather
 * than a second one invented here.
 */

export interface AgentJob {
  controlKey: string
  /** Seconds between runs; the agent's file-level interval when absent. */
  intervalS: number | null
  /** Snake-cased, because the agent reads the same shape from JSON and TOML. */
  probe: Record<string, unknown>
  assertions: Record<string, unknown>[]
  /**
   * What the control's widget will draw.
   *
   * Carried so the agent can say something when a control expects a measurement
   * and its probe captures none — the case where every part reports success and
   * the chart stays empty.
   */
  payloadShape: 'status' | 'value'
}

/**
 * Everything the tenant could probe, with the agents that should run each.
 *
 * Computed in one place so the job list an agent receives and the owner the
 * admin is shown can never disagree — the previous behaviour, where every agent
 * got every probe, was invisible precisely because nothing ever said who was
 * responsible.
 */
export async function assignmentsFor(
  app: FastifyInstance,
  tenantId: string,
): Promise<Map<string, { control: ControlRow; runners: string[] }>> {
  const [controls, agentRows, keyRows, pins] = await Promise.all([
    app.db
      .select()
      .from(schema.controls)
      .where(and(eq(schema.controls.tenantId, tenantId), eq(schema.controls.enabled, true))),
    app.db.select().from(schema.agents).where(eq(schema.agents.tenantId, tenantId)),
    app.db
      .select({ id: schema.apiKeys.id, scopeControlIds: schema.apiKeys.scopeControlIds })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.tenantId, tenantId)),
    app.db
      .select()
      .from(schema.controlAgents)
      .innerJoin(schema.controls, eq(schema.controls.id, schema.controlAgents.controlId))
      .where(eq(schema.controls.tenantId, tenantId)),
  ])

  const scopeByKey = new Map(keyRows.map((k) => [k.id, k.scopeControlIds]))
  const agents: EligibleAgent[] = agentRows.map((row) => ({
    id: row.id,
    status: row.status,
    lastSeenAt: row.lastSeenAt,
    scopeControlIds: (row.apiKeyId ? scopeByKey.get(row.apiKeyId) : undefined) ?? [],
  }))

  const pinnedByControl = new Map<string, string[]>()
  for (const row of pins) {
    const list = pinnedByControl.get(row.control_agents.controlId)
    if (list) list.push(row.control_agents.agentId)
    else pinnedByControl.set(row.control_agents.controlId, [row.control_agents.agentId])
  }

  const out = new Map<string, { control: ControlRow; runners: string[] }>()
  for (const control of controls) {
    if (control.kind === 'push') continue

    out.set(control.id, {
      control,
      runners: runnersFor(
        {
          controlId: control.id,
          policy: control.probePolicy,
          pinned: pinnedByControl.get(control.id) ?? [],
        },
        agents,
      ),
    })
  }

  return out
}

type ControlRow = typeof schema.controls.$inferSelect

export async function jobsForAgent(
  app: FastifyInstance,
  tenantId: string,
  scopeControlIds: string[] | null,
  /**
   * The agent asking. When absent — a key with no agent behind it, such as one
   * minted by hand — every control in scope is returned, which is the old
   * behaviour and the right one for a caller the assignment cannot name.
   */
  agentId?: string,
): Promise<AgentJob[]> {
  if (agentId) {
    const assignments = await assignmentsFor(app, tenantId)
    return [...assignments.values()]
      .filter(({ runners }) => runners.includes(agentId))
      .map(({ control }) => jobFrom(control))
  }

  const scoped = scopeControlIds && scopeControlIds.length > 0
  const rows = await app.db
    .select()
    .from(schema.controls)
    .where(
      scoped
        ? and(
            eq(schema.controls.tenantId, tenantId),
            inArray(schema.controls.id, scopeControlIds),
            eq(schema.controls.enabled, true),
          )
        : and(eq(schema.controls.tenantId, tenantId), eq(schema.controls.enabled, true)),
    )

  return (
    rows
      // A push control has nothing for an agent to run: it is fed by a script.
      // Sending it anyway would have the agent probe a URL nobody configured.
      .filter((control) => control.kind !== 'push')
      .map(jobFrom)
  )
}

function jobFrom(control: typeof schema.controls.$inferSelect): AgentJob {
  const config = (control.config ?? {}) as Record<string, unknown>
  const declared = Array.isArray(config.assertions)
    ? (config.assertions as Record<string, unknown>[])
    : []

  return {
    controlKey: control.key,
    intervalS: control.expectedIntervalS,
    probe: { type: control.kind, ...toAgentProbe(config) },
    // A probe with no assertions calls a 500 healthy, so the thresholds the
    // operator already set on the control stand in for their intent.
    assertions:
      declared.length > 0
        ? declared
        : defaultAssertions({
            baseUrl: '',
            controlKey: control.key,
            apiKey: '',
            probe: { type: control.kind },
            degradedMs: control.degradedThresholdMs ?? undefined,
            downMs: control.downThresholdMs ?? undefined,
          }),
    payloadShape: payloadShapeForWidget(control.widget),
  }
}

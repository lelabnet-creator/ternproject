import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { schema } from '@tern/db'
import { defaultAssertions, payloadShapeForWidget, toAgentProbe } from '@tern/shared'

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

export async function jobsForAgent(
  app: FastifyInstance,
  tenantId: string,
  scopeControlIds: string[] | null,
): Promise<AgentJob[]> {
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
      .map((control) => {
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
      })
  )
}

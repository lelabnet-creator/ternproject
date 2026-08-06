import { and, desc, eq, ne } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { schema } from '@tern/db'
import { probeSchema, type Probe } from '@tern/shared'
import { OWNER_STALE_MS } from './assignment.js'
import { runProbe } from './probe-transport.js'

/**
 * The instance's own agent.
 *
 * A control of kind `http`, `tcp`, `ping`, `dns` or `cert` describes a check
 * that somebody has to actually perform. Until this existed, nobody did: the
 * probe was handed to paired agents and to nothing else, so an installation
 * with no agent could define a perfectly good HTTP check and watch it sit at
 * `unknown` forever. `runProbe` was reachable only through the admin's dry-run
 * button — one execution, on demand, recorded nowhere.
 *
 * So the server runs them itself, and a fresh install monitors something
 * without deploying anything.
 *
 * ## What it will not take
 *
 * A control covered by a **live** agent is left alone. The remote agent is
 * there for a reason — it sits where the server cannot see — and two runners
 * pushing the same control would double its sample rate and interleave two
 * vantage points into one series. Liveness uses the same staleness window as
 * ownership election, so an agent that stops reporting hands its controls back
 * here within ten minutes rather than leaving them dark.
 *
 * ## On reaching private addresses
 *
 * This deliberately does **not** apply the loopback/RFC 1918/metadata refusal
 * that outbound webhooks get. The two are different requests: a webhook URL is
 * a place this server is told to send data, where an internal address is the
 * shape of an SSRF; a probe target is a thing the operator is asking to
 * monitor, and monitoring the machine's own services is the main reason to
 * self-host. Probes are writable only by an admin of the tenant, and the result
 * recorded is a status and a latency — not the response body.
 */

/** Ten seconds is the floor `expectedIntervalS` allows; it is also the default. */
const DEFAULT_INTERVAL_S = 60

interface Due {
  tenantId: string
  controlId: string
  key: string
  probe: Probe
}

/**
 * Controls this instance should probe right now.
 *
 * Read in one pass rather than per tenant: the whole point of the job is to be
 * cheap enough to run every few seconds.
 */
async function due(app: FastifyInstance, now: number): Promise<Due[]> {
  const controls = await app.db
    .select({
      id: schema.controls.id,
      tenantId: schema.controls.tenantId,
      key: schema.controls.key,
      kind: schema.controls.kind,
      config: schema.controls.config,
      expectedIntervalS: schema.controls.expectedIntervalS,
    })
    .from(schema.controls)
    .where(and(ne(schema.controls.kind, 'push'), eq(schema.controls.enabled, true)))

  if (controls.length === 0) return []

  // An agent's scope lives on the API key it paired with, not on the agent —
  // the same join `GET /controls/:id/assignment` does.
  const agents = await app.db
    .select({
      tenantId: schema.agents.tenantId,
      status: schema.agents.status,
      lastSeenAt: schema.agents.lastSeenAt,
      scopeControlIds: schema.apiKeys.scopeControlIds,
    })
    .from(schema.agents)
    .leftJoin(schema.apiKeys, eq(schema.apiKeys.id, schema.agents.apiKeyId))

  const claimedByLiveAgent = new Set<string>()
  /** Tenants where a live agent covers everything, because its scope is empty. */
  const tenantsFullyCovered = new Set<string>()

  for (const agent of agents) {
    if (agent.status === 'revoked') continue
    if (!agent.lastSeenAt || now - agent.lastSeenAt.getTime() > OWNER_STALE_MS) continue

    const scope = agent.scopeControlIds ?? []
    // An empty scope is not "nothing" — it is the key's whole tenant. Reading it
    // as an empty list would have this job racing an agent that is already
    // running every control it has.
    if (scope.length === 0) tenantsFullyCovered.add(agent.tenantId)
    else for (const id of scope) claimedByLiveAgent.add(id)
  }

  const result: Due[] = []

  for (const control of controls) {
    if (tenantsFullyCovered.has(control.tenantId)) continue
    if (claimedByLiveAgent.has(control.id)) continue

    // A malformed spec is not this job's problem to report — the editor
    // validates on save and the dry-run says why. Skipping keeps one bad
    // control from stopping every other one.
    const parsed = probeSchema.safeParse({ type: control.kind, ...control.config })
    if (!parsed.success) continue

    const intervalMs = (control.expectedIntervalS ?? DEFAULT_INTERVAL_S) * 1000

    const [last] = await app.db
      .select({ ts: schema.checks.ts })
      .from(schema.checks)
      .where(eq(schema.checks.controlId, control.id))
      .orderBy(desc(schema.checks.ts))
      .limit(1)

    if (last && now - last.ts.getTime() < intervalMs) continue

    result.push({
      tenantId: control.tenantId,
      controlId: control.id,
      key: control.key,
      probe: parsed.data,
    })
  }

  return result
}

/**
 * Runs every probe that is due and records what happened.
 *
 * Returns the number of controls measured, which is what the job log reports.
 */
export async function runLocalProbes(app: FastifyInstance): Promise<number> {
  const now = Date.now()
  const items = await due(app, now)
  if (items.length === 0) return 0

  // Sequential on purpose. A hundred controls firing at once from one process
  // is a burst the monitored systems feel, and this job has no deadline —
  // being a few seconds late is invisible, being a load generator is not.
  const rows = []
  for (const item of items) {
    try {
      const result = await runProbe(item.probe)
      rows.push({
        ts: new Date(),
        tenantId: item.tenantId,
        controlId: item.controlId,
        status: result.status,
        latencyMs: result.latencyMs,
        value: result.value,
        message: result.message,
      })
    } catch (error) {
      // A probe that throws rather than returning a failure is a bug in the
      // transport, not a service outage — recording it as `down` would put a
      // red bar on a customer's page for our own defect.
      app.log.error({ err: error, control: item.key }, 'local probe threw')
    }
  }

  if (rows.length > 0) await app.db.insert(schema.checks).values(rows)
  return rows.length
}

export const __testables = { due }

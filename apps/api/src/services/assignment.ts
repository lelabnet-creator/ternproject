/**
 * Which agent runs which probe.
 *
 * The defect this exists to fix: an agent's key covers every control by
 * default, so eleven paired agents all ran the same probe — eleven identical
 * requests a minute at the monitored thing, eleven near-duplicate points a
 * minute in the hypertable, and no way to answer "which one is actually
 * checking this".
 *
 * Three rules, in this order:
 *
 * 1. **Pinned wins.** If anyone has been explicitly assigned to a control, only
 *    those agents run it. That is what the admin's choice means.
 * 2. **`all` means all.** Probing one endpoint from several sites is how you
 *    tell "the service is down" from "the service is unreachable from Paris".
 *    It has to be asked for, and then it is honoured exactly.
 * 3. **Otherwise, elect one.** Deterministically, from the eligible agents, so
 *    every agent computes the same answer without coordinating — and prefer one
 *    that has been heard from recently, so a silent agent hands the work over
 *    rather than taking a control down with it.
 *
 * The election is pure and lives here so it can be tested without a database
 * and reported to the UI without a second implementation.
 */

/** Contact older than this and an agent is not trusted to hold an assignment. */
export const OWNER_STALE_MS = 10 * 60 * 1000

export interface EligibleAgent {
  id: string
  status: string
  lastSeenAt: Date | null
  /** Empty means the key covers every control. */
  scopeControlIds: string[]
}

export function coversControl(agent: EligibleAgent, controlId: string): boolean {
  return agent.scopeControlIds.length === 0 || agent.scopeControlIds.includes(controlId)
}

/**
 * The agent that should run this control, or null when none can.
 *
 * Ordering is (fresh before stale, then id) rather than (most recently seen):
 * "most recent" reshuffles every time a heartbeat lands, and an assignment that
 * moves every minute is one nobody can reason about. Freshness is a threshold,
 * not a ranking.
 */
export function electOwner(
  agents: EligibleAgent[],
  controlId: string,
  now = Date.now(),
): string | null {
  const eligible = agents
    .filter((agent) => agent.status !== 'revoked' && coversControl(agent, controlId))
    .sort((a, b) => {
      const aFresh = isFresh(a, now)
      const bFresh = isFresh(b, now)
      if (aFresh !== bFresh) return aFresh ? -1 : 1
      return a.id.localeCompare(b.id)
    })

  return eligible[0]?.id ?? null
}

function isFresh(agent: EligibleAgent, now: number): boolean {
  if (!agent.lastSeenAt) return false
  return now - agent.lastSeenAt.getTime() <= OWNER_STALE_MS
}

export interface ControlAssignment {
  controlId: string
  policy: 'single' | 'all'
  /** Explicitly assigned agents. Empty means the election decides. */
  pinned: string[]
}

/**
 * Everyone who should run this control right now.
 *
 * Returns ids rather than a boolean so one pass answers both questions the
 * product asks: "does this agent run it" for the job list, and "who runs it"
 * for the editor and the fleet screen.
 */
export function runnersFor(
  assignment: ControlAssignment,
  agents: EligibleAgent[],
  now = Date.now(),
): string[] {
  const live = agents.filter((agent) => agent.status !== 'revoked')

  if (assignment.pinned.length > 0) {
    // Pinned agents that have since been revoked are dropped, not honoured: the
    // alternative is a control assigned to something that cannot run it.
    const alive = assignment.pinned.filter((id) => live.some((agent) => agent.id === id))
    if (alive.length > 0) return alive
    // Every pin gone — fall through to the election rather than leaving the
    // control unmonitored. A thing that quietly stops being watched is worse
    // than one watched by an agent nobody chose.
  }

  if (assignment.policy === 'all') {
    return live.filter((agent) => coversControl(agent, assignment.controlId)).map((a) => a.id)
  }

  const owner = electOwner(live, assignment.controlId, now)
  return owner ? [owner] : []
}

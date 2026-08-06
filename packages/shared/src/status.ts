import { z } from 'zod'

/**
 * The status vocabulary, and the rules for combining statuses.
 *
 * Kept in one place because three different layers need to agree on it: the
 * ingestion API, the aggregation that rolls a group up from its children, and
 * the page that renders a colour and a sentence.
 */

export const checkStatusSchema = z.enum([
  'operational',
  'degraded',
  'partial',
  'down',
  'maintenance',
  'unknown',
])
export type CheckStatusValue = z.infer<typeof checkStatusSchema>

/**
 * Ordered worst-last. `maintenance` sits above `operational` but below any real
 * problem: planned work should be visible without claiming the service is
 * broken, and it must never mask an actual outage happening at the same time.
 *
 * `unknown` ranks below `degraded` deliberately — losing contact with a probe
 * is a reporting failure, and treating it as an outage turns every network
 * hiccup into a false alarm on a public page.
 */
const SEVERITY_ORDER: readonly CheckStatusValue[] = [
  'operational',
  'maintenance',
  'unknown',
  'degraded',
  'partial',
  'down',
]

export function severityRank(status: CheckStatusValue): number {
  const index = SEVERITY_ORDER.indexOf(status)
  return index === -1 ? 0 : index
}

export function worstStatus(statuses: readonly CheckStatusValue[]): CheckStatusValue {
  if (statuses.length === 0) return 'unknown'
  return statuses.reduce((worst, s) => (severityRank(s) > severityRank(worst) ? s : worst))
}

/** Whether a status should count against availability. */
export function countsAsDown(status: CheckStatusValue): boolean {
  return status === 'down' || status === 'partial'
}

/**
 * The headline status for a whole page.
 *
 * Differs from `worstStatus` in one respect: a component with no data does not
 * drag the entire page to "status unavailable". One silent probe out of ten is
 * a gap in reporting, not an outage of the service — and a page announcing
 * "status unavailable" while nine components read Operational is telling its
 * readers something false.
 *
 * When every component is unknown there is genuinely nothing to report, and the
 * page says so.
 */
export function overallStatus(statuses: readonly CheckStatusValue[]): CheckStatusValue {
  if (statuses.length === 0) return 'unknown'

  const known = statuses.filter((s) => s !== 'unknown')
  return known.length === 0 ? 'unknown' : worstStatus(known)
}

export const incidentImpactSchema = z.enum(['degraded', 'partial', 'major'])
export type IncidentImpactValue = z.infer<typeof incidentImpactSchema>

/** An incident's per-component impact expressed as the status to display. */
export function impactToStatus(impact: IncidentImpactValue): CheckStatusValue {
  switch (impact) {
    case 'degraded':
      return 'degraded'
    case 'partial':
      return 'partial'
    case 'major':
      return 'down'
  }
}

export const statusRollupSchema = z.enum(['worst', 'majority', 'manual'])
export type StatusRollupValue = z.infer<typeof statusRollupSchema>

/**
 * Rolls a group's status up from its children.
 *
 * `majority` exists for redundant fleets, where one node of twenty being down
 * is not a user-visible outage — but it still surfaces as `degraded` rather
 * than green, because "some of it is broken" is never "all systems
 * operational".
 */
export function rollupStatus(
  children: readonly CheckStatusValue[],
  strategy: StatusRollupValue,
): CheckStatusValue {
  if (children.length === 0) return 'unknown'
  if (strategy === 'manual' || strategy === 'worst') return worstStatus(children)

  const unhealthy = children.filter((s) => s !== 'operational' && s !== 'maintenance')
  if (unhealthy.length === 0) return worstStatus(children)
  if (unhealthy.length * 2 > children.length) return worstStatus(unhealthy)
  return 'degraded'
}

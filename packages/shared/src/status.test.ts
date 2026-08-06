import { describe, expect, it } from 'vitest'
import { impactToStatus, overallStatus, rollupStatus, worstStatus } from './status.js'

describe('worstStatus', () => {
  it('reports the most severe status present', () => {
    expect(worstStatus(['operational', 'degraded', 'down'])).toBe('down')
    expect(worstStatus(['operational', 'operational'])).toBe('operational')
  })

  it('ranks a real problem above planned maintenance', () => {
    // Maintenance must not mask an outage that happens during the window,
    // otherwise a status page goes quiet exactly when it matters.
    expect(worstStatus(['maintenance', 'down'])).toBe('down')
    expect(worstStatus(['maintenance', 'operational'])).toBe('maintenance')
  })

  it('ranks lost contact below a known degradation', () => {
    // `unknown` is a reporting failure, not an outage. Ranking it higher would
    // turn every network hiccup into a public incident.
    expect(worstStatus(['unknown', 'degraded'])).toBe('degraded')
    expect(worstStatus(['unknown', 'operational'])).toBe('unknown')
  })

  it('treats an empty set as unknown rather than healthy', () => {
    expect(worstStatus([])).toBe('unknown')
  })
})

describe('rollupStatus', () => {
  it('propagates the worst child under the worst strategy', () => {
    expect(rollupStatus(['operational', 'operational', 'down'], 'worst')).toBe('down')
  })

  it('softens an isolated failure under the majority strategy', () => {
    const fleet = [...Array<'operational'>(19).fill('operational'), 'down' as const]
    expect(rollupStatus(fleet, 'majority')).toBe('degraded')
  })

  it('never reports a partly broken group as operational', () => {
    // The point of `majority` is to avoid crying outage, not to hide failures.
    const fleet = [...Array<'operational'>(19).fill('operational'), 'down' as const]
    expect(rollupStatus(fleet, 'majority')).not.toBe('operational')
  })

  it('propagates the failure once a majority is affected', () => {
    expect(rollupStatus(['down', 'down', 'operational'], 'majority')).toBe('down')
  })

  it('ignores maintenance when deciding whether a majority is unhealthy', () => {
    expect(rollupStatus(['maintenance', 'maintenance', 'operational'], 'majority')).toBe(
      'maintenance',
    )
  })
})

describe('impactToStatus', () => {
  it('maps each incident impact onto the status shown per component', () => {
    expect(impactToStatus('degraded')).toBe('degraded')
    expect(impactToStatus('partial')).toBe('partial')
    expect(impactToStatus('major')).toBe('down')
  })
})

describe('overallStatus', () => {
  it('does not let one silent component blank the whole page', () => {
    // Found by looking at a running page: nine components read Operational and
    // the headline said "status unavailable". One gap in reporting is not an
    // outage of the service, and saying so is false.
    expect(overallStatus(['operational', 'operational', 'unknown'])).toBe('operational')
  })

  it('still reports a real problem over a gap', () => {
    expect(overallStatus(['operational', 'unknown', 'down'])).toBe('down')
    expect(overallStatus(['unknown', 'degraded'])).toBe('degraded')
  })

  it('reports unknown only when there is genuinely nothing to report', () => {
    expect(overallStatus(['unknown', 'unknown'])).toBe('unknown')
    expect(overallStatus([])).toBe('unknown')
  })
})

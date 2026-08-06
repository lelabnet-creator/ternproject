import { describe, expect, it } from 'vitest'
import { freshnessOf, type GalaxyAgent } from './AgentGalaxy'

const NOW = Date.UTC(2026, 7, 6, 12, 0, 0)
const agent = (over: Partial<GalaxyAgent> = {}): GalaxyAgent => ({
  id: 'a',
  name: 'Agent',
  site: null,
  status: 'active',
  lastSeenAt: new Date(NOW - 60_000).toISOString(),
  jobCount: 3,
  ...over,
})

describe('how fresh an agent looks', () => {
  it('is fresh a minute after its last report', () => {
    expect(freshnessOf(agent(), NOW)).toBe('fresh')
  })

  it('turns stale, then silent, as the gap widens', () => {
    expect(freshnessOf(agent({ lastSeenAt: new Date(NOW - 20 * 60_000).toISOString() }), NOW)).toBe(
      'stale',
    )
    expect(
      freshnessOf(agent({ lastSeenAt: new Date(NOW - 3 * 3600_000).toISOString() }), NOW),
    ).toBe('silent')
  })

  it('treats an agent that never reported as silent, not as fresh', () => {
    // The dangerous default: a null timestamp reading as "no news is good news"
    // would paint a fleet green that has never said anything.
    expect(freshnessOf(agent({ lastSeenAt: null }), NOW)).toBe('silent')
  })

  it('shows a revoked agent as revoked however recently it spoke', () => {
    expect(freshnessOf(agent({ status: 'revoked' }), NOW)).toBe('revoked')
  })
})

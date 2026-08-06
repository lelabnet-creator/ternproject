import { describe, expect, it } from 'vitest'
import { electOwner, runnersFor, type EligibleAgent } from './assignment.js'

const NOW = Date.UTC(2026, 7, 6, 12, 0, 0)
const CONTROL = 'control-1'

const agent = (id: string, over: Partial<EligibleAgent> = {}): EligibleAgent => ({
  id,
  status: 'active',
  lastSeenAt: new Date(NOW - 60_000),
  scopeControlIds: [],
  ...over,
})

describe('electing one owner', () => {
  it('picks exactly one, so eleven agents do not all probe the same thing', () => {
    // The defect this whole module exists for.
    const fleet = Array.from({ length: 11 }, (_, i) => agent(`agent-${i}`))
    const owner = electOwner(fleet, CONTROL, NOW)

    expect(owner).not.toBeNull()
    expect(fleet.filter((a) => a.id === owner)).toHaveLength(1)
  })

  it('gives the same answer to every caller, without coordination', () => {
    // Each agent computes its own job list; if the election were not
    // deterministic, two of them would disagree and both would run it.
    const fleet = [agent('c'), agent('a'), agent('b')]
    const shuffled = [agent('b'), agent('c'), agent('a')]

    expect(electOwner(fleet, CONTROL, NOW)).toBe(electOwner(shuffled, CONTROL, NOW))
  })

  it('prefers an agent heard from recently over one that has gone quiet', () => {
    // Ordering by id alone would leave a control unmonitored behind a dead
    // agent that happens to sort first.
    const quiet = agent('aaa', { lastSeenAt: new Date(NOW - 3 * 3600_000) })
    const alive = agent('zzz')

    expect(electOwner([quiet, alive], CONTROL, NOW)).toBe('zzz')
  })

  it('does not reshuffle on every heartbeat', () => {
    // Freshness is a threshold, not a ranking: if the most recent heartbeat won,
    // the assignment would move every minute and nobody could reason about it.
    const a = agent('aaa', { lastSeenAt: new Date(NOW - 120_000) })
    const b = agent('bbb', { lastSeenAt: new Date(NOW - 1_000) })

    expect(electOwner([a, b], CONTROL, NOW)).toBe('aaa')
  })

  it('ignores revoked agents and those whose key does not cover the control', () => {
    const revoked = agent('aaa', { status: 'revoked' })
    const scoped = agent('bbb', { scopeControlIds: ['some-other-control'] })
    const eligible = agent('ccc')

    expect(electOwner([revoked, scoped, eligible], CONTROL, NOW)).toBe('ccc')
    expect(electOwner([revoked, scoped], CONTROL, NOW)).toBeNull()
  })
})

describe('who runs a control', () => {
  const fleet = [agent('a'), agent('b'), agent('c')]

  it('honours an explicit assignment over the election', () => {
    const runners = runnersFor({ controlId: CONTROL, policy: 'single', pinned: ['c'] }, fleet, NOW)
    expect(runners).toEqual(['c'])
  })

  it('runs on every eligible agent when the policy asks for it', () => {
    // Probing from several sites is a real case — it just has to be asked for.
    const runners = runnersFor({ controlId: CONTROL, policy: 'all', pinned: [] }, fleet, NOW)
    expect(runners).toHaveLength(3)
  })

  it('drops a pinned agent that has been revoked', () => {
    const withRevoked = [...fleet, agent('gone', { status: 'revoked' })]
    const runners = runnersFor(
      { controlId: CONTROL, policy: 'single', pinned: ['gone', 'b'] },
      withRevoked,
      NOW,
    )
    expect(runners).toEqual(['b'])
  })

  it('falls back to the election when every pinned agent is gone', () => {
    // A control that quietly stops being monitored is worse than one monitored
    // by an agent nobody chose.
    const withRevoked = [...fleet, agent('gone', { status: 'revoked' })]
    const runners = runnersFor(
      { controlId: CONTROL, policy: 'single', pinned: ['gone'] },
      withRevoked,
      NOW,
    )
    expect(runners).toEqual(['a'])
  })

  it('returns nobody when there is nobody, rather than inventing an owner', () => {
    expect(runnersFor({ controlId: CONTROL, policy: 'single', pinned: [] }, [], NOW)).toEqual([])
  })
})

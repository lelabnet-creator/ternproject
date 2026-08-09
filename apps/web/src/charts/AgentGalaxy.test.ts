import { describe, expect, it } from 'vitest'
import { freshnessOf, layout, type GalaxyAgent } from './AgentGalaxy'

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

/**
 * The shapes a fleet with relays can take.
 *
 * Judged here rather than by eye, because the interesting ones are the ones a
 * screenshot never contains: two relays at once, and a relay serving nobody.
 * Both are ordinary states — a zone being built has no agents yet — and both
 * would show up as a broken drawing rather than as an error.
 */
describe('a fleet with relays', () => {
  const at = (over: Partial<GalaxyAgent> & { id: string }): GalaxyAgent => ({
    name: over.id,
    site: null,
    status: 'active',
    lastSeenAt: new Date().toISOString(),
    jobCount: 0,
    ...over,
  })

  it('places a relay serving nobody without collapsing', () => {
    // A zone under construction. The relay is drawn, its link to the centre is
    // drawn, and nothing divides by a zone size of zero.
    const { placed, links } = layout([at({ id: 'p1', role: 'proxy' })], 320, Date.now())

    expect(placed).toHaveLength(1)
    expect(placed[0]!.x).not.toBeNaN()
    expect(placed[0]!.y).not.toBeNaN()
    // One link: the relay to the server. Nothing to fan out.
    expect(links).toHaveLength(1)
    expect(links[0]!.to).toEqual({ x: 0, y: 0 })
  })

  it('keeps two relays and their zones apart', () => {
    const agents = [
      at({ id: 'p1', role: 'proxy' }),
      at({ id: 'p2', role: 'proxy' }),
      at({ id: 'a1', parentAgentId: 'p1' }),
      at({ id: 'a2', parentAgentId: 'p2' }),
    ]
    const { placed, links } = layout(agents, 320, Date.now())

    expect(placed).toHaveLength(4)
    // Two chains: each zone agent to its own relay, each relay to the centre.
    expect(links).toHaveLength(4)

    const p1 = placed.find((a) => a.id === 'p1')!
    const p2 = placed.find((a) => a.id === 'p2')!
    // Two relays on top of each other would draw as one, and the reader would
    // count a fleet wrong — which is the single thing this picture is for.
    expect(Math.hypot(p1.x - p2.x, p1.y - p2.y)).toBeGreaterThan(20)

    // And each zone agent sits beside its own relay, not the other one.
    const a1 = placed.find((a) => a.id === 'a1')!
    expect(Math.hypot(a1.x - p1.x, a1.y - p1.y)).toBeLessThan(Math.hypot(a1.x - p2.x, a1.y - p2.y))
  })

  it('sizes a relay by the zone it carries, not by probes it does not run', () => {
    // The failure this fixes was visible on screen: a relay serving a zone drew
    // smaller than one ordinary agent, because the size formula asked it for a
    // probe count it has none of.
    const alone = layout([at({ id: 'p1', role: 'proxy' })], 320, Date.now())
    const busy = layout(
      [
        at({ id: 'p1', role: 'proxy' }),
        at({ id: 'a1', parentAgentId: 'p1' }),
        at({ id: 'a2', parentAgentId: 'p1' }),
      ],
      320,
      Date.now(),
    )

    const small = alone.placed.find((a) => a.id === 'p1')!.r
    const large = busy.placed.find((a) => a.id === 'p1')!.r
    expect(large).toBeGreaterThan(small)
    // And an empty one still reads as a hub rather than as a stray dot.
    expect(small).toBeGreaterThanOrEqual(6)
  })

  it('pushes a zone outward from its relay, the way its traffic travels', () => {
    const { placed } = layout(
      [at({ id: 'p1', role: 'proxy' }), at({ id: 'a1', parentAgentId: 'p1' })],
      320,
      Date.now(),
    )
    const p1 = placed.find((a) => a.id === 'p1')!
    const a1 = placed.find((a) => a.id === 'a1')!

    // Beyond the relay, not between it and the server: the picture reads as a
    // path, and a zone drawn inside its own relay reverses it.
    expect(Math.hypot(a1.x, a1.y)).toBeGreaterThan(Math.hypot(p1.x, p1.y))
  })
})

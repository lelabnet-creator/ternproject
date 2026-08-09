import { useMemo } from 'react'
import { arc } from 'd3-shape'

/**
 * The fleet as one picture: the server at the centre, agents orbiting it.
 *
 * A table answers "what is agent 17 doing"; this answers "is anything wrong out
 * there", which on a fleet of thirty is the question actually being asked. So
 * the encodings are chosen for what is legible at a glance and from a distance:
 *
 * - **Distance from the centre** is time since last contact. An agent that has
 *   gone quiet drifts outward, and a ring of them at the same radius is a
 *   network problem rather than thirty coincidences.
 * - **Colour** is that same freshness, because distance alone is not readable
 *   for someone who cannot see the centre and the edge at once.
 * - **Size** is how many probes it runs, so losing a big one reads as worse.
 * - **Sector** is the site, with its name on the arc.
 *
 * The layout is deterministic — angle from position within the site, radius
 * from age — so nothing jumps between refreshes. A force simulation would look
 * livelier and make every poll rearrange the sky.
 */

export interface GalaxyAgent {
  id: string
  name: string
  site: string | null
  status: string
  lastSeenAt: string | null
  jobCount: number
  /** `agent`, or `proxy` when it relays for a zone with no route out. */
  role?: string
  /** The proxy this one reports through, when it does not reach the server. */
  parentAgentId?: string | null
}

/** Contact older than this is stale; older than the second, silent. */
const STALE_MINUTES = 10
const SILENT_MINUTES = 60

export type Freshness = 'fresh' | 'stale' | 'silent' | 'revoked'

export function freshnessOf(agent: GalaxyAgent, now: number): Freshness {
  if (agent.status === 'revoked') return 'revoked'
  if (!agent.lastSeenAt) return 'silent'

  const minutes = (now - Date.parse(agent.lastSeenAt)) / 60_000
  if (minutes <= STALE_MINUTES) return 'fresh'
  if (minutes <= SILENT_MINUTES) return 'stale'
  return 'silent'
}

const TONE: Record<Freshness, string> = {
  fresh: 'var(--status-operational)',
  stale: 'var(--status-degraded)',
  silent: 'var(--status-down)',
  revoked: 'var(--color-fg-subtle)',
}

const RING: Record<Freshness, number> = { fresh: 0.42, stale: 0.66, silent: 0.88, revoked: 0.97 }

/** Everything the shape and the colour cannot say, for a pointer and a reader. */
function titleOf(agent: GalaxyAgent & { tone: Freshness }): string {
  const parts = [
    agent.role === 'proxy' ? `${agent.name} (proxy)` : agent.name,
    agent.tone,
    `${agent.jobCount} probe(s)`,
    agent.site ?? null,
    agent.parentAgentId ? 'behind a proxy' : null,
  ]
  return parts.filter(Boolean).join(' — ')
}

export function AgentGalaxy({
  agents,
  now = Date.now(),
  size = 420,
  selectedId,
  onSelect,
}: {
  agents: GalaxyAgent[]
  now?: number
  size?: number
  selectedId?: string | null
  onSelect?: (id: string) => void
}) {
  const radius = size / 2

  const { sectors, placed, links } = useMemo(() => {
    // Sites in a stable order, unplaced agents last: the sky must not rearrange
    // because someone typed a site name.
    /*
     * Agents behind a proxy are laid out around it, not by site.
     *
     * Their site is the proxy's — the proxy reports it — so the sector layout
     * would scatter a zone across a wedge and draw every relay line back across
     * the disc. Clustering them is what makes the chain readable, which is the
     * only reason the picture shows them at all.
     */
    const relayed = new Map<string, GalaxyAgent[]>()
    for (const agent of agents) {
      if (!agent.parentAgentId) continue
      const bucket = relayed.get(agent.parentAgentId)
      if (bucket) bucket.push(agent)
      else relayed.set(agent.parentAgentId, [agent])
    }

    const bySite = new Map<string, GalaxyAgent[]>()
    for (const agent of agents) {
      if (agent.parentAgentId) continue
      const key = agent.site?.trim() || ''
      const bucket = bySite.get(key)
      if (bucket) bucket.push(agent)
      else bySite.set(key, [agent])
    }

    const names = [...bySite.keys()].sort((a, b) => {
      if (a === '') return 1
      if (b === '') return -1
      return a.localeCompare(b)
    })

    const direct = agents.filter((agent) => !agent.parentAgentId)
    const total = direct.length || 1
    const maxJobs = Math.max(1, ...agents.map((a) => a.jobCount))

    let cursor = -Math.PI / 2
    const sectors: { name: string; start: number; end: number }[] = []
    const placed: (GalaxyAgent & { x: number; y: number; r: number; tone: Freshness })[] = []

    for (const name of names) {
      const members = bySite
        .get(name)!
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
      const span = (members.length / total) * Math.PI * 2
      sectors.push({ name, start: cursor, end: cursor + span })

      members.forEach((agent, index) => {
        // Spread within the sector, and never on its exact edge — an agent
        // sitting on the boundary reads as belonging to the wrong site.
        const share = span / (members.length + 1)
        const angle = cursor + share * (index + 1)
        const tone = freshnessOf(agent, now)
        const distance = radius * RING[tone]

        placed.push({
          ...agent,
          tone,
          x: Math.cos(angle) * distance,
          y: Math.sin(angle) * distance,
          r: 5 + (agent.jobCount / maxJobs) * 7,
        })
      })

      cursor += span
    }

    /*
     * A small ring of its own around each proxy.
     *
     * Placed after the sectors because it needs the proxy's final position, and
     * pushed outward from the centre rather than around it: a zone sits *beyond*
     * its relay, which is the direction its traffic travels.
     */
    const links: {
      from: { x: number; y: number }
      to: { x: number; y: number }
      tone: Freshness
    }[] = []

    for (const proxy of placed.filter((agent) => agent.role === 'proxy')) {
      links.push({ from: { x: proxy.x, y: proxy.y }, to: { x: 0, y: 0 }, tone: proxy.tone })

      const zone = relayed.get(proxy.id) ?? []
      const outward = Math.atan2(proxy.y, proxy.x)
      // A fan behind the proxy, narrow enough that it reads as one cluster.
      const spread = Math.PI / 2.2
      const gap = Math.min(radius * 0.16, 34)

      zone.forEach((agent, index) => {
        const offset = zone.length === 1 ? 0 : -spread / 2 + (spread / (zone.length - 1)) * index
        const angle = outward + offset
        const tone = freshnessOf(agent, now)
        const point = {
          x: proxy.x + Math.cos(angle) * gap,
          y: proxy.y + Math.sin(angle) * gap,
        }

        placed.push({ ...agent, tone, x: point.x, y: point.y, r: 4 })
        links.push({ from: point, to: { x: proxy.x, y: proxy.y }, tone })
      })
    }

    return { sectors, placed, links }
  }, [agents, now, radius])

  const sectorArc = arc<{ startAngle: number; endAngle: number }>()
    .innerRadius(radius - 3)
    .outerRadius(radius - 1)

  if (agents.length === 0) {
    return (
      <p style={{ color: 'var(--color-fg-subtle)', margin: 0 }}>
        No agents paired yet. Pair one from a control&rsquo;s Script step.
      </p>
    )
  }

  return (
    <figure style={{ margin: 0 }}>
      <svg
        width="100%"
        viewBox={`0 0 ${size} ${size}`}
        style={{ maxWidth: size, display: 'block', margin: '0 auto' }}
        role="img"
        aria-label={`${agents.length} agents, arranged by site and time since last contact`}
      >
        <g transform={`translate(${radius}, ${radius})`}>
          {/* The rings the encoding refers to, drawn so the distance means
              something rather than looking like scatter. */}
          {(['fresh', 'stale', 'silent'] as const).map((tone) => (
            <circle
              key={tone}
              r={radius * RING[tone]}
              fill="none"
              stroke="var(--color-border)"
              strokeWidth={1}
              strokeDasharray="2 4"
            />
          ))}

          {sectors.map((sector) => (
            <g key={sector.name || 'unplaced'}>
              <path
                d={
                  sectorArc({ startAngle: sector.start + 0.02, endAngle: sector.end - 0.02 }) ?? ''
                }
                fill="var(--color-border-strong)"
              />
            </g>
          ))}

          {/*
            The path a measurement takes: zone agent → proxy → this server.
            Drawn before the dots so it passes under them, and only where a
            relay exists — a line from every direct agent to the centre would be
            a starburst that says nothing the distance does not already say.
          */}
          {links.map((link, index) => (
            <line
              key={index}
              x1={link.from.x}
              y1={link.from.y}
              x2={link.to.x}
              y2={link.to.y}
              stroke={TONE[link.tone]}
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.45}
            />
          ))}

          {/* The server itself, so the picture has a subject. */}
          <circle r={16} fill="var(--color-surface-raised)" stroke="var(--color-border-strong)" />
          <text
            textAnchor="middle"
            dy="0.35em"
            style={{ fontSize: 10, fontWeight: 700, fill: 'var(--color-fg-muted)' }}
          >
            TERN
          </text>

          {placed.map((agent) => {
            const selected = agent.id === selectedId
            return (
              <g
                key={agent.id}
                transform={`translate(${agent.x}, ${agent.y})`}
                onClick={() => onSelect?.(agent.id)}
                style={{ cursor: onSelect ? 'pointer' : 'default' }}
              >
                {/*
                  A proxy is a different shape, not a different colour.
                  Colour already carries freshness here, and a second meaning on
                  the same channel would make both unreadable — and unreadable
                  first for the people colour already fails.
                */}
                {agent.role === 'proxy' ? (
                  <rect
                    x={-agent.r}
                    y={-agent.r}
                    width={agent.r * 2}
                    height={agent.r * 2}
                    transform="rotate(45)"
                    fill={TONE[agent.tone]}
                    stroke={selected ? 'var(--color-fg)' : 'var(--color-surface)'}
                    strokeWidth={selected ? 2.5 : 1.5}
                    opacity={agent.tone === 'revoked' ? 0.5 : 1}
                  >
                    <title>{titleOf(agent)}</title>
                  </rect>
                ) : (
                  <circle
                    r={agent.r}
                    fill={TONE[agent.tone]}
                    stroke={selected ? 'var(--color-fg)' : 'var(--color-surface)'}
                    strokeWidth={selected ? 2.5 : 1.5}
                    opacity={agent.tone === 'revoked' ? 0.5 : 1}
                  >
                    <title>{titleOf(agent)}</title>
                  </circle>
                )}
              </g>
            )
          })}
        </g>
      </svg>

      {/* Never colour alone: the legend names each ring, and the table below
          repeats every fact this picture encodes. */}
      <figcaption
        style={{
          display: 'flex',
          gap: 'var(--space-4)',
          justifyContent: 'center',
          flexWrap: 'wrap',
          marginTop: 'var(--space-3)',
          fontSize: 'var(--text-xs)',
          color: 'var(--color-fg-subtle)',
        }}
      >
        {(
          [
            ['fresh', `seen in the last ${STALE_MINUTES} min`],
            ['stale', `quiet for over ${STALE_MINUTES} min`],
            ['silent', `nothing for over ${SILENT_MINUTES} min`],
            ['revoked', 'revoked'],
          ] as const
        ).map(([tone, label]) => (
          <span key={tone} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: TONE[tone],
                display: 'inline-block',
              }}
            />
            {label}
          </span>
        ))}
        {/* The shape carries the role, so the key for it has to be a shape too —
            a coloured square here would say the opposite of what it means. */}
        {agents.some((agent) => agent.role === 'proxy') && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true">
              <rect
                x={-3.4}
                y={-3.4}
                width={6.8}
                height={6.8}
                transform="rotate(45)"
                fill="var(--color-fg-subtle)"
              />
            </svg>
            proxy, relaying for a zone
          </span>
        )}
      </figcaption>
    </figure>
  )
}

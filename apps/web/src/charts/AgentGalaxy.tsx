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

  const { sectors, placed } = useMemo(() => {
    // Sites in a stable order, unplaced agents last: the sky must not rearrange
    // because someone typed a site name.
    const bySite = new Map<string, GalaxyAgent[]>()
    for (const agent of agents) {
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

    const total = agents.length || 1
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

    return { sectors, placed }
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
                <circle
                  r={agent.r}
                  fill={TONE[agent.tone]}
                  stroke={selected ? 'var(--color-fg)' : 'var(--color-surface)'}
                  strokeWidth={selected ? 2.5 : 1.5}
                  opacity={agent.tone === 'revoked' ? 0.5 : 1}
                >
                  <title>
                    {`${agent.name} — ${agent.tone}, ${agent.jobCount} probe(s)${
                      agent.site ? `, ${agent.site}` : ''
                    }`}
                  </title>
                </circle>
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
      </figcaption>
    </figure>
  )
}

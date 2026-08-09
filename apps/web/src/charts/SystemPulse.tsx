import { useMemo } from 'react'
import { arc } from 'd3-shape'
import { useTranslation } from 'react-i18next'
import type { CheckStatusValue } from '@tern/shared/status'
import { STATUS_PRESENTATION, statusColor } from '../lib/status'
import { TernWordmark } from '../components/brand/TernMark'

export interface PulseGroup {
  id: string
  name: string
  status: CheckStatusValue
  componentCount: number
}

interface SystemPulseProps {
  overall: CheckStatusValue
  affectedCount: number
  groups: PulseGroup[]
  size?: number
  /**
   * Sign the figure with the TERN mark.
   *
   * Set by the page when the header has been given over to the tenant's own
   * logo, so the product is still named somewhere above the fold. False
   * otherwise: the wordmark is already at the top, and saying it twice on one
   * screen makes the platform louder than the service the page is about.
   */
  attribution?: boolean
}

const GAP_RADIANS = 0.035

/**
 * The hero: one radial figure showing the whole system at a glance.
 *
 * A ring segment per top-level group, its arc length proportional to how many
 * components it holds, its colour the group's rolled-up status. The centre
 * carries the overall verdict as a sentence and an icon — not a coloured dot,
 * because the single most important piece of information on the page should not
 * be encoded in hue alone.
 *
 * Arc length is deliberately count-weighted: a group of twelve services being
 * degraded should occupy more of the reader's eye than a group of one.
 */
export function SystemPulse({
  overall,
  affectedCount,
  groups,
  size = 240,
  attribution = false,
}: SystemPulseProps) {
  const { t } = useTranslation()

  const segments = useMemo(() => {
    const total = groups.reduce((sum, g) => sum + Math.max(1, g.componentCount), 0)
    if (total === 0) return []

    const radius = size / 2
    const outer = radius - 4
    const inner = outer - 16

    const arcGen = arc<{ startAngle: number; endAngle: number }>()
      .innerRadius(inner)
      .outerRadius(outer)
      .cornerRadius(3)

    let cursor = -Math.PI / 2 // start at twelve o'clock
    return groups.map((group) => {
      const share = (Math.max(1, group.componentCount) / total) * Math.PI * 2
      const startAngle = cursor + GAP_RADIANS / 2
      const endAngle = cursor + share - GAP_RADIANS / 2
      cursor += share
      return {
        group,
        // Guard against a segment so thin the gap inverts it.
        d: arcGen({ startAngle, endAngle: Math.max(startAngle + 0.01, endAngle) }) ?? '',
      }
    })
  }, [groups, size])

  const presentation = STATUS_PRESENTATION[overall]
  const Icon = presentation.icon

  const headline =
    overall === 'partial' || overall === 'down'
      ? t(`overall.${overall}`, { count: affectedCount })
      : t(`overall.${overall}`)

  return (
    <figure
      style={{
        margin: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--space-3)',
      }}
    >
      <div style={{ position: 'relative', width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          <g transform={`translate(${size / 2}, ${size / 2})`}>
            {/* Track behind the segments, so a mostly-empty ring still reads as
                a ring rather than as scattered fragments. */}
            <circle
              r={size / 2 - 12}
              fill="none"
              stroke="var(--color-border)"
              strokeWidth={16}
              opacity={0.35}
            />
            {segments.map(({ group, d }) => (
              <path key={group.id} d={d} fill={statusColor(group.status)}>
                <title>{`${group.name} — ${t(STATUS_PRESENTATION[group.status].labelKey)}`}</title>
              </path>
            ))}
          </g>
        </svg>

        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 'var(--space-2)',
            padding: 'var(--space-6)',
            textAlign: 'center',
          }}
        >
          <Icon size={32} color={presentation.color} aria-hidden="true" />
          <span
            style={{
              fontSize: 'var(--text-sm)',
              fontWeight: 600,
              lineHeight: 'var(--leading-tight)',
              color: 'var(--color-fg)',
            }}
          >
            {t(presentation.labelKey)}
          </span>
          {/*
            Where the product signs its work once the header belongs to somebody
            else.

            A page carrying a customer's logo should carry it alone at the top —
            but the mark still has to appear somewhere, and the middle of the
            ring is the one place on this page with room that nothing else
            wants. Under the verdict, never in place of it: the reader came for
            the status, and a brand where the status should be is the worst
            trade this page could make.

            Faded, and small enough to read as a maker's mark rather than as a
            third thing to interpret.
          */}
          {attribution && (
            <a
              href="/"
              aria-label="TERN"
              style={{
                display: 'inline-flex',
                marginTop: 'var(--space-1)',
                opacity: 0.45,
                color: 'inherit',
                textDecoration: 'none',
              }}
            >
              <TernWordmark size={18} />
            </a>
          )}
        </div>
      </div>

      {/* The verdict as a sentence. This is the line most visitors came for, so
          it is text first and the ring is the supporting detail. */}
      <figcaption
        style={{
          fontSize: 'var(--text-lg)',
          fontWeight: 600,
          textAlign: 'center',
          color: 'var(--color-fg)',
        }}
      >
        {headline}
      </figcaption>
    </figure>
  )
}

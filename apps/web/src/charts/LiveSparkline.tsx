import { useMemo } from 'react'
import { line, curveMonotoneX } from 'd3-shape'
import { scaleLinear } from 'd3-scale'
import { useTranslation } from 'react-i18next'
import type { CheckStatusValue } from '@tern/shared'
import { statusColor } from '../lib/status'
import { useResizeObserver } from './primitives/useResizeObserver'

export interface LivePoint {
  ts: string
  value: number | null
  status: CheckStatusValue
}

/**
 * The last few minutes, and nothing else.
 *
 * For a tenant in live mode there is no history to draw, so the question is not
 * "what happened" but "what is happening". A rolling window answers that; a
 * 90-day ribbon on a live tenant would be 90 empty slots.
 *
 * Status is carried by a row of marks under the line rather than by colouring
 * the line itself: a line that changes colour mid-segment is ambiguous about
 * where the change occurred, and a gradient stroke is unreadable at this size.
 */
export function LiveSparkline({
  points,
  label,
  height = 72,
}: {
  points: LivePoint[]
  label: string
  height?: number
}) {
  const { t } = useTranslation()
  const { ref, width } = useResizeObserver<HTMLDivElement>()

  const geometry = useMemo(() => {
    if (points.length < 2 || width === 0) return null

    const numeric = points.map((p) => p.value ?? 0)
    const min = Math.min(...numeric)
    const max = Math.max(...numeric)

    const x = scaleLinear()
      .domain([0, points.length - 1])
      .range([0, width])
    const y = scaleLinear()
      .domain([Math.min(0, min), max || 1])
      .range([height - 14, 0])

    const path =
      line<number>()
        .x((_, i) => x(i))
        .y((v) => y(v))
        .curve(curveMonotoneX)(numeric) ?? ''

    return { path, x, latest: numeric[numeric.length - 1] ?? 0 }
  }, [points, width, height])

  if (!geometry) {
    return (
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)' }}>
        {t('page.noData')}
      </p>
    )
  }

  return (
    <figure style={{ margin: 0 }}>
      <div ref={ref} style={{ width: '100%' }}>
        <svg
          width="100%"
          height={height}
          role="img"
          aria-label={`${label}: ${t('page.live')}, ${geometry.latest.toFixed(0)}`}
          style={{ display: 'block', overflow: 'visible' }}
        >
          <path d={geometry.path} fill="none" stroke="var(--color-accent)" strokeWidth={2} />

          {points.map((point, index) => (
            <rect
              key={point.ts}
              x={geometry.x(index) - 1}
              y={height - 8}
              width={Math.max(2, width / points.length - 1)}
              height={6}
              rx={1}
              fill={statusColor(point.status)}
            />
          ))}
        </svg>
      </div>

      <figcaption
        style={{
          marginTop: 'var(--space-1)',
          fontSize: 'var(--text-xs)',
          color: 'var(--color-fg-subtle)',
        }}
      >
        {t('page.live')} · {points.length} {t('chart.samples')}
      </figcaption>
    </figure>
  )
}

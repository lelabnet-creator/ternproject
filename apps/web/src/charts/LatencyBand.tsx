import { useMemo } from 'react'
import { area, curveMonotoneX, line } from 'd3-shape'
import { extent, max } from 'd3-array'
import { scaleLinear, scaleTime } from 'd3-scale'
import { timeFormat } from 'd3-time-format'
import { useTranslation } from 'react-i18next'
import { useResizeObserver } from './primitives/useResizeObserver'

export interface LatencyPoint {
  ts: string
  p50: number
  p95: number
  p99: number
}

/**
 * Latency as a percentile band.
 *
 * A single average line hides the thing that matters: an average of 120ms with a
 * p99 of 4s means one user in a hundred is having a terrible time, and the
 * average says everything is fine. The band makes the spread the subject.
 *
 * One axis, never two. Milliseconds is the only measure here — a second scale
 * for throughput or error rate would put two unrelated units on one picture and
 * invite readers to see a correlation the chart cannot support.
 */
export function LatencyBand({
  points,
  label,
  height = 140,
}: {
  points: LatencyPoint[]
  label: string
  height?: number
}) {
  const { t } = useTranslation()
  const { ref, width } = useResizeObserver<HTMLDivElement>()

  const geometry = useMemo(() => {
    if (points.length < 2 || width === 0) return null

    const parsed = points
      .map((p) => ({ ...p, at: new Date(p.ts) }))
      .sort((a, b) => a.at.getTime() - b.at.getTime())

    const [start, end] = extent(parsed, (p) => p.at) as [Date, Date]
    const ceiling = max(parsed, (p) => p.p99) ?? 1

    const x = scaleTime().domain([start, end]).range([0, width])
    // Zero-based, always. A truncated latency axis turns a 5% change into a
    // cliff, which is the most common way a performance chart misleads.
    const y = scaleLinear()
      .domain([0, ceiling * 1.1])
      .range([height, 0])
      .nice()

    const band = area<(typeof parsed)[number]>()
      .x((p) => x(p.at))
      .y0((p) => y(p.p50))
      .y1((p) => y(p.p99))
      .curve(curveMonotoneX)

    const median = line<(typeof parsed)[number]>()
      .x((p) => x(p.at))
      .y((p) => y(p.p50))
      .curve(curveMonotoneX)

    const p95 = line<(typeof parsed)[number]>()
      .x((p) => x(p.at))
      .y((p) => y(p.p95))
      .curve(curveMonotoneX)

    return {
      bandPath: band(parsed) ?? '',
      medianPath: median(parsed) ?? '',
      p95Path: p95(parsed) ?? '',
      ticks: y.ticks(3),
      y,
      start,
      end,
      ceiling,
    }
  }, [points, width, height])

  const axisFormat = useMemo(() => timeFormat('%d %b'), [])

  // The empty state lives INSIDE the measured container, never in place of it.
  // Returning early skips the ref, so width is never measured, so the guard
  // never releases — the chart shows "no data" forever even when it has data.
  if (!geometry) {
    return (
      <figure style={{ margin: 0 }}>
        <div ref={ref} style={{ width: '100%', minHeight: height }}>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)', margin: 0 }}>
            {t('page.noData')}
          </p>
        </div>
      </figure>
    )
  }

  return (
    <figure style={{ margin: 0 }}>
      <div ref={ref} style={{ position: 'relative', width: '100%' }}>
        <svg
          width="100%"
          height={height}
          role="img"
          aria-label={`${label}: ${t('chart.latency')}, ${t('chart.p99')} ${Math.round(geometry.ceiling)} ms`}
          style={{ display: 'block', overflow: 'visible' }}
        >
          {/* Grid lines are recessive: they orient without competing with the
              data they sit behind. */}
          {geometry.ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={0}
                x2={width}
                y1={geometry.y(tick)}
                y2={geometry.y(tick)}
                stroke="var(--color-border)"
                strokeWidth={1}
              />
              <text
                x={0}
                y={geometry.y(tick) - 4}
                fill="var(--color-fg-subtle)"
                fontSize={10}
                fontFamily="var(--font-mono)"
              >
                {tick} ms
              </text>
            </g>
          ))}

          <path d={geometry.bandPath} fill="var(--color-accent)" opacity={0.16} />
          <path
            d={geometry.p95Path}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={1}
            opacity={0.5}
            strokeDasharray="3 3"
          />
          <path d={geometry.medianPath} fill="none" stroke="var(--color-accent)" strokeWidth={2} />
        </svg>
      </div>

      {/* Two or more series means a legend is always present — identity is
          never left to colour alone. */}
      <figcaption
        style={{
          display: 'flex',
          gap: 'var(--space-4)',
          marginTop: 'var(--space-2)',
          fontSize: 'var(--text-xs)',
          color: 'var(--color-fg-subtle)',
          flexWrap: 'wrap',
        }}
      >
        <span>
          <Swatch kind="solid" /> {t('chart.p50')}
        </span>
        <span>
          <Swatch kind="dashed" /> {t('chart.p95')}
        </span>
        <span>
          <Swatch kind="fill" /> {t('chart.p99')}
        </span>
        <span style={{ marginLeft: 'auto' }} className="tabular">
          {axisFormat(geometry.start)} → {axisFormat(geometry.end)}
        </span>
      </figcaption>
    </figure>
  )
}

function Swatch({ kind }: { kind: 'solid' | 'dashed' | 'fill' }) {
  return (
    <svg width="14" height="8" style={{ verticalAlign: 'middle' }} aria-hidden="true">
      {kind === 'fill' ? (
        <rect width="14" height="8" fill="var(--color-accent)" opacity={0.16} />
      ) : (
        <line
          x1="0"
          x2="14"
          y1="4"
          y2="4"
          stroke="var(--color-accent)"
          strokeWidth={kind === 'solid' ? 2 : 1}
          strokeDasharray={kind === 'dashed' ? '3 3' : undefined}
        />
      )}
    </svg>
  )
}

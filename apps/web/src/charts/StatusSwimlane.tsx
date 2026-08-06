import { useMemo } from 'react'
import { scaleTime } from 'd3-scale'
import { timeFormat } from 'd3-time-format'
import { useTranslation } from 'react-i18next'
import type { CheckStatusValue } from '@tern/shared'
import { statusColor } from '../lib/status'
import { ChartTooltip, useActiveMark } from './primitives/Tooltip'
import { useResizeObserver } from './primitives/useResizeObserver'

export interface SwimlanePoint {
  ts: string
  status: CheckStatusValue
}

interface StatusSwimlaneProps {
  points: SwimlanePoint[]
  locale: string
  timeZone: string
  label: string
  height?: number
}

interface Band {
  start: Date
  end: Date
  status: CheckStatusValue
}

/**
 * State over time as continuous bands.
 *
 * The ribbon answers "which days were bad"; this answers "when exactly". An hour
 * of downtime inside a day becomes one red bar on a ribbon, with no beginning
 * and no end — and "when did it start" is the first question anyone asks during
 * a post-incident review.
 *
 * Runs of the same status are merged into a single band rather than drawn per
 * sample. At 5-minute resolution a week is 2,016 rectangles, most of them
 * identical and sub-pixel; merging turns that into a handful of shapes that are
 * both faster and actually readable.
 */
export function StatusSwimlane({
  points,
  locale,
  timeZone,
  label,
  height = 44,
}: StatusSwimlaneProps) {
  const { t } = useTranslation()
  const { ref, width } = useResizeObserver<HTMLDivElement>()
  const { active, setActive } = useActiveMark<Band>()

  const bands = useMemo(() => mergeRuns(points), [points])

  const scale = useMemo(() => {
    if (bands.length === 0 || width === 0) return null
    const first = bands[0]!.start
    const last = bands[bands.length - 1]!.end
    return scaleTime().domain([first, last]).range([0, width])
  }, [bands, width])

  const format = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone }),
    [locale, timeZone],
  )
  const axisFormat = useMemo(() => timeFormat('%d %b'), [])

  if (bands.length === 0) {
    return (
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)' }}>
        {t('page.noData')}
      </p>
    )
  }

  const worst = bands.filter((b) => b.status !== 'operational')

  return (
    <figure style={{ margin: 0 }}>
      <div ref={ref} style={{ position: 'relative', width: '100%' }}>
        <svg
          width="100%"
          height={height}
          role="img"
          aria-label={`${label}: ${t('chart.swimlane', { count: worst.length })}`}
          style={{ display: 'block', overflow: 'visible' }}
        >
          {scale &&
            bands.map((band, index) => {
              const x = scale(band.start)
              // A band narrower than a pixel is still a real outage. Floor the
              // width so a short incident stays visible instead of vanishing
              // into a rounding error.
              const w = Math.max(1.5, scale(band.end) - x)
              const isActive = active?.item === band

              return (
                <rect
                  key={index}
                  x={x}
                  y={0}
                  width={w}
                  height={height}
                  rx={1}
                  fill={statusColor(band.status)}
                  opacity={isActive ? 1 : 0.9}
                  tabIndex={band.status === 'operational' ? -1 : 0}
                  role={band.status === 'operational' ? undefined : 'button'}
                  aria-label={bandLabel(band, format, t)}
                  onPointerEnter={() => setActive({ item: band, x: x + w / 2, y: height / 2 })}
                  onPointerLeave={() => setActive(null)}
                  onFocus={() => setActive({ item: band, x: x + w / 2, y: height / 2 })}
                  onBlur={() => setActive(null)}
                  style={{ cursor: 'pointer', transition: 'opacity var(--duration-fast)' }}
                />
              )
            })}
        </svg>

        {active && (
          <ChartTooltip x={active.x} y={active.y} boundsWidth={width}>
            <span className="tabular">{bandLabel(active.item, format, t)}</span>
          </ChartTooltip>
        )}
      </div>

      <figcaption
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 'var(--space-2)',
          fontSize: 'var(--text-xs)',
          color: 'var(--color-fg-subtle)',
        }}
      >
        <span className="tabular">{axisFormat(bands[0]!.start)}</span>
        <span>{t('chart.swimlane', { count: worst.length })}</span>
        <span className="tabular">{axisFormat(bands[bands.length - 1]!.end)}</span>
      </figcaption>
    </figure>
  )
}

/** Collapses consecutive samples sharing a status into one band. */
function mergeRuns(points: SwimlanePoint[]): Band[] {
  if (points.length === 0) return []

  const sorted = [...points].sort((a, b) => a.ts.localeCompare(b.ts))
  const bands: Band[] = []

  for (const point of sorted) {
    const at = new Date(point.ts)
    const last = bands[bands.length - 1]

    if (last && last.status === point.status) {
      last.end = at
      continue
    }
    // The new band starts where the previous one ended, so there is no gap
    // between them — a seam would read as missing data.
    if (last) last.end = at
    bands.push({ start: at, end: at, status: point.status })
  }

  // The final band has no successor to close it; give it the median sample
  // width so it is not drawn as zero.
  const final = bands[bands.length - 1]
  if (final && bands.length > 1) {
    const span = final.start.getTime() - bands[0]!.start.getTime()
    final.end = new Date(final.start.getTime() + span / sorted.length)
  }

  return bands
}

function bandLabel(
  band: Band,
  format: Intl.DateTimeFormat,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const minutes = Math.max(1, Math.round((band.end.getTime() - band.start.getTime()) / 60_000))
  return `${t(`status.${band.status}`)} — ${format.format(band.start)} (${t('chart.duration', { minutes })})`
}

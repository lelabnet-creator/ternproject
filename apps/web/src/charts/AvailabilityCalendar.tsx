import { useMemo } from 'react'
import { timeFormat } from 'd3-time-format'
import { useTranslation } from 'react-i18next'
import type { CheckStatusValue } from '@tern/shared'
import { statusSoft, statusColor } from '../lib/status'
import { ChartTooltip, useActiveMark } from './primitives/Tooltip'
import { useResizeObserver } from './primitives/useResizeObserver'

export interface CalendarDay {
  day: string
  uptimePct: number | null
  samples: number
  worstStatus: CheckStatusValue
}

const CELL = 12
const GAP = 3

/**
 * A year of availability as a calendar.
 *
 * The ribbon shows a sequence; this shows a shape. Weekly patterns — a service
 * that degrades every Monday morning, a backup that fails every third Sunday —
 * are invisible in a row of bars and obvious in a grid where the same weekday
 * sits in the same row.
 */
export function AvailabilityCalendar({
  days,
  locale,
  timeZone,
  label,
}: {
  days: CalendarDay[]
  locale: string
  timeZone: string
  label: string
}) {
  const { t } = useTranslation()
  const { ref, width } = useResizeObserver<HTMLDivElement>()
  const { active, setActive } = useActiveMark<CalendarDay>()

  const format = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone }),
    [locale, timeZone],
  )
  const monthFormat = useMemo(() => timeFormat('%b'), [])

  const weeks = useMemo(() => groupIntoWeeks(days), [days])

  // Columns are dropped from the oldest end when space runs out — never
  // squeezed, because a sub-pixel cell is not a mark.
  const capacity = width > 0 ? Math.floor(width / (CELL + GAP)) : weeks.length
  const visible = weeks.slice(Math.max(0, weeks.length - capacity))

  if (days.length === 0) {
    return (
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)' }}>
        {t('page.noData')}
      </p>
    )
  }

  const height = 7 * (CELL + GAP)

  return (
    <figure style={{ margin: 0 }}>
      <div ref={ref} style={{ position: 'relative', width: '100%' }}>
        <svg
          width="100%"
          height={height + 16}
          role="img"
          aria-label={`${label}: ${t('chart.calendar', { weeks: visible.length })}`}
          style={{ display: 'block', overflow: 'visible' }}
        >
          {visible.map((week, wi) => (
            <g key={wi} transform={`translate(${wi * (CELL + GAP)}, 0)`}>
              {week.map((day, di) =>
                day ? (
                  <rect
                    key={day.day}
                    y={di * (CELL + GAP)}
                    width={CELL}
                    height={CELL}
                    rx={2}
                    fill={day.samples === 0 ? 'var(--color-border)' : statusSoft(day.worstStatus)}
                    stroke={day.samples === 0 ? 'none' : statusColor(day.worstStatus)}
                    strokeWidth={0.75}
                    tabIndex={0}
                    role="button"
                    aria-label={dayLabel(day, format, t)}
                    onPointerEnter={() =>
                      setActive({ item: day, x: wi * (CELL + GAP), y: di * (CELL + GAP) })
                    }
                    onPointerLeave={() => setActive(null)}
                    onFocus={() =>
                      setActive({ item: day, x: wi * (CELL + GAP), y: di * (CELL + GAP) })
                    }
                    onBlur={() => setActive(null)}
                    style={{ cursor: 'pointer' }}
                  />
                ) : null,
              )}
              {/* A month label only where the month actually turns over. */}
              {week[0] && new Date(week[0].day).getUTCDate() <= 7 && (
                <text y={height + 10} fontSize={9} fill="var(--color-fg-subtle)">
                  {monthFormat(new Date(week[0].day))}
                </text>
              )}
            </g>
          ))}
        </svg>

        {active && (
          <ChartTooltip x={active.x} y={active.y} boundsWidth={width}>
            <span className="tabular">{dayLabel(active.item, format, t)}</span>
          </ChartTooltip>
        )}
      </div>
    </figure>
  )
}

/** Columns are weeks; rows are weekdays, Monday first. */
function groupIntoWeeks(days: CalendarDay[]): (CalendarDay | null)[][] {
  if (days.length === 0) return []

  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day))
  const weeks: (CalendarDay | null)[][] = []
  let current: (CalendarDay | null)[] = []

  for (const day of sorted) {
    // getUTCDay is Sunday-first; shift so Monday leads, which is what a
    // European reader expects and what makes "weekend" contiguous.
    const weekday = (new Date(day.day).getUTCDay() + 6) % 7

    if (current.length === 0) {
      current = Array.from({ length: 7 }, () => null)
    }
    current[weekday] = day

    if (weekday === 6) {
      weeks.push(current)
      current = []
    }
  }

  if (current.length > 0) weeks.push(current)
  return weeks
}

function dayLabel(
  day: CalendarDay,
  format: Intl.DateTimeFormat,
  t: (key: string) => string,
): string {
  const date = format.format(new Date(`${day.day}T00:00:00Z`))
  if (day.samples === 0) return `${date} — ${t('chart.noRecord')}`
  return `${date} — ${day.uptimePct?.toFixed(2) ?? '—'}%`
}

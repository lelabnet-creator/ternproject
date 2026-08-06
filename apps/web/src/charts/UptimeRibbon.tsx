import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { CheckStatusValue } from '@tern/shared/status'
import { statusColor } from '../lib/status'
import { ChartTooltip, useActiveMark } from './primitives/Tooltip'
import { useResizeObserver } from './primitives/useResizeObserver'

export interface UptimeDay {
  day: string
  uptimePct: number | null
  samples: number
  worstStatus: CheckStatusValue
}

interface UptimeRibbonProps {
  days: UptimeDay[]
  /** How many days the window covers; missing days render as "no record". */
  windowDays: number
  locale: string
  timeZone: string
  label: string
}

const BAR_HEIGHT = 34
const MIN_BAR_WIDTH = 2
/**
 * The gap is 2px of surface, not a lighter fill. A darker seam would read as a
 * value; surface reads as absence, which is what it is.
 */
const GAP = 2

/**
 * Daily uptime over a window — the signature mark of a status page.
 *
 * One bar per day, coloured by that day's *worst* moment rather than its
 * average. A day that was 99.9% up with one hour hard down is the day a reader
 * is looking for, and an average paints it green.
 *
 * No axis, no gridlines, no legend: the marks are the chart. Dates are in the
 * tooltip, and the two ends are labelled directly.
 */
export function UptimeRibbon({ days, windowDays, locale, timeZone, label }: UptimeRibbonProps) {
  const { t } = useTranslation()
  const { ref, width } = useResizeObserver<HTMLDivElement>()
  const { active, setActive } = useActiveMark<UptimeDay>()

  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone }),
    [locale, timeZone],
  )

  /**
   * The window is filled in rather than plotted from whatever rows arrived. A
   * day with no data must occupy its slot: if gaps collapse, the ribbon silently
   * compresses an outage that took a probe offline into nothing.
   */
  const series = useMemo(() => {
    const byDay = new Map(days.map((d) => [d.day, d]))
    const out: UptimeDay[] = []
    const today = new Date()

    for (let i = windowDays - 1; i >= 0; i--) {
      const date = new Date(today)
      date.setUTCDate(date.getUTCDate() - i)
      const key = date.toISOString().slice(0, 10)
      out.push(byDay.get(key) ?? { day: key, uptimePct: null, samples: 0, worstStatus: 'unknown' })
    }
    return out
  }, [days, windowDays])

  // Bars are dropped from the oldest end when space runs out, never thinned
  // below 2px — a sub-pixel bar is not a mark, it is noise.
  const visible = useMemo(() => {
    if (width === 0) return series
    const capacity = Math.max(1, Math.floor((width + GAP) / (MIN_BAR_WIDTH + GAP)))
    return series.slice(Math.max(0, series.length - capacity))
  }, [series, width])

  const barWidth = width > 0 ? Math.max(MIN_BAR_WIDTH, (width + GAP) / visible.length - GAP) : 0

  /**
   * Averaged over the days actually drawn, not over the full window.
   *
   * At 375px only about 77 of 90 bars fit, and the caption says so. Quoting a
   * 90-day figure beside a "77-day uptime" label would be a number that does not
   * describe the chart it sits under — on a page whose entire job is reporting
   * accurate availability.
   */
  const overallUptime = useMemo(() => {
    const withData = visible.filter((d) => d.uptimePct !== null)
    if (withData.length === 0) return null
    return withData.reduce((sum, d) => sum + (d.uptimePct ?? 0), 0) / withData.length
  }, [visible])

  const summary = t('chart.uptimeRibbon', { days: visible.length })

  return (
    <figure style={{ margin: 0 }}>
      <div ref={ref} style={{ position: 'relative', width: '100%' }}>
        <svg
          width="100%"
          height={BAR_HEIGHT}
          role="img"
          // The chart's meaning in one sentence, for anyone who cannot see it.
          aria-label={
            overallUptime === null
              ? `${label}: ${t('page.noData')}`
              : `${label}: ${summary}, ${overallUptime.toFixed(2)}%`
          }
          style={{ display: 'block', overflow: 'visible' }}
        >
          {visible.map((day, index) => {
            const x = index * (barWidth + GAP)
            const isActive = active?.item.day === day.day
            return (
              <rect
                key={day.day}
                x={x}
                y={0}
                width={barWidth}
                height={BAR_HEIGHT}
                // 2px radius: enough to soften the end, not enough to eat a
                // 2px-wide bar entirely.
                rx={Math.min(2, barWidth / 2)}
                fill={day.samples === 0 ? 'var(--color-border)' : statusColor(day.worstStatus)}
                // A hairline border keeps a light fill visible against a light
                // surface — the relief the amber step needs.
                stroke="var(--color-border)"
                strokeWidth={0.5}
                opacity={isActive ? 1 : 0.92}
                tabIndex={0}
                role="button"
                aria-label={dayLabel(day, dateFormat, t)}
                onPointerEnter={() =>
                  setActive({ item: day, x: x + barWidth / 2, y: BAR_HEIGHT / 2 })
                }
                onPointerLeave={() => setActive(null)}
                onFocus={() => setActive({ item: day, x: x + barWidth / 2, y: BAR_HEIGHT / 2 })}
                onBlur={() => setActive(null)}
                style={{ cursor: 'pointer', transition: 'opacity var(--duration-fast)' }}
              />
            )
          })}
        </svg>

        {active && (
          <ChartTooltip x={active.x} y={active.y} boundsWidth={width}>
            <span className="tabular">{dayLabel(active.item, dateFormat, t)}</span>
          </ChartTooltip>
        )}
      </div>

      {/* Direct labels at the ends only. A date under every bar would be
          unreadable at 90 days and redundant at 7. */}
      <figcaption
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 'var(--space-2)',
          fontSize: 'var(--text-xs)',
          color: 'var(--color-fg-subtle)',
        }}
      >
        <span>{t('page.uptimeWindow', { days: visible.length })}</span>
        {overallUptime !== null && (
          <span className="tabular" style={{ color: 'var(--color-fg-muted)' }}>
            {overallUptime.toFixed(2)}%
          </span>
        )}
        <span>{t('chart.today')}</span>
      </figcaption>
    </figure>
  )
}

function dayLabel(day: UptimeDay, format: Intl.DateTimeFormat, t: (key: string) => string): string {
  const date = format.format(new Date(`${day.day}T00:00:00Z`))
  if (day.samples === 0) return `${date} — ${t('chart.noRecord')}`
  return `${date} — ${day.uptimePct?.toFixed(2) ?? '—'}%`
}

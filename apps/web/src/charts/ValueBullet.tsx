import { useTranslation } from 'react-i18next'

/**
 * A measurement against the limits that make it meaningful.
 *
 * A queue depth of 137 says nothing on its own. Against a warning line at 200
 * and a hard limit at 500 it says "comfortable"; against a limit of 150 it says
 * "about to page someone". The bullet chart puts the number and its context in
 * one row, which a gauge dial does the worse job of and takes four times the
 * space doing.
 */
export function ValueBullet({
  value,
  unit,
  label,
  warnAt,
  limitAt,
  /** Highest value seen recently, so the current reading has a scale. */
  peak,
}: {
  value: number | null
  unit?: string | null
  label?: string | null
  warnAt?: number | null
  limitAt?: number | null
  peak?: number | null
}) {
  const { t } = useTranslation()

  if (value === null) {
    return (
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)' }}>
        {t('page.noData')}
      </p>
    )
  }

  // The track always reaches past whichever is largest, so the bar never runs
  // off the end and a reading above the limit is visibly above it.
  const ceiling = Math.max(value, limitAt ?? 0, warnAt ?? 0, peak ?? 0) * 1.15 || 1
  const pct = (n: number) => `${Math.min(100, (n / ceiling) * 100)}%`

  const state =
    limitAt !== null && limitAt !== undefined && value >= limitAt
      ? 'down'
      : warnAt !== null && warnAt !== undefined && value >= warnAt
        ? 'degraded'
        : 'operational'

  return (
    <figure style={{ margin: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 'var(--space-3)',
          marginBottom: 'var(--space-2)',
        }}
      >
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-fg-muted)' }}>
          {label ?? t('chart.value')}
        </span>
        <span
          className="tabular"
          style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: `var(--status-${state})` }}
        >
          {formatNumber(value)}
          {unit ? <span style={{ fontSize: 'var(--text-sm)', marginLeft: 4 }}>{unit}</span> : null}
        </span>
      </div>

      <div
        style={{
          position: 'relative',
          height: 14,
          background: 'var(--color-border)',
          borderRadius: 'var(--radius-full)',
        }}
        role="meter"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={Math.round(ceiling)}
        aria-label={`${label ?? t('chart.value')}: ${formatNumber(value)}${unit ? ` ${unit}` : ''}`}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            width: pct(value),
            background: `var(--status-${state})`,
            borderRadius: 'var(--radius-full)',
            transition: 'width var(--duration-base) var(--ease-out)',
          }}
        />

        {/* Thresholds are ticks across the track, not coloured zones behind it:
            a zone competes with the bar for the same pixels, and the reader has
            to work out which colour is which. */}
        {warnAt != null && (
          <Threshold
            at={pct(warnAt)}
            tone="degraded"
            title={`${t('status.degraded')} ≥ ${formatNumber(warnAt)}`}
          />
        )}
        {limitAt != null && (
          <Threshold
            at={pct(limitAt)}
            tone="down"
            title={`${t('status.down')} ≥ ${formatNumber(limitAt)}`}
          />
        )}
      </div>

      <figcaption
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 'var(--space-1)',
          fontSize: 'var(--text-xs)',
          color: 'var(--color-fg-subtle)',
        }}
        className="tabular"
      >
        <span>0</span>
        {warnAt != null && <span>{t('chart.warnAt', { value: formatNumber(warnAt) })}</span>}
        {limitAt != null && <span>{t('chart.limitAt', { value: formatNumber(limitAt) })}</span>}
      </figcaption>
    </figure>
  )
}

function Threshold({ at, tone, title }: { at: string; tone: string; title: string }) {
  return (
    <div
      title={title}
      style={{
        position: 'absolute',
        left: at,
        top: -3,
        bottom: -3,
        width: 2,
        background: `var(--status-${tone})`,
        borderRadius: 1,
      }}
    />
  )
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

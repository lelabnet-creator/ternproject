import { useTranslation } from 'react-i18next'
import type { CheckStatusValue } from '@tern/shared/status'
import { STATUS_PRESENTATION } from '../lib/status'

/**
 * One number, large.
 *
 * Sometimes the right visualisation is not a chart. "99.94% over 90 days" is a
 * complete answer, and drawing it as a bar leaves the reader doing arithmetic
 * against an axis to recover the number they were given.
 *
 * The trend line beneath is a sparkline without axes — enough to say "rising"
 * or "flat", not enough to invite reading values off it.
 */
export function StatTile({
  value,
  unit,
  caption,
  status,
  trend,
}: {
  value: string
  unit?: string | null
  caption: string
  status?: CheckStatusValue
  trend?: number[]
}) {
  const { t } = useTranslation()
  const presentation = status ? STATUS_PRESENTATION[status] : null
  const Icon = presentation?.icon

  return (
    <figure style={{ margin: 0, display: 'grid', gap: 'var(--space-1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        {Icon && <Icon size={18} color={presentation!.color} aria-hidden="true" />}
        <span
          className="tabular"
          style={{
            fontSize: 'var(--text-2xl)',
            fontWeight: 600,
            lineHeight: 1,
            color: presentation?.color ?? 'var(--color-fg)',
          }}
        >
          {value}
          {unit ? (
            <span style={{ fontSize: 'var(--text-base)', marginLeft: 4, fontWeight: 400 }}>
              {unit}
            </span>
          ) : null}
        </span>
      </div>

      {trend && trend.length > 1 && <Sparkline values={trend} />}

      <figcaption style={{ fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)' }}>
        {caption}
        {status && presentation ? ` · ${t(presentation.labelKey)}` : ''}
      </figcaption>
    </figure>
  )
}

function Sparkline({ values }: { values: number[] }) {
  const width = 120
  const height = 24
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1

  const d = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width
      const y = height - ((v - min) / span) * height
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')

  return (
    // Decorative: the figure's caption and value already carry the meaning, and
    // an unlabelled squiggle read aloud helps nobody.
    <svg width={width} height={height} aria-hidden="true" style={{ display: 'block' }}>
      <path d={d} fill="none" stroke="var(--color-fg-subtle)" strokeWidth={1.5} opacity={0.7} />
    </svg>
  )
}

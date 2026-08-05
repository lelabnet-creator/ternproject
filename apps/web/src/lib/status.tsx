import { AlertTriangle, CheckCircle2, CircleHelp, MinusCircle, Wrench, XCircle } from 'lucide-react'
import type { CheckStatusValue } from '@tern/shared'

/**
 * How each status is presented.
 *
 * Every status carries an icon and a label, not just a colour. Roughly one man
 * in twelve cannot reliably separate the amber of `degraded` from the red of
 * `down`, and a status page that only says it in colour says nothing to them.
 */

export interface StatusPresentation {
  /** CSS variable holding the solid colour for this status. */
  color: string
  /** Muted fill, for heatmap cells and chart bands. */
  soft: string
  icon: typeof CheckCircle2
  /** i18n key for the short label. */
  labelKey: string
}

export const STATUS_PRESENTATION: Record<CheckStatusValue, StatusPresentation> = {
  operational: {
    color: 'var(--status-operational)',
    soft: 'var(--status-operational-soft)',
    icon: CheckCircle2,
    labelKey: 'status.operational',
  },
  degraded: {
    color: 'var(--status-degraded)',
    soft: 'var(--status-degraded-soft)',
    icon: AlertTriangle,
    labelKey: 'status.degraded',
  },
  partial: {
    color: 'var(--status-partial)',
    soft: 'var(--status-partial-soft)',
    icon: MinusCircle,
    labelKey: 'status.partial',
  },
  down: {
    color: 'var(--status-down)',
    soft: 'var(--status-down-soft)',
    icon: XCircle,
    labelKey: 'status.down',
  },
  maintenance: {
    color: 'var(--status-maintenance)',
    soft: 'var(--status-maintenance-soft)',
    icon: Wrench,
    labelKey: 'status.maintenance',
  },
  unknown: {
    color: 'var(--status-unknown)',
    soft: 'var(--status-unknown-soft)',
    icon: CircleHelp,
    labelKey: 'status.unknown',
  },
}

export function statusColor(status: CheckStatusValue): string {
  return STATUS_PRESENTATION[status].color
}

export function statusSoft(status: CheckStatusValue): string {
  return STATUS_PRESENTATION[status].soft
}

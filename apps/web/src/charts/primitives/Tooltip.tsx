import { useEffect, useState, type ReactNode } from 'react'

interface TooltipProps {
  x: number
  y: number
  children: ReactNode
  /** Container width, so the tooltip can flip rather than overflow. */
  boundsWidth: number
}

/**
 * Chart tooltip.
 *
 * Positioned in the container rather than the page so it cannot escape a
 * scrolled panel, and it flips side near the right edge instead of being
 * clipped — the last column of a 90-day ribbon is today, which is the one people
 * reach for most.
 *
 * `pointer-events: none` matters: a tooltip that intercepts the pointer makes
 * the mark underneath un-hoverable and the tooltip flickers.
 */
export function ChartTooltip({ x, y, children, boundsWidth }: TooltipProps) {
  const flip = x > boundsWidth - 180

  return (
    <div
      role="tooltip"
      style={{
        position: 'absolute',
        left: flip ? undefined : x + 12,
        right: flip ? boundsWidth - x + 12 : undefined,
        top: y,
        transform: 'translateY(-50%)',
        pointerEvents: 'none',
        zIndex: 'var(--z-sticky)',
        background: 'var(--color-surface-raised)',
        color: 'var(--color-fg)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        boxShadow: 'var(--shadow-sheet)',
        padding: 'var(--space-2) var(--space-3)',
        fontSize: 'var(--text-sm)',
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </div>
  )
}

/**
 * Tracks which mark is active, from pointer *or* keyboard.
 *
 * Hover alone would make every value in the chart unreachable without a mouse,
 * so focus drives the same state and the tooltip has a live region announcing
 * it.
 */
export function useActiveMark<T>() {
  const [active, setActive] = useState<{ item: T; x: number; y: number } | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActive(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return { active, setActive }
}

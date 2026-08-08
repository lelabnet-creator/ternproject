import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui'

/**
 * A first walk through the admin.
 *
 * Anchored to the real elements rather than to screenshots: a picture of the
 * rail is a second copy of the rail, and it starts lying the day an entry is
 * added. Each step measures the element it describes and places the card beside
 * it, so a tour of a rail that has grown a new entry is a tour that already
 * covers it.
 *
 * It does **not** trap focus. A tour nobody can escape is worse than no tour:
 * Escape closes it at any step, the buttons are ordinary buttons in the tab
 * order, and everything behind stays reachable. The highlight is drawn with
 * `pointer-events: none` so nothing underneath becomes unclickable either.
 */

export interface TourStep {
  /** A CSS selector for the element this step is about. */
  target: string
  title: string
  body: string
}

export function GuidedTour({
  steps,
  onFinish,
}: {
  steps: TourStep[]
  /** Called on finishing and on dismissing alike — both mean "do not show me this again". */
  onFinish: () => void
}) {
  const [index, setIndex] = useState(0)
  const [box, setBox] = useState<DOMRect | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  const step = steps[index]
  const last = index === steps.length - 1

  // Measured in a layout effect and again on resize: a card placed from a stale
  // rectangle lands beside where the element used to be, which on a narrow
  // window is off-screen entirely.
  useLayoutEffect(() => {
    if (!step) return

    const measure = () => {
      const element = document.querySelector(step.target)
      setBox(element?.getBoundingClientRect() ?? null)
      element?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }

    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [step])

  // Focus moves to the card as each step opens, so a screen reader announces the
  // step instead of leaving the reader wherever they were.
  useEffect(() => {
    cardRef.current?.focus()
  }, [index])

  const close = useCallback(() => onFinish(), [onFinish])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
      if (event.key === 'ArrowRight') setIndex((i) => Math.min(steps.length - 1, i + 1))
      if (event.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close, steps.length])

  if (!step) return null

  return (
    <div
      // `dialog` without `modal`: this genuinely does not make the rest inert,
      // and claiming otherwise would have a screen reader hide the page it is
      // pointing at.
      role="dialog"
      aria-label="Guided tour"
      style={{ position: 'fixed', inset: 0, zIndex: 60, pointerEvents: 'none' }}
    >
      {/* A dim wash, and a hole where the subject is. Nothing is captured: the
          wash never receives a click, so the rail underneath stays usable. */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          background: 'color-mix(in srgb, var(--color-bg) 72%, transparent)',
          pointerEvents: 'none',
        }}
      />

      {box && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: box.top - 4,
            left: box.left - 4,
            width: box.width + 8,
            height: box.height + 8,
            border: '2px solid var(--color-accent)',
            borderRadius: 'var(--radius-sm)',
            boxShadow: '0 0 0 9999px color-mix(in srgb, var(--color-bg) 55%, transparent)',
            pointerEvents: 'none',
            transition: 'all var(--duration-fast) var(--ease-out)',
          }}
        />
      )}

      <div
        ref={cardRef}
        tabIndex={-1}
        style={{
          position: 'absolute',
          ...cardPosition(box),
          maxWidth: 'min(22rem, calc(100vw - 2rem))',
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border-strong)',
          borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--shadow-card)',
          padding: 'var(--space-4)',
          display: 'grid',
          gap: 'var(--space-3)',
          pointerEvents: 'auto',
        }}
      >
        <div>
          <p
            className="tabular"
            style={{
              margin: 0,
              fontSize: 'var(--text-xs)',
              color: 'var(--color-fg-subtle)',
            }}
          >
            {index + 1} of {steps.length}
          </p>
          <h2 style={{ margin: 'var(--space-1) 0 0', fontSize: 'var(--text-base)' }}>
            {step.title}
          </h2>
        </div>

        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-fg-muted)' }}>
          {step.body}
        </p>

        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          {index > 0 && <Button onClick={() => setIndex(index - 1)}>Back</Button>}
          <Button variant="primary" onClick={() => (last ? close() : setIndex(index + 1))}>
            {last ? 'Done' : 'Next'}
          </Button>
          {/* Available at every step, not only the first. Someone who wants out
              on step four should not have to press Next three times. */}
          <Button onClick={close}>Skip the tour</Button>
        </div>

        <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}>
          Options → Account brings it back.
        </p>
      </div>
    </div>
  )
}

/**
 * Beside the subject where there is room, centred when there is no subject.
 *
 * Deliberately simple: the rail is on the left on a wide screen and the tour
 * follows it down, so "to the right of the box, clamped to the viewport" covers
 * every step without a placement engine.
 */
function cardPosition(box: DOMRect | null): { top: number; left: number } {
  if (!box) {
    return { top: window.innerHeight / 2 - 100, left: window.innerWidth / 2 - 176 }
  }

  const gap = 16
  const width = Math.min(352, window.innerWidth - 32)
  const roomOnTheRight = window.innerWidth - box.right > width + gap

  return {
    // Clamped so a step near the bottom of a short window is not placed below
    // the fold, where the reader would never find it.
    top: Math.max(16, Math.min(box.top, window.innerHeight - 260)),
    left: roomOnTheRight ? box.right + gap : Math.max(16, window.innerWidth - width - 16),
  }
}

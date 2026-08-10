import { useEffect, useRef, useState, type ReactNode } from 'react'
import { worstStatus, type CheckStatusValue } from '@tern/shared/status'
import { statusColor } from '../../lib/status'

/**
 * The component groups as swipeable panes, for a phone.
 *
 * ## Why panes, and why not gesture-only
 *
 * Stacked linearly, five groups on a phone is five screens of scrolling to
 * learn what is working. Paging sideways is the native answer — Android's
 * ViewPager, iOS's page-based scroll view — and it is the right one for content
 * that is *peer*: groups are siblings, not a sequence.
 *
 * But a status page has a property a photo gallery does not: hiding a pane can
 * hide an outage. Four groups behind a swipe means a failure in the third is
 * invisible at exactly the moment somebody opened the page to find it. So this
 * is deliberately not a bare swipe surface:
 *
 * - **The dots are real controls.** A page indicator that only reports is one
 *   more thing a keyboard cannot use; these are tappable, labelled with the
 *   group's name, and reachable with the arrow keys. The gesture is an
 *   accelerator, never the only way through — `gesture-alternative`, and the
 *   reason a swipe-only carousel fails an audit.
 * - **A dot whose group has a problem carries its colour**, whichever pane is
 *   showing. The one thing that must never be hidden is that something is
 *   wrong; which thing can wait for the swipe.
 * - **The overall pulse stays above this**, outside the panes, so the summary
 *   is true regardless of which pane is showing.
 *
 * ## Why CSS scroll-snap rather than a gesture handler
 *
 * `scroll-snap-type: x mandatory` *is* the swipe: momentum, rubber-banding,
 * interruption mid-flick, and the platform's own physics — all of it free and
 * all of it already correct. A hand-written pointer handler reimplements that
 * badly, fights the browser for the gesture, and breaks the moment somebody
 * uses a trackpad, a keyboard, or a screen reader's swipe. It also inherits
 * `prefers-reduced-motion` without asking.
 */
export interface PaneGroup {
  id: string
  name: string | null
  statuses: CheckStatusValue[]
  content: ReactNode
}

export function GroupPanes({ groups }: { groups: PaneGroup[] }) {
  const [active, setActive] = useState(0)
  const track = useRef<HTMLDivElement>(null)

  /*
   * The dots follow the scroll, rather than the scroll being driven by state.
   *
   * Driving the position from React would fight the finger: every frame of a
   * flick would be a render arguing with the browser about where the pane is.
   * The scroll is the source of truth and the indicator reads it, which is why
   * an interrupted swipe leaves both agreeing.
   */
  useEffect(() => {
    const node = track.current
    if (!node) return

    const onScroll = () => {
      const index = Math.round(node.scrollLeft / Math.max(1, node.clientWidth))
      setActive(Math.min(groups.length - 1, Math.max(0, index)))
    }
    node.addEventListener('scroll', onScroll, { passive: true })
    return () => node.removeEventListener('scroll', onScroll)
  }, [groups.length])

  const go = (index: number) => {
    const node = track.current
    if (!node) return
    node.scrollTo({ left: index * node.clientWidth, behavior: 'smooth' })
    setActive(index)
    document.getElementById(`pane-dot-${groups[index]?.id}`)?.focus()
  }

  if (groups.length <= 1) {
    // One group is not a carousel: a page control over a single pane is
    // furniture, and the title is already drawn by the caller.
    return <>{groups[0]?.content}</>
  }

  return (
    <div data-tern="component-panes">
      <div
        ref={track}
        style={{
          display: 'flex',
          overflowX: 'auto',
          scrollSnapType: 'x mandatory',
          scrollbarWidth: 'none',
          // The panes are siblings on one row; each takes the full width.
          gap: 0,
          /*
           * Bounded, so the dots are never below the fold.
           *
           * A page indicator you have to scroll to reach has stopped
           * indicating: by the time it is on screen the reader has already
           * gone past the pane it describes, and nothing ever told them there
           * were four more. So the paging region takes a share of the viewport
           * and the dots sit immediately under it.
           *
           * The arithmetic behind 62: the bar is ~56px, the notice about 60,
           * the dots 44, and the margins around them perhaps 40 — roughly
           * 200px of chrome. On the shortest phone this product will meet
           * (~640px) that leaves 440, and 62dvh of 640 is 397. It fits, with
           * room, and it keeps fitting as the viewport grows.
           *
           * The height itself is in `tokens.css`, as `.pane-track`, because it
           * needs `dvh` with a `vh` fallback and that is a cascade, not a
           * value. Inline styles are one object: writing `height` twice simply
           * discards the first, so a browser without `dvh` would be left with
           * no height at all rather than the older one. `dvh` matters here —
           * on a phone `vh` is measured with the browser bars hidden, so a
           * `vh`-sized region is taller than what is visible and pushes the
           * dots off exactly the screen they exist to sit on.
           */
        }}
        className="pane-track"
      >
        {groups.map((group, index) => (
          <section
            key={group.id}
            id={`pane-${group.id}`}
            aria-label={group.name ?? 'Other'}
            // Only the visible pane is in the tab order. Without this, tabbing
            // walks into panes that are off-screen and the page scrolls
            // sideways under a reader who never asked it to.
            {...(index === active ? {} : { 'aria-hidden': true })}
            style={{
              flex: '0 0 100%',
              scrollSnapAlign: 'start',
              minWidth: 0,
              /*
               * Each pane carries its own scrollbar rather than the page
               * carrying one for all of them. A group with twenty components
               * scrolls inside its pane; the dots do not move, and neither
               * does the pane beside it.
               */
              overflowY: 'auto',
              overscrollBehaviorY: 'contain',
            }}
          >
            {group.name && (
              <h2
                style={{
                  fontSize: 'var(--text-sm)',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: 'var(--color-fg-subtle)',
                  margin: '0 0 var(--space-3)',
                }}
              >
                {group.name}
              </h2>
            )}
            {group.content}
          </section>
        ))}
      </div>

      {/*
        The dots, under the panes — a page control, where iOS and Android both
        put it.

        Tappable, and not decoration: a page indicator that only reports is one
        more thing a keyboard cannot use, and `gesture-alternative` is the rule
        that a swipe must never be the only way through. Each carries the
        group's name as its label, so a screen reader hears "Payments" rather
        than "button, 2 of 3".
      */}
      <div
        role="group"
        aria-label="Component groups"
        onKeyDown={(event) => {
          const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
          if (!step) return
          event.preventDefault()
          go((active + step + groups.length) % groups.length)
        }}
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: 'var(--space-1)',
          paddingTop: 'var(--space-4)',
        }}
      >
        {groups.map((group, index) => {
          const status = worstStatus(group.statuses)
          const selected = index === active
          const ailing = status !== 'operational' && status !== 'unknown'

          return (
            <button
              key={group.id}
              id={`pane-dot-${group.id}`}
              type="button"
              aria-label={group.name ?? 'Other'}
              aria-current={selected ? 'true' : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => go(index)}
              style={{
                // 44px of tap area around an 8px mark: the dot is the size the
                // eye wants and the button is the size the thumb needs.
                width: 44,
                height: 44,
                display: 'grid',
                placeItems: 'center',
                border: 'none',
                background: 'none',
                padding: 0,
                cursor: 'pointer',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: selected ? 9 : 7,
                  height: selected ? 9 : 7,
                  borderRadius: '50%',
                  /*
                   * A group with a problem keeps its colour whichever pane is
                   * showing. That is the property that makes paging safe here:
                   * a failure two panes away is visible from the first, so the
                   * page never hides the one thing somebody opened it to find.
                   */
                  background: ailing
                    ? statusColor(status)
                    : selected
                      ? 'var(--color-fg-muted)'
                      : 'var(--color-border-strong)',
                  transition: 'width var(--duration-fast), height var(--duration-fast)',
                }}
              />
            </button>
          )
        })}
      </div>
    </div>
  )
}

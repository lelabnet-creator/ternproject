import { useEffect, useState } from 'react'

/**
 * The width below which a layout is arranged for one thumb rather than a mouse.
 *
 * 48rem, which is the tablet step already in `tokens.css`. A third breakpoint
 * invented here would be a third number to keep in step with the other two, and
 * the question this answers — "is there room for a row of controls beside the
 * name" — changes at the same place the type scale does.
 */
export const COMPACT_QUERY = '(max-width: 47.999rem)'

/**
 * Whether the viewport is narrow enough to want the compact arrangement.
 *
 * ## Why a hook and not a media query
 *
 * Most of this codebase reaches for CSS, and it should. This is the case where
 * CSS cannot do the job honestly: the compact layout does not restyle the
 * controls, it *moves* them — into an overflow menu, and below the content.
 * CSS can reorder with `order`, but `order` changes what the eye sees without
 * changing what the keyboard and the screen reader traverse, so the tab order
 * stops matching the visual order. That is an accessibility defect traded for
 * an implementation convenience, and it is the exact trade the WCAG focus-order
 * rule exists to forbid.
 *
 * Rendering two arrangements keeps the DOM order and the visual order the same
 * thing, which is the only version of this that is correct for everybody.
 *
 * ## Server-safe by construction
 *
 * Returns `false` where `matchMedia` does not exist — Node, during the static
 * renders this repo tests components with. The wide arrangement is the right
 * fallback: it shows every control rather than hiding some behind a menu that
 * a test, or a browser too old for `matchMedia`, could not open.
 */
export function useCompact(): boolean {
  const [compact, setCompact] = useState(() => matches())

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return

    const query = window.matchMedia(COMPACT_QUERY)
    const update = () => setCompact(query.matches)

    // Read once on mount as well as subscribing: the first paint used the
    // initial state, and between that and this effect the viewport may already
    // have been something else — a rotation during load, or a hydration on a
    // width the initial render could not see.
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return compact
}

function matches(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia(COMPACT_QUERY).matches
}

import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { adminApi } from '../lib/adminApi'
import { sandboxOn } from '../lib/sandbox-flag'

/*
 * A development affordance, and only that.
 *
 * `import.meta.env.DEV` is a build-time constant, so in production this is
 * `null`, the `import()` is never emitted, and neither the switch nor the
 * sandbox engine behind it reaches the bundle. A public demo that any visitor
 * could edit — even only in their own browser — would produce screenshots of a
 * product state nobody shipped.
 */
const SandboxSwitch = import.meta.env.DEV
  ? lazy(() => import('../features/sandbox/SandboxSwitch'))
  : null

/**
 * Says the numbers are invented, and offers the way out.
 *
 * A demo page that looks exactly like a real one teaches nothing except
 * mistrust the first time someone acts on a figure it made up. This is the
 * whole reason the seeded tenant carries `isDemo`: the alternative was making
 * the demo *look* alive, which would have been the same lie told more
 * convincingly.
 *
 * The offer adapts, because the honest one depends on the instance. First-run
 * setup is open only while there is no account at all — it creates the one that
 * owns the instance. Where that is still available, the button leads there and
 * this page becomes theirs. Where an account already exists, the button would
 * be a door to nowhere, so it points at installing TERN instead.
 */
export function DemoBanner({ variant = 'page' }: { variant?: 'page' | 'admin' }) {
  // Cheap and cached: it is the same query the admin already runs to decide
  // between a sign-in form and the setup screen.
  const setup = useQuery({
    queryKey: ['setup-state'],
    queryFn: adminApi.setupState,
    retry: false,
  })

  const canClaim = setup.data?.needsSetup === true

  /*
   * Two lines, and the rest behind a word.
   *
   * The notice is four lines and two buttons on a phone — a full screen of
   * something the reader has already understood by the end of the first
   * sentence, sitting between them and the status. Clamped to two lines, which
   * is where "This is a demonstration" plus its first clause lands, and the
   * remainder is one tap away.
   *
   * `More` appears only when the text is actually cut. A disclosure control
   * that opens nothing is worse than no control: it costs a tap to learn it was
   * pointless, and it teaches the reader to ignore the next one.
   */
  const [expanded, setExpanded] = useState(false)
  const [clipped, setClipped] = useState(false)
  const text = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const measure = () => {
      const node = text.current
      // Measured while clamped: expanded, `scrollHeight` equals `clientHeight`
      // and the control would vanish the moment it was used.
      if (node && !expanded) setClipped(node.scrollHeight > node.clientHeight + 1)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [expanded])

  return (
    <div className="demo-banner" role="note">
      <div
        ref={text}
        style={
          expanded
            ? undefined
            : {
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }
        }
      >
        <strong>This is a demonstration.</strong>{' '}
        {variant !== 'admin'
          ? 'Every component, incident and measurement on this page was generated. None of it reports a real service.'
          : sandboxOn()
            ? // The unqualified sentence would now be wrong twice over: the
              // controls are not disabled, and the writes are not refused —
              // they are answered here. Saying where they go is the point.
              'You are looking at it without signing in. Local writes are on, so nothing you change here leaves this browser or reaches the server. The measurements are still synthetic.'
            : 'You are looking at it without signing in, which is why every control is disabled. Everything here is synthetic and every write is refused.'}
      </div>

      {(clipped || expanded) && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          /*
           * A link, not a button — visually.
           *
           * `demo-banner-action` draws a bordered pill, which is right for
           * "Run your own" and absurd for three letters: the affordance ends up
           * costing more room than the two lines it saves. Still a <button>
           * underneath, because it toggles state on this page rather than going
           * anywhere, and a control that says "link" to a screen reader and
           * then does not navigate is a small lie.
           */
          style={{
            alignSelf: 'flex-start',
            padding: 0,
            border: 0,
            background: 'none',
            font: 'inherit',
            fontSize: 'var(--text-sm)',
            color: 'var(--color-fg-muted)',
            textDecoration: 'underline',
            textUnderlineOffset: 2,
            cursor: 'pointer',
          }}
        >
          {expanded ? 'Less' : 'More'}
        </button>
      )}

      {/* The two actions belong to the full version: collapsed, this notice is
          one sentence saying the numbers are invented, which is all a reader
          who has not asked for more needs from it. */}
      {expanded && SandboxSwitch && (
        <Suspense fallback={null}>
          <SandboxSwitch />
        </Suspense>
      )}

      {expanded &&
        (canClaim ? (
          <a className="demo-banner-action" href="/app">
            Make this instance yours
          </a>
        ) : (
          <a
            className="demo-banner-action"
            href="https://github.com/lelabnet-creator/ternproject#readme"
            target="_blank"
            rel="noreferrer noopener"
          >
            Run your own
          </a>
        ))}
    </div>
  )
}

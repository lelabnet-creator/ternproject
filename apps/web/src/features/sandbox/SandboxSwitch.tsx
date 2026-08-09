import { resetSandbox, sandboxSize } from '../../lib/sandbox'
import { sandboxOn, setSandboxOn } from '../../lib/sandbox-flag'

/**
 * Turns the demo writable, in this browser, while developing.
 *
 * The demo refuses writes so that it can be left open, which also means half
 * the product cannot be looked at on it: nobody sees what creating a control
 * does, or what an import of forty reports, without standing up an instance
 * first. This switch answers those writes locally instead — see `lib/sandbox.ts`
 * for what that means and what it deliberately does not cover.
 *
 * ## Why it reloads
 *
 * Flipping it changes where every answer on the page comes from. React Query is
 * holding results fetched under the other regime, and invalidating the right
 * subset of them from here would be a list to maintain and get wrong. A reload
 * is one line and cannot be incomplete.
 *
 * ## Why it says how much it is holding
 *
 * The failure this is most likely to cause is somebody debugging a bug that
 * only exists in their own localStorage. The count, and the way out beside it,
 * are what make that a five-second discovery instead of an afternoon.
 */
export function SandboxSwitch() {
  const on = sandboxOn()
  // Counted on every render rather than once at mount. The banner outlives the
  // screens below it, so a figure taken at mount would say "0 changes" over an
  // estate the sandbox had just rewritten — which is the exact confusion the
  // count is here to prevent.
  const held = on ? sandboxSize() : 0

  const flip = (next: boolean) => {
    setSandboxOn(next)
    window.location.reload()
  }

  if (!on) {
    return (
      <button type="button" className="demo-banner-action" onClick={() => flip(true)}>
        Enable local writes (dev)
      </button>
    )
  }

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
      <span style={{ fontSize: 'var(--text-xs)' }}>
        {/* Said in the singular below two, because "1 changes" is the kind of
            wrong that makes a reader distrust the number itself. */}
        Local writes on · {held === 1 ? '1 change' : `${held} changes`} in this browser
      </span>
      <button
        type="button"
        className="demo-banner-action"
        onClick={() => {
          resetSandbox()
          window.location.reload()
        }}
      >
        Discard
      </button>
      <button type="button" className="demo-banner-action" onClick={() => flip(false)}>
        Turn off
      </button>
    </span>
  )
}

export default SandboxSwitch

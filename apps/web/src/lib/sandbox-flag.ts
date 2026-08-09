/**
 * Whether the development sandbox is on — and nothing else.
 *
 * Split from `sandbox.ts` because three places have to ask the question before
 * they can decide not to load the answer: the request seam, the admin shell
 * working out whether to draw its write buttons, and the switch itself. Each of
 * them importing the engine to read one boolean would drag it into the main
 * bundle and undo the point of loading it on demand.
 *
 * Ten lines with no dependencies, so importing it costs nothing anywhere.
 */

export const SANDBOX_KEY = 'tern.sandbox'
export const SANDBOX_ENABLED_KEY = `${SANDBOX_KEY}.enabled`
export const SANDBOX_OVERLAY_KEY = `${SANDBOX_KEY}.overlay`

/**
 * Read from storage every time rather than cached.
 *
 * Two tabs share the origin and the storage, and a sandbox left on in one after
 * being switched off in the other would be a page quietly lying about where its
 * data comes from.
 */
export function sandboxOn(): boolean {
  if (!import.meta.env.DEV) return false
  try {
    return localStorage.getItem(SANDBOX_ENABLED_KEY) === '1'
  } catch {
    // No storage — private browsing, or a render with no window at all. Off is
    // the honest default for both.
    return false
  }
}

export function setSandboxOn(on: boolean): void {
  try {
    if (on) localStorage.setItem(SANDBOX_ENABLED_KEY, '1')
    else localStorage.removeItem(SANDBOX_ENABLED_KEY)
  } catch {
    /* nothing to do about it, and nothing worth saying */
  }
}

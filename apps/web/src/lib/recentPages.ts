/**
 * The pages this browser has actually opened.
 *
 * The root deliberately refuses to tell you whether a name exists — that check
 * would be an oracle for enumerating tenants. This list is the other half of
 * that trade: it costs the visitor nothing in privacy, because it never leaves
 * the device and only ever holds pages they already reached.
 *
 * A page is remembered when its summary loads, never when a name is typed. A
 * typo would otherwise sit in the list forever, and a 404 would end up looking
 * like a page that exists.
 */

const KEY = 'tern.recent-pages'
/** Enough to cover the handful of pages one person watches; short enough to read at a glance. */
const LIMIT = 6

export interface RecentPage {
  slug: string
  /** The tenant's own name, so the list reads as pages rather than as slugs. */
  name: string
  /** Epoch milliseconds, used only to order the list. */
  seenAt: number
}

/**
 * Storage can throw rather than return null — Safari's private mode, and any
 * browser with site data blocked. A landing page that crashes because history
 * is unavailable is worse than one with no history, so every access is guarded.
 */
function read(): RecentPage[] {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    // Validated rather than trusted: this is data another version of this app
    // wrote, and it is rendered straight into the page.
    return parsed
      .filter(
        (entry): entry is RecentPage =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as RecentPage).slug === 'string' &&
          typeof (entry as RecentPage).name === 'string' &&
          typeof (entry as RecentPage).seenAt === 'number',
      )
      .slice(0, LIMIT)
  } catch {
    return []
  }
}

function write(entries: RecentPage[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entries))
  } catch {
    // Full, or blocked. Nothing here is worth interrupting the page for.
  }
}

/** Most recently seen first. */
export function recentPages(): RecentPage[] {
  return read().sort((a, b) => b.seenAt - a.seenAt)
}

/** Records a page that loaded, moving it to the front if it was already known. */
export function rememberPage(slug: string, name: string): void {
  const rest = read().filter((entry) => entry.slug !== slug)
  write([{ slug, name, seenAt: Date.now() }, ...rest].slice(0, LIMIT))
}

/**
 * Drops one page.
 *
 * A shared machine, a page you no longer work on, a customer you no longer
 * have: a history you cannot edit is one people would rather not have at all.
 */
export function forgetPage(slug: string): void {
  write(read().filter((entry) => entry.slug !== slug))
}

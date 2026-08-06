import { beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetPage, recentPages, rememberPage } from './recentPages'

const KEY = 'tern.recent-pages'

/**
 * The suite runs in Node, and this module is the one piece of the web app that
 * talks to the browser directly. A Map behind the four methods it uses is
 * enough, and cheaper than pulling a whole DOM in for one key.
 */
const store = new Map<string, string>()
const localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
}
vi.stubGlobal('window', { localStorage })

describe('recentPages', () => {
  beforeEach(() => {
    store.clear()
    vi.useRealTimers()
  })

  it('lists the most recently seen page first', () => {
    vi.useFakeTimers()
    rememberPage('acme', 'Acme')
    vi.advanceTimersByTime(1000)
    rememberPage('globex', 'Globex')

    expect(recentPages().map((p) => p.slug)).toEqual(['globex', 'acme'])
  })

  it('moves a page already known to the front rather than duplicating it', () => {
    vi.useFakeTimers()
    rememberPage('acme', 'Acme')
    vi.advanceTimersByTime(1000)
    rememberPage('globex', 'Globex')
    vi.advanceTimersByTime(1000)
    rememberPage('acme', 'Acme Corp')

    const pages = recentPages()
    expect(pages).toHaveLength(2)
    expect(pages[0]).toMatchObject({ slug: 'acme', name: 'Acme Corp' })
  })

  it('keeps at most six pages, dropping the oldest', () => {
    vi.useFakeTimers()
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      rememberPage(`page-${n}`, `Page ${n}`)
      vi.advanceTimersByTime(1000)
    }

    const slugs = recentPages().map((p) => p.slug)
    expect(slugs).toHaveLength(6)
    expect(slugs).not.toContain('page-1')
    expect(slugs[0]).toBe('page-7')
  })

  it('forgets one page and leaves the rest', () => {
    rememberPage('acme', 'Acme')
    rememberPage('globex', 'Globex')
    forgetPage('acme')

    expect(recentPages().map((p) => p.slug)).toEqual(['globex'])
  })

  it('ignores stored junk rather than rendering it', () => {
    // Whatever another version of this app, or a person with the console open,
    // left behind. Anything malformed is dropped, not trusted.
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { slug: 'ok', name: 'Fine', seenAt: 1 },
        { slug: 'no-name', seenAt: 2 },
        null,
        'not-an-object',
        { slug: 42, name: 'Wrong type', seenAt: 3 },
      ]),
    )

    expect(recentPages().map((p) => p.slug)).toEqual(['ok'])
  })

  it('survives storage holding something that is not an array', () => {
    localStorage.setItem(KEY, '{"nope":true}')
    expect(recentPages()).toEqual([])
  })

  it('survives unparseable storage', () => {
    localStorage.setItem(KEY, 'not json at all')
    expect(recentPages()).toEqual([])
  })
})

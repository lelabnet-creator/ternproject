import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../config.js'
import {
  compareVersions,
  listTags,
  newestRelease,
  parseVersion,
  releaseState,
  resetReleaseCache,
  splitImage,
} from './release.js'

/**
 * The comparison is the part that can be quietly wrong: a notice that never
 * fires and a notice that fires forever both look like "it works" from the code.
 */

describe('parseVersion', () => {
  it('reads a tag with or without its v', () => {
    expect(parseVersion('1.4.2')).toMatchObject({ major: 1, minor: 4, patch: 2, prerelease: null })
    expect(parseVersion('v1.4.2')).toMatchObject({ major: 1, minor: 4, patch: 2 })
  })

  it('keeps the tag exactly as the registry spells it', () => {
    // A link built from a normalised string points at a tag that may not exist.
    expect(parseVersion('v1.4.2')?.raw).toBe('v1.4.2')
  })

  it('refuses a moving tag', () => {
    // `1.4` means "the newest patch of 1.4" and `latest` means whatever was
    // pushed last. Comparing either against a point release compares a range.
    for (const tag of ['latest', '1.4', 'main', 'sha-9f2a1c', '']) {
      expect(parseVersion(tag), tag).toBeNull()
    }
  })

  it('reads a prerelease and its build metadata', () => {
    expect(parseVersion('v2.0.0-rc.1')?.prerelease).toBe('rc.1')
    expect(parseVersion('2.0.0+build.5')).toMatchObject({ major: 2, prerelease: null })
  })
})

describe('compareVersions', () => {
  const v = (raw: string) => parseVersion(raw)!

  it('orders by major, then minor, then patch', () => {
    expect(compareVersions(v('1.0.0'), v('2.0.0'))).toBeLessThan(0)
    expect(compareVersions(v('1.5.0'), v('1.4.9'))).toBeGreaterThan(0)
    expect(compareVersions(v('1.4.10'), v('1.4.9'))).toBeGreaterThan(0)
    expect(compareVersions(v('1.4.2'), v('v1.4.2'))).toBe(0)
  })

  it('sorts a prerelease below the release it precedes', () => {
    expect(compareVersions(v('2.0.0-rc.1'), v('2.0.0'))).toBeLessThan(0)
    expect(compareVersions(v('2.0.0'), v('2.0.0-rc.1'))).toBeGreaterThan(0)
  })
})

describe('newestRelease', () => {
  it('picks the highest release, ignoring moving and prerelease tags', () => {
    expect(newestRelease(['latest', '0.1', '0.1.9', '0.1.10', '0.2.0-rc.1'])).toBe('0.1.10')
  })

  it('does not nudge a production instance towards a release candidate', () => {
    // Even when the candidate is the newest thing published.
    expect(newestRelease(['1.0.0', '1.1.0-rc.2'])).toBe('1.0.0')
  })

  it('answers null when a repository publishes no releases at all', () => {
    expect(newestRelease(['latest', 'main', 'sha-abc1234'])).toBeNull()
    expect(newestRelease([])).toBeNull()
  })
})

describe('splitImage', () => {
  it('splits a host from a repository', () => {
    expect(splitImage('ghcr.io/lelabnet-creator/ternproject')).toEqual({
      host: 'ghcr.io',
      repository: 'lelabnet-creator/ternproject',
    })
  })

  it('keeps a port with the host', () => {
    expect(splitImage('registry.internal:5000/ops/tern')).toEqual({
      host: 'registry.internal:5000',
      repository: 'ops/tern',
    })
  })

  it('falls back to Docker Hub when no host is given', () => {
    expect(splitImage('someone/tern')).toEqual({
      host: 'registry-1.docker.io',
      repository: 'someone/tern',
    })
    expect(splitImage('tern')).toEqual({
      host: 'registry-1.docker.io',
      repository: 'library/tern',
    })
  })
})

describe('listTags', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** A registry that answers a token, then one page of tags per call. */
  function registry(pages: { tags: string[]; next?: string }[]) {
    const calls: string[] = []
    let page = 0

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        if (url.includes('/token?')) {
          return new Response(JSON.stringify({ token: 'anonymous' }), { status: 200 })
        }
        const body = pages[page]!
        page++
        return new Response(JSON.stringify({ tags: body.tags }), {
          status: 200,
          headers: body.next ? { link: `<${body.next}>; rel="next"` } : {},
        })
      }),
    )

    return calls
  }

  it('asks for a pull token before the list', async () => {
    const calls = registry([{ tags: ['1.0.0'] }])

    await expect(listTags('ghcr.io/owner/name')).resolves.toEqual(['1.0.0'])
    expect(calls[0]).toContain('https://ghcr.io/token?')
    expect(calls[0]).toContain(encodeURIComponent('repository:owner/name:pull'))
    expect(calls[1]).toBe('https://ghcr.io/v2/owner/name/tags/list')
  })

  it('follows pagination, because the newest release is on the last page', async () => {
    // Registries return tags in lexical order, so `0.1.9` lands after `0.1.10`
    // and a truncated first page is the one missing the release that matters.
    const calls = registry([
      { tags: ['0.1.10'], next: '/v2/owner/name/tags/list?last=0.1.10' },
      { tags: ['0.1.9', '0.2.0'] },
    ])

    const tags = await listTags('ghcr.io/owner/name')

    expect(tags).toEqual(['0.1.10', '0.1.9', '0.2.0'])
    // One token, two pages.
    expect(calls).toHaveLength(3)
    expect(calls[2]).toBe('https://ghcr.io/v2/owner/name/tags/list?last=0.1.10')
    expect(newestRelease(tags)).toBe('0.2.0')
  })

  it('reports the status when the registry refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/token?')
          ? new Response(JSON.stringify({ token: 'anonymous' }), { status: 200 })
          : new Response('no such repository', { status: 404 }),
      ),
    )

    await expect(listTags('ghcr.io/owner/gone')).rejects.toThrow(/404/)
  })

  it('sends the list unauthenticated when the registry issues no token', async () => {
    // A registry with no token endpoint is not a reason to give up before
    // asking: the plain request either works or fails on its own terms.
    const seen: RequestInit[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.includes('/token?')) return new Response('', { status: 404 })
        seen.push(init)
        return new Response(JSON.stringify({ tags: ['1.0.0'] }), { status: 200 })
      }),
    )

    await expect(listTags('registry.internal:5000/ops/tern')).resolves.toEqual(['1.0.0'])
    expect((seen[0]?.headers as Record<string, string>).authorization).toBeUndefined()
  })
})

/**
 * The verdict as the process start-up path uses it.
 *
 * `server.ts` fires this once after `listen` and never awaits it, so the one
 * property that path depends on is that it settles rather than rejects — an
 * unreachable registry is a verdict of "we do not know", not an unhandled
 * rejection in a process that has just begun serving.
 */
describe('releaseState, as the startup call uses it', () => {
  /*
   * A version, because a build that has none never reaches the registry at all
   * — there is nothing to compare a tag to, and the check says so and stops.
   * That is right, and it is also why these cases have to state one.
   */
  const declared = config.TERN_VERSION

  beforeEach(() => {
    ;(config as { TERN_VERSION: string }).TERN_VERSION = '0.0.1'
    resetReleaseCache()
  })

  afterEach(() => {
    ;(config as { TERN_VERSION: string }).TERN_VERSION = declared
    vi.unstubAllGlobals()
    resetReleaseCache()
  })

  it('settles into a verdict when the registry cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('getaddrinfo ENOTFOUND ghcr.io'))),
    )

    const state = await releaseState()
    expect(state.state).toBe('unknown')
    // And says which registry and why, because "unknown" alone is the answer
    // that makes somebody stop believing the screen.
    expect(state.detail).toMatch(/ghcr\.io/)
  })

  it('reads the registry once, however many callers ask', async () => {
    let lists = 0
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('/token?')) {
          return Promise.resolve(new Response(JSON.stringify({ token: 't' }), { status: 200 }))
        }
        lists += 1
        return Promise.resolve(new Response(JSON.stringify({ tags: ['0.0.1'] }), { status: 200 }))
      }),
    )

    // The startup call and the first admin to load a page are two callers a
    // moment apart; the second must join the first rather than start a second
    // round trip to ghcr.io.
    await Promise.all([releaseState(), releaseState()])
    await releaseState()
    expect(lists).toBe(1)
  })
})

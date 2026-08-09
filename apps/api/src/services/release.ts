import { config } from '../config.js'

/**
 * Whether a newer image than this one has been published.
 *
 * The question an operator cannot answer from inside the container: the running
 * build knows its own tag, and nothing else tells it that three releases have
 * happened since. So this asks the registry the instance deploys from — the
 * same anonymous tag listing `docker pull` makes — and compares.
 *
 * Three rules keep it from lying:
 *
 * - A build with no stamped version is *unknown*, not *current*. Guessing one
 *   would eventually tell somebody to upgrade to what they are already running.
 * - A failed check is *unknown* too, and says why. "Could not reach ghcr.io" and
 *   "you are up to date" are different facts, and a screen that shows the second
 *   for the first is the reason nobody trusts update notices.
 * - Only complete `X.Y.Z` release tags are candidates. `latest` and `1.4` move
 *   under the reader, and a release candidate is not something to nudge a
 *   production instance towards.
 */

export type ReleaseVerdict = 'current' | 'update' | 'unknown'

export interface ReleaseState {
  state: ReleaseVerdict
  /** What this build says it is, normalised without its `v`. Null when unstamped. */
  current: string | null
  /** Newest published release tag. Null when the registry could not be read. */
  latest: string | null
  /** The commit the current tag pointed at, for a bug report. Null when unstamped. */
  revision: string | null
  /** Which repository was asked, so a surprising answer can be traced to its source. */
  image: string
  /** ISO. When the registry was last read — not when this response was built. */
  checkedAt: string
  /** The verdict in a sentence, including the reason when there is no verdict. */
  detail: string
}

// ── Versions ────────────────────────────────────────────────────────────────

interface Version {
  major: number
  minor: number
  patch: number
  /** The `-rc.1` part, or null for a release. Never compared beyond release-beats-prerelease. */
  prerelease: string | null
  /** The tag as the registry spells it, so a link points at something that exists. */
  raw: string
}

/**
 * Reads `1.4.2`, `v1.4.2` and `v1.4.2-rc.1`. Anything else is null.
 *
 * Deliberately strict about the three numbers: `1.4` is a moving tag that means
 * "the newest patch of 1.4", so treating it as a version would compare a range
 * against a point and call the range newer half the time.
 */
export function parseVersion(raw: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    raw.trim(),
  )
  if (!match) return null

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
    raw: raw.trim(),
  }
}

/** Negative when `a` is older. A prerelease sorts below the release it precedes. */
export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.prerelease === b.prerelease) return 0
  // `1.4.0-rc.1` is older than `1.4.0`, and two different prereleases of the
  // same version are treated as equal: ordering them needs the identifier rules
  // nothing here depends on, and calling them equal only ever withholds a
  // notice — it never invents one.
  if (a.prerelease === null) return 1
  if (b.prerelease === null) return -1
  return 0
}

/** The newest complete release tag in a registry's list, or null if it has none. */
export function newestRelease(tags: readonly string[]): string | null {
  let best: Version | null = null

  for (const tag of tags) {
    const version = parseVersion(tag)
    if (!version || version.prerelease !== null) continue
    if (!best || compareVersions(version, best) > 0) best = version
  }

  return best?.raw ?? null
}

// ── The registry ────────────────────────────────────────────────────────────

/** Splits `ghcr.io/owner/name` into a host and a repository path. */
export function splitImage(image: string): { host: string; repository: string } {
  const [first, ...rest] = image.split('/')

  // A first segment with a dot or a port is a host; otherwise the whole thing
  // is a Docker Hub repository, and a bare name lives under `library/`.
  if (rest.length > 0 && first && (first.includes('.') || first.includes(':'))) {
    return { host: first, repository: rest.join('/') }
  }

  return {
    host: 'registry-1.docker.io',
    repository: rest.length > 0 ? image : `library/${image}`,
  }
}

/**
 * A pull token for a public repository.
 *
 * Registries answer `/v2/.../tags/list` with a 401 and a challenge rather than
 * the list, even when the image is public — the token is the anonymous half of
 * that exchange. Null when the registry does not issue one, which leaves the
 * unauthenticated request to fail on its own terms and be reported as such.
 */
async function pullToken(host: string, repository: string, signal: AbortSignal) {
  const url =
    `https://${host}/token?service=${encodeURIComponent(host)}` +
    `&scope=${encodeURIComponent(`repository:${repository}:pull`)}`

  const response = await fetch(url, { signal, headers: { accept: 'application/json' } })
  if (!response.ok) return null

  const body = (await response.json()) as { token?: string; access_token?: string }
  return body.token ?? body.access_token ?? null
}

/**
 * Every tag on a repository, following the registry's pagination.
 *
 * Pagination is followed rather than ignored because the list comes back in
 * lexical order: `0.1.10` sorts before `0.1.9`, so a truncated first page is
 * exactly the page missing the newest release. The page cap is a stop against a
 * registry that never stops offering a next one.
 */
export async function listTags(
  image: string,
  { timeoutMs = 5_000 }: { timeoutMs?: number } = {},
): Promise<string[]> {
  const { host, repository } = splitImage(image)
  const signal = AbortSignal.timeout(timeoutMs)

  const token = await pullToken(host, repository, signal)
  const headers: Record<string, string> = { accept: 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`

  const tags: string[] = []
  let path: string | null = `/v2/${repository}/tags/list`

  for (let page = 0; page < 10 && path; page++) {
    const response: Response = await fetch(`https://${host}${path}`, { headers, signal })
    if (!response.ok) {
      throw new Error(`${host} answered ${response.status} for ${repository}`)
    }

    const body = (await response.json()) as { tags?: string[] | null }
    if (body.tags) tags.push(...body.tags)

    path = nextPage(response.headers.get('link'))
  }

  return tags
}

/** The `</v2/…>; rel="next"` link a paginating registry sends, or null at the end. */
function nextPage(link: string | null): string | null {
  if (!link) return null
  const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(link)
  if (!match?.[1]) return null
  // Absolute or relative depending on the registry; only the path is used, and
  // the host is the one we already asked — a next link pointing elsewhere is
  // not somewhere this should follow.
  return match[1].startsWith('http')
    ? new URL(match[1]).pathname + new URL(match[1]).search
    : match[1]
}

// ── The cached answer ───────────────────────────────────────────────────────

let cached: { until: number; value: ReleaseState } | null = null
let inFlight: Promise<ReleaseState> | null = null

/**
 * A failed check is remembered for far less time than a successful one.
 *
 * Six hours of "could not reach the registry" after one dropped connection
 * would hide a release for the rest of the day; a few minutes is enough to stop
 * a broken network from being retried on every page load.
 */
const FAILURE_TTL_MS = 10 * 60_000

/** Drops the cached answer. For tests, and for nothing else. */
export function resetReleaseCache(): void {
  cached = null
  inFlight = null
}

/** The current verdict, reading the registry at most once per configured interval. */
export async function releaseState(): Promise<ReleaseState> {
  if (cached && Date.now() < cached.until) return cached.value

  // Single-flight: two admins loading the screen at once is one registry read,
  // not two. The second await joins the first request rather than starting one.
  inFlight ??= check().finally(() => {
    inFlight = null
  })

  return inFlight
}

async function check(): Promise<ReleaseState> {
  const current = parseVersion(config.TERN_VERSION)
  const base = {
    current: current?.raw.replace(/^v/, '') ?? null,
    revision: config.TERN_REVISION ? config.TERN_REVISION.slice(0, 7) : null,
    image: config.TERN_UPDATE_IMAGE,
    checkedAt: new Date().toISOString(),
  }

  const settle = (value: ReleaseState, ttlMs: number) => {
    cached = { until: Date.now() + ttlMs, value }
    return value
  }

  const interval = config.TERN_UPDATE_CHECK_INTERVAL_H * 3_600_000

  if (!config.TERN_UPDATE_CHECK) {
    // Not cached: there is nothing to spare, and the setting can change under a
    // restart without leaving a stale answer behind.
    return { ...base, state: 'unknown', latest: null, detail: 'Update checks are turned off.' }
  }

  if (!current) {
    return settle(
      {
        ...base,
        state: 'unknown',
        latest: null,
        detail:
          'This build does not say which version it is, so there is nothing to compare. Images published by CI carry their tag; one built by hand does not.',
      },
      interval,
    )
  }

  let tags: string[]
  try {
    tags = await listTags(config.TERN_UPDATE_IMAGE)
  } catch (error) {
    return settle(
      {
        ...base,
        state: 'unknown',
        latest: null,
        detail: `Could not read ${config.TERN_UPDATE_IMAGE}: ${describe(error)}`,
      },
      FAILURE_TTL_MS,
    )
  }

  const latestTag = newestRelease(tags)
  const latest = latestTag ? parseVersion(latestTag) : null

  if (!latest) {
    return settle(
      {
        ...base,
        state: 'unknown',
        latest: null,
        detail: `${config.TERN_UPDATE_IMAGE} publishes no released version tags.`,
      },
      interval,
    )
  }

  const newer = compareVersions(latest, current) > 0
  const latestPlain = latest.raw.replace(/^v/, '')

  return settle(
    {
      ...base,
      state: newer ? 'update' : 'current',
      latest: latestPlain,
      detail: newer
        ? `${latestPlain} has been published. This instance runs ${base.current}.`
        : // Ahead of the registry is a normal state for anyone running a build
          // of their own, and saying "up to date" for it would be wrong in the
          // direction that matters least — but still wrong.
          compareVersions(current, latest) > 0
          ? `This instance runs ${base.current}, ahead of the newest published release (${latestPlain}).`
          : `Up to date — ${latestPlain} is the newest published release.`,
    },
    interval,
  )
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    if (cause instanceof Error && cause.message) return `${error.message} (${cause.message})`
    return error.message
  }
  return String(error)
}

/**
 * What the HTTP layer is actually doing, minute by minute.
 *
 * Nothing measured requests before this. The figures in `/system/*` count rows
 * stored, which is a different question: a jam is a property of requests, and
 * during one the row count is the number that has stopped moving.
 *
 * In process, in a fixed ring of per-minute buckets, and deliberately not in the
 * database. A jam is exactly when writing more rows is the wrong move, and a
 * counter that needs the pool to be readable is a counter that goes blind
 * precisely when it is wanted.
 *
 * The consequence, which the screen has to state rather than hide: these numbers
 * describe *the instance that answered*, not the deployment. Two API containers
 * behind a balancer keep two of these, and neither knows about the other.
 */

/** Two hours. Long enough to see a jam build, short enough to stay small. */
const WINDOW_MINUTES = 120

export const REQUEST_CLASSES = ['ingest', 'agent', 'admin', 'public'] as const
export type RequestClass = (typeof REQUEST_CLASSES)[number]

/**
 * Latency buckets, in milliseconds.
 *
 * A histogram rather than the samples themselves: percentiles from kept samples
 * need either unbounded memory or a reservoir that silently lies about the tail,
 * and the tail is the half of this that matters. Reported as "at or under this
 * bound", which is what a histogram honestly knows.
 */
const BOUNDS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000] as const

/**
 * How many distinct keys one minute will track.
 *
 * Bounded because the map is keyed by something a caller supplies. Without a cap
 * a flood of invalid keys would grow it once per request, turning a nuisance
 * into memory exhaustion.
 */
const MAX_KEYS_PER_BUCKET = 200

interface Bucket {
  /** Epoch minutes, so a bucket knows whether it is stale rather than rotated. */
  minute: number
  requests: Record<RequestClass, number>
  rateLimited: Record<RequestClass, number>
  failed: Record<RequestClass, number>
  histogram: Record<RequestClass, number[]>
  byKey: Map<string, number>
}

function emptyBucket(minute: number): Bucket {
  const perClass = <T>(make: () => T) =>
    Object.fromEntries(REQUEST_CLASSES.map((c) => [c, make()])) as Record<RequestClass, T>

  return {
    minute,
    requests: perClass(() => 0),
    rateLimited: perClass(() => 0),
    failed: perClass(() => 0),
    histogram: perClass(() => new Array<number>(BOUNDS.length + 1).fill(0)),
    byKey: new Map(),
  }
}

export interface ClassFigures {
  requests: number
  perMinute: number
  rateLimited: number
  failed: number
  /** Null when nothing was measured, or when the samples overflowed the top bound. */
  p50Ms: number | null
  p95Ms: number | null
}

export interface MetricsSnapshot {
  /** Minutes actually covered — fewer than asked for on a freshly started process. */
  minutes: number
  startedAt: string
  inFlight: number
  byClass: Record<RequestClass, ClassFigures>
  /** Requests per minute across all classes, oldest first, for a sparkline. */
  perMinute: { minute: string; requests: number; rateLimited: number }[]
  /** Ingest volume by the key that sent it. The caller resolves keys to agents. */
  byApiKey: { apiKeyId: string; requests: number }[]
}

export class HttpMetrics {
  private readonly ring: Bucket[] = []
  private readonly startedAt = new Date()
  private live = 0

  /** Requests currently being served. The first number to look at during a jam. */
  get inFlight(): number {
    return this.live
  }

  began(): void {
    this.live++
  }

  finished(): void {
    // Floored: an onResponse without its onRequest — a connection dropped during
    // startup, say — must not drive this negative and make the gauge nonsense.
    this.live = Math.max(0, this.live - 1)
  }

  record(options: {
    kind: RequestClass
    latencyMs: number
    statusCode: number
    apiKeyId?: string
    now?: number
  }): void {
    const minute = Math.floor((options.now ?? Date.now()) / 60_000)
    const bucket = this.bucketFor(minute)

    bucket.requests[options.kind]++
    if (options.statusCode === 429) bucket.rateLimited[options.kind]++
    if (options.statusCode >= 500) bucket.failed[options.kind]++
    bucket.histogram[options.kind]![bucketIndex(options.latencyMs)]!++

    const known = options.apiKeyId !== undefined && bucket.byKey.has(options.apiKeyId)
    if (options.apiKeyId && (known || bucket.byKey.size < MAX_KEYS_PER_BUCKET)) {
      bucket.byKey.set(options.apiKeyId, (bucket.byKey.get(options.apiKeyId) ?? 0) + 1)
    }
  }

  snapshot(minutes = 60, now = Date.now()): MetricsSnapshot {
    const currentMinute = Math.floor(now / 60_000)
    const oldest = currentMinute - Math.min(minutes, WINDOW_MINUTES) + 1
    const live = this.ring.filter((b) => b.minute >= oldest && b.minute <= currentMinute)

    const covered =
      live.length === 0 ? 0 : currentMinute - Math.min(...live.map((b) => b.minute)) + 1
    // Divided by the window covered, not by the buckets that exist: a quiet
    // minute records nothing, and skipping it would report the average of the
    // busy minutes as though it were the average of all of them.
    const divisor = Math.max(1, covered)

    const byClass = Object.fromEntries(
      REQUEST_CLASSES.map((kind) => {
        const histogram = new Array<number>(BOUNDS.length + 1).fill(0)
        let requests = 0
        let rateLimited = 0
        let failed = 0

        for (const bucket of live) {
          requests += bucket.requests[kind]
          rateLimited += bucket.rateLimited[kind]
          failed += bucket.failed[kind]
          for (let i = 0; i < histogram.length; i++) {
            histogram[i] = (histogram[i] ?? 0) + (bucket.histogram[kind]![i] ?? 0)
          }
        }

        return [
          kind,
          {
            requests,
            perMinute: Math.round((requests / divisor) * 10) / 10,
            rateLimited,
            failed,
            p50Ms: percentile(histogram, 0.5),
            p95Ms: percentile(histogram, 0.95),
          } satisfies ClassFigures,
        ]
      }),
    ) as Record<RequestClass, ClassFigures>

    const perMinute = [...live]
      .sort((a, b) => a.minute - b.minute)
      .map((bucket) => ({
        minute: new Date(bucket.minute * 60_000).toISOString(),
        requests: REQUEST_CLASSES.reduce((sum, c) => sum + bucket.requests[c], 0),
        rateLimited: REQUEST_CLASSES.reduce((sum, c) => sum + bucket.rateLimited[c], 0),
      }))

    const totals = new Map<string, number>()
    for (const bucket of live) {
      for (const [keyId, count] of bucket.byKey) {
        totals.set(keyId, (totals.get(keyId) ?? 0) + count)
      }
    }

    return {
      minutes: covered,
      startedAt: this.startedAt.toISOString(),
      inFlight: this.live,
      byClass,
      perMinute,
      byApiKey: [...totals]
        .map(([apiKeyId, requests]) => ({ apiKeyId, requests }))
        .sort((a, b) => b.requests - a.requests),
    }
  }

  private bucketFor(minute: number): Bucket {
    const existing = this.ring.find((b) => b.minute === minute)
    if (existing) return existing

    const bucket = emptyBucket(minute)
    this.ring.push(bucket)

    // Evicted by age rather than by count: a process idle for three hours holds
    // three buckets, not a ring of stale ones pretending to be a window.
    const oldest = minute - WINDOW_MINUTES + 1
    for (let i = this.ring.length - 1; i >= 0; i--) {
      if (this.ring[i]!.minute < oldest) this.ring.splice(i, 1)
    }

    return bucket
  }
}

function bucketIndex(latencyMs: number): number {
  for (let i = 0; i < BOUNDS.length; i++) {
    if (latencyMs <= BOUNDS[i]!) return i
  }
  return BOUNDS.length
}

function percentile(histogram: number[], p: number): number | null {
  const total = histogram.reduce((a, b) => a + b, 0)
  if (total === 0) return null

  const target = Math.ceil(total * p)
  let seen = 0
  for (let i = 0; i < histogram.length; i++) {
    seen += histogram[i]!
    // The overflow slot has no upper bound to report, so it answers null rather
    // than the top bound — claiming "5000ms" for something that took a minute
    // is worse than admitting the histogram stops there.
    if (seen >= target) return BOUNDS[i] ?? null
  }
  return null
}

/**
 * Which kind of traffic a path is.
 *
 * By path rather than by anything the caller sends, because the point is to tell
 * an operator which *part* of the system is busy. Static assets are not counted
 * at all: a single page load fetches a dozen of them, and letting that into the
 * admin figure would bury the handful of requests anyone cares about.
 */
export function classifyRequest(url: string): RequestClass | null {
  const path = url.split('?')[0] ?? url

  if (path === '/api/v1/ingest' || path.startsWith('/api/v1/heartbeat/')) return 'ingest'
  if (path.startsWith('/api/v1/receivers/')) return 'ingest'

  if (path === '/api/v1/pair' || path.startsWith('/api/v1/agent/')) return 'agent'

  if (path.startsWith('/api/v1/public/') || path.startsWith('/badge/')) return 'public'
  if (path === '/health') return 'public'

  if (path.startsWith('/api/v1/')) return 'admin'

  // The SPA, the installer, the agent binaries — served by this process, but not
  // what "the HTTP layer under congestion" is asking about.
  return null
}

export const __testables = { percentile, bucketIndex, BOUNDS, WINDOW_MINUTES }

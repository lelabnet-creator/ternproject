import { describe, expect, it } from 'vitest'
import { classifyRequest, HttpMetrics, __testables } from './http-metrics.js'

/**
 * The counters, without a server.
 *
 * Everything here is arithmetic over a fixed ring, and the parts worth pinning
 * are the ones that are wrong in a way nobody notices: a percentile that reports
 * a bound it never measured, a rate averaged over the busy minutes only, and a
 * gauge that drifts upward on a failing instance.
 */

const MINUTE = 60_000

describe('classifying traffic', () => {
  it.each([
    ['/api/v1/ingest', 'ingest'],
    ['/api/v1/heartbeat/nightly-backup', 'ingest'],
    ['/api/v1/receivers/abc/tok', 'ingest'],
    ['/api/v1/pair', 'agent'],
    ['/api/v1/agent/jobs', 'agent'],
    ['/api/v1/public/acme/summary.json', 'public'],
    ['/badge/acme.svg', 'public'],
    ['/health', 'public'],
    ['/api/v1/acme/controls', 'admin'],
    ['/api/v1/auth/login', 'admin'],
  ])('reads %s as %s', (url, expected) => {
    expect(classifyRequest(url)).toBe(expected)
  })

  it('ignores the query string', () => {
    expect(classifyRequest('/badge/acme.svg?style=circle')).toBe('public')
  })

  it('counts no static asset', () => {
    // A page load pulls a dozen of these. Counting them would bury the handful
    // of admin requests the tab exists to show.
    expect(classifyRequest('/assets/index-abc123.js')).toBeNull()
    expect(classifyRequest('/app/acme')).toBeNull()
    expect(classifyRequest('/install.sh')).toBeNull()
  })
})

describe('percentiles', () => {
  const { percentile, BOUNDS } = __testables

  it('has nothing to say about nothing', () => {
    expect(percentile(new Array(BOUNDS.length + 1).fill(0), 0.5)).toBeNull()
  })

  it('reports the bound the sample falls under', () => {
    const histogram = new Array<number>(BOUNDS.length + 1).fill(0)
    histogram[0] = 100 // everything at or under 1ms
    expect(percentile(histogram, 0.5)).toBe(1)
    expect(percentile(histogram, 0.95)).toBe(1)
  })

  it('separates the median from the tail', () => {
    const metrics = new HttpMetrics()
    for (let i = 0; i < 95; i++) {
      metrics.record({ kind: 'admin', latencyMs: 3, statusCode: 200 })
    }
    for (let i = 0; i < 5; i++) {
      metrics.record({ kind: 'admin', latencyMs: 900, statusCode: 200 })
    }

    const { p50Ms, p95Ms } = metrics.snapshot().byClass.admin
    expect(p50Ms).toBe(5)
    expect(p95Ms).toBe(5)
    expect(metrics.snapshot(60).byClass.admin.requests).toBe(100)
  })

  it('refuses to name a bound it never measured', () => {
    // Everything overflowed the top bucket. Reporting the top bound would claim
    // a number the histogram does not know.
    const metrics = new HttpMetrics()
    metrics.record({ kind: 'admin', latencyMs: 90_000, statusCode: 200 })
    expect(metrics.snapshot().byClass.admin.p95Ms).toBeNull()
  })
})

describe('the ring', () => {
  it('averages over the window, not over the busy minutes', () => {
    const now = Date.now()
    const metrics = new HttpMetrics()

    // Sixty requests in one minute, then four silent minutes.
    for (let i = 0; i < 60; i++) {
      metrics.record({ kind: 'public', latencyMs: 5, statusCode: 200, now: now - 4 * MINUTE })
    }

    const snapshot = metrics.snapshot(60, now)
    expect(snapshot.byClass.public.requests).toBe(60)
    // 60 over the five minutes covered, not 60 over the one minute that had any.
    expect(snapshot.byClass.public.perMinute).toBe(12)
    expect(snapshot.minutes).toBe(5)
  })

  it('drops buckets older than the window', () => {
    const now = Date.now()
    const metrics = new HttpMetrics()

    metrics.record({ kind: 'admin', latencyMs: 5, statusCode: 200, now: now - 200 * MINUTE })
    metrics.record({ kind: 'admin', latencyMs: 5, statusCode: 200, now })

    expect(metrics.snapshot(120, now).byClass.admin.requests).toBe(1)
  })

  it('keeps a narrower window narrow', () => {
    const now = Date.now()
    const metrics = new HttpMetrics()

    metrics.record({ kind: 'admin', latencyMs: 5, statusCode: 200, now: now - 30 * MINUTE })
    metrics.record({ kind: 'admin', latencyMs: 5, statusCode: 200, now })

    expect(metrics.snapshot(120, now).byClass.admin.requests).toBe(2)
    expect(metrics.snapshot(5, now).byClass.admin.requests).toBe(1)
  })
})

describe('what the tab is for', () => {
  it('tallies rate-limited replies apart from failures', () => {
    const metrics = new HttpMetrics()
    metrics.record({ kind: 'ingest', latencyMs: 2, statusCode: 429 })
    metrics.record({ kind: 'ingest', latencyMs: 2, statusCode: 500 })
    metrics.record({ kind: 'ingest', latencyMs: 2, statusCode: 202 })

    const ingest = metrics.snapshot().byClass.ingest
    expect(ingest.requests).toBe(3)
    expect(ingest.rateLimited).toBe(1)
    expect(ingest.failed).toBe(1)
  })

  it('attributes ingest to the key that sent it', () => {
    const metrics = new HttpMetrics()
    metrics.record({ kind: 'ingest', latencyMs: 2, statusCode: 202, apiKeyId: 'key-a' })
    metrics.record({ kind: 'ingest', latencyMs: 2, statusCode: 202, apiKeyId: 'key-a' })
    metrics.record({ kind: 'ingest', latencyMs: 2, statusCode: 202, apiKeyId: 'key-b' })

    expect(metrics.snapshot().byApiKey).toEqual([
      { apiKeyId: 'key-a', requests: 2 },
      { apiKeyId: 'key-b', requests: 1 },
    ])
  })

  it('caps how many keys one minute will track', () => {
    // Keyed by something a caller supplies: a flood of invalid keys must not
    // grow the map once per request.
    const metrics = new HttpMetrics()
    for (let i = 0; i < 500; i++) {
      metrics.record({ kind: 'ingest', latencyMs: 1, statusCode: 401, apiKeyId: `key-${i}` })
    }
    expect(metrics.snapshot().byApiKey.length).toBeLessThanOrEqual(200)
  })

  it('never lets the in-flight gauge go negative', () => {
    // An onResponse without its onRequest would otherwise drive this below zero
    // and make the gauge nonsense for the rest of the process's life.
    const metrics = new HttpMetrics()
    metrics.finished()
    metrics.finished()
    expect(metrics.inFlight).toBe(0)

    metrics.began()
    expect(metrics.inFlight).toBe(1)
    metrics.finished()
    expect(metrics.inFlight).toBe(0)
  })

  it('reports a per-minute series oldest first', () => {
    const now = Date.now()
    const metrics = new HttpMetrics()
    metrics.record({ kind: 'admin', latencyMs: 1, statusCode: 200, now: now - 2 * MINUTE })
    metrics.record({ kind: 'admin', latencyMs: 1, statusCode: 429, now })

    const series = metrics.snapshot(60, now).perMinute
    expect(series).toHaveLength(2)
    expect(new Date(series[0]!.minute).getTime()).toBeLessThan(
      new Date(series[1]!.minute).getTime(),
    )
    expect(series[1]!.rateLimited).toBe(1)
  })
})

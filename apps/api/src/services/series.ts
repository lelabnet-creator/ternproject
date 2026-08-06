import type { CheckStatusValue } from '@tern/shared'

/**
 * Reducing a long series to something a chart can be drawn from.
 *
 * A 30-day simulation at one point per five minutes is over eight thousand
 * rows. Sending them all to draw a ribbon a few hundred pixels wide wastes the
 * transfer and the browser's time, so they are bucketed by time first.
 *
 * The rule inside a bucket is deliberately *worst-case*, not mean: an outage of
 * one point inside a bucket of twelve must survive the reduction. Averaging is
 * how a chart quietly reports a good day that contained a bad ten minutes.
 */

export interface SeriesPoint {
  ts: Date
  status: CheckStatusValue
  latencyMs: number | null
  value: number | null
  metrics?: Record<string, number>
}

/**
 * Named metrics averaged across a bucket, by the same reasoning as `value`.
 *
 * A metric missing from some points in the bucket is averaged over the points
 * that have it, not over the bucket size — dividing by points that never
 * reported it would drag every series towards zero.
 */
function averageMetrics(bucket: SeriesPoint[]): Record<string, number> | undefined {
  const sums = new Map<string, { total: number; count: number }>()

  for (const point of bucket) {
    for (const [name, value] of Object.entries(point.metrics ?? {})) {
      if (!Number.isFinite(value)) continue
      const entry = sums.get(name)
      if (entry) {
        entry.total += value
        entry.count += 1
      } else {
        sums.set(name, { total: value, count: 1 })
      }
    }
  }

  if (sums.size === 0) return undefined
  return Object.fromEntries([...sums].map(([name, s]) => [name, s.total / s.count]))
}

/** Worst first. `unknown` sits below `operational`: it is an absence, not health. */
const SEVERITY: CheckStatusValue[] = [
  'down',
  'partial',
  'degraded',
  'maintenance',
  'unknown',
  'operational',
]

function worse(a: CheckStatusValue, b: CheckStatusValue): CheckStatusValue {
  return SEVERITY.indexOf(a) <= SEVERITY.indexOf(b) ? a : b
}

export function downsample(points: SeriesPoint[], maxPoints: number): SeriesPoint[] {
  if (points.length <= maxPoints || maxPoints < 1) return points

  const first = points[0]!.ts.getTime()
  const last = points[points.length - 1]!.ts.getTime()
  const span = Math.max(1, last - first)
  const width = span / maxPoints

  const buckets = new Map<number, SeriesPoint[]>()
  for (const point of points) {
    const index = Math.min(maxPoints - 1, Math.floor((point.ts.getTime() - first) / width))
    const bucket = buckets.get(index)
    if (bucket) bucket.push(point)
    else buckets.set(index, [point])
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, bucket]) => {
      const latencies = bucket.map((p) => p.latencyMs).filter((v): v is number => v !== null)
      const values = bucket.map((p) => p.value).filter((v): v is number => v !== null)

      return {
        // The bucket's own first timestamp, not the computed boundary: it is a
        // moment that actually has data behind it.
        ts: bucket[0]!.ts,
        status: bucket.reduce<CheckStatusValue>((acc, p) => worse(acc, p.status), 'operational'),
        // The slowest, for the same reason as the worst status.
        latencyMs: latencies.length > 0 ? Math.max(...latencies) : null,
        // Measurements are averaged: a queue depth is a level, and taking its
        // maximum would draw a series of spikes that never happened together.
        value: values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null,
        metrics: averageMetrics(bucket),
      }
    })
}

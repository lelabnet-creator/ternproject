import { describe, expect, it } from 'vitest'
import { downsample, type SeriesPoint } from './series.js'

const at = (minutes: number, over: Partial<SeriesPoint> = {}): SeriesPoint => ({
  ts: new Date(Date.UTC(2026, 0, 1, 0, minutes)),
  status: 'operational',
  latencyMs: 100,
  value: null,
  ...over,
})

describe('downsampling a series for a chart', () => {
  it('leaves a short series alone', () => {
    const points = [at(0), at(5), at(10)]
    expect(downsample(points, 100)).toBe(points)
  })

  it('keeps a single bad point inside a bucket of good ones', () => {
    // The whole reason this is not an average: a five-minute outage inside an
    // hour must still be visible on the chart, or the chart is lying.
    const points = [
      ...Array.from({ length: 11 }, (_, i) => at(i * 5)),
      at(55, { status: 'down', latencyMs: 9000 }),
    ]

    const reduced = downsample(points, 2)
    expect(reduced.length).toBeLessThanOrEqual(2)
    expect(reduced.some((p) => p.status === 'down')).toBe(true)
    // And the latency it reports is the slow one, for the same reason.
    expect(Math.max(...reduced.map((p) => p.latencyMs ?? 0))).toBe(9000)
  })

  it('averages measurements rather than taking their peak', () => {
    // A queue depth is a level. Reducing by maximum would draw a row of spikes
    // that never occurred.
    const points = [at(0, { value: 10 }), at(1, { value: 20 }), at(2, { value: 30 })]
    const [bucket] = downsample(points, 1)
    expect(bucket!.value).toBe(20)
  })

  it('stays in chronological order', () => {
    const points = Array.from({ length: 200 }, (_, i) => at(i))
    const reduced = downsample(points, 10)
    const timestamps = reduced.map((p) => p.ts.getTime())
    expect([...timestamps].sort((a, b) => a - b)).toEqual(timestamps)
  })
})

describe('named metrics through the reduction', () => {
  it('averages a metric over the points that reported it, not the bucket size', () => {
    // Dividing by points that never carried the metric would drag every series
    // towards zero and make a sparse metric look like a decline.
    const points: SeriesPoint[] = [
      at(0, { metrics: { queue: 10 } }),
      at(1),
      at(2, { metrics: { queue: 20 } }),
    ]
    const [bucket] = downsample(points, 1)
    expect(bucket!.metrics?.queue).toBe(15)
  })

  it('leaves metrics undefined when no point carried any', () => {
    const [bucket] = downsample([at(0), at(1), at(2)], 1)
    expect(bucket!.metrics).toBeUndefined()
  })

  it('keeps several metrics side by side', () => {
    // The whole point: a control reporting a depth and a latency should not
    // have to choose which one gets charted.
    const points: SeriesPoint[] = [
      at(0, { metrics: { queue: 4, temperature: 60 } }),
      at(1, { metrics: { queue: 6, temperature: 70 } }),
    ]
    const [bucket] = downsample(points, 1)
    expect(bucket!.metrics).toEqual({ queue: 5, temperature: 65 })
  })
})

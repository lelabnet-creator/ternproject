import type { CheckStatusValue } from './status.js'

/**
 * Deterministic synthetic history.
 *
 * Used by the seed and by the indicator editor's simulation step. Seeded on
 * purpose: a demo that looks different on every machine makes screenshots,
 * tests and bug reports impossible to compare, and `Math.random()` in a chart
 * preview means the user cannot tell a rendering bug from noise.
 */

/** mulberry32 — small, fast, and good enough for plausible-looking data. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface MockPoint {
  ts: Date
  status: CheckStatusValue
  latencyMs: number | null
  value: number | null
  message: string | null
}

export interface MockSeriesOptions {
  /** Same seed → same series, on every machine and every run. */
  seed: number
  from: Date
  to: Date
  /** Sampling interval in seconds. */
  intervalS: number
  /** Fraction of samples that should be healthy, e.g. 0.999. */
  targetUptime?: number
  /** Baseline latency the walk oscillates around. */
  baseLatencyMs?: number
  /** How jittery the latency walk is, 0..1. */
  noise?: number
  /** Number of outage windows to inject across the range. */
  incidents?: number
  /** Emit a numeric measurement instead of a latency. */
  valueMode?: { base: number; amplitude: number }
}

interface Outage {
  start: number
  end: number
  severity: 'degraded' | 'partial' | 'down'
}

/**
 * Produces a series that behaves like a real service rather than white noise:
 * a latency random walk pulled back toward its baseline, a day/night cycle, and
 * a handful of outage windows with a ramp-up rather than an instant cliff.
 */
export function generateMockSeries(options: MockSeriesOptions): MockPoint[] {
  const {
    seed,
    from,
    to,
    intervalS,
    targetUptime = 0.995,
    baseLatencyMs = 120,
    noise = 0.35,
    incidents = 3,
    valueMode,
  } = options

  const rng = createRng(seed)
  const startMs = from.getTime()
  const endMs = to.getTime()
  const stepMs = intervalS * 1000
  const totalSteps = Math.max(1, Math.floor((endMs - startMs) / stepMs))

  const outages = planOutages(rng, totalSteps, incidents, targetUptime)
  const points: MockPoint[] = []

  let latency = baseLatencyMs

  for (let step = 0; step < totalSteps; step++) {
    const ts = new Date(startMs + step * stepMs)

    // Mean-reverting walk: without the pull term a long series drifts away and
    // stops resembling the service it is meant to imitate.
    const drift = (rng() - 0.5) * baseLatencyMs * noise
    const pull = (baseLatencyMs - latency) * 0.08
    latency = Math.max(1, latency + drift + pull)

    // Busier by day, quieter at night.
    const hour = ts.getUTCHours()
    const diurnal = 1 + 0.25 * Math.sin(((hour - 6) / 24) * Math.PI * 2)

    const outage = outages.find((o) => step >= o.start && step < o.end)
    let status: CheckStatusValue = 'operational'
    let message: string | null = null
    let effectiveLatency = latency * diurnal

    if (outage) {
      // Ramp the impact in and out so charts show a shape, not a rectangle.
      const progress = (step - outage.start) / Math.max(1, outage.end - outage.start)
      const intensity = Math.sin(progress * Math.PI)

      if (outage.severity === 'down') {
        status = 'down'
        message = 'Connection refused'
        effectiveLatency = 0
      } else if (outage.severity === 'partial') {
        status = intensity > 0.4 ? 'partial' : 'degraded'
        effectiveLatency = latency * (2 + intensity * 6)
        message = 'Elevated error rate'
      } else {
        status = 'degraded'
        effectiveLatency = latency * (1.5 + intensity * 2)
        message = 'Response time above threshold'
      }
    }

    points.push({
      ts,
      status,
      latencyMs: valueMode ? null : Math.round(effectiveLatency),
      value: valueMode
        ? round2(
            valueMode.base +
              Math.sin(step / 40) * valueMode.amplitude +
              (rng() - 0.5) * valueMode.amplitude * 0.4 +
              (outage ? valueMode.amplitude * 3 : 0),
          )
        : null,
      message,
    })
  }

  return points
}

function planOutages(
  rng: () => number,
  totalSteps: number,
  count: number,
  targetUptime: number,
): Outage[] {
  if (count <= 0 || totalSteps <= 0) return []

  // Spread the allowed downtime budget across the requested number of windows.
  const budget = Math.max(count, Math.floor(totalSteps * (1 - targetUptime)))
  const outages: Outage[] = []

  for (let i = 0; i < count; i++) {
    // One window per equal slice keeps them from clumping at one end.
    const sliceStart = Math.floor((totalSteps / count) * i)
    const sliceEnd = Math.floor((totalSteps / count) * (i + 1))
    const span = Math.max(1, sliceEnd - sliceStart)

    const duration = Math.max(2, Math.floor((budget / count) * (0.5 + rng())))
    const start = sliceStart + Math.floor(rng() * Math.max(1, span - duration))
    const roll = rng()
    const severity: Outage['severity'] = roll < 0.5 ? 'degraded' : roll < 0.8 ? 'partial' : 'down'

    outages.push({ start, end: Math.min(totalSteps, start + duration), severity })
  }

  return outages
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

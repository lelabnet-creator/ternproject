import { describe, expect, it } from 'vitest'
import { computeAvailability, DEFAULT_DEBOUNCE, type AvailabilitySample } from './availability.js'

/**
 * The availability rate.
 *
 * Every case here is a rule somebody could reasonably have implemented the
 * other way, which is why they are pinned rather than described: time-weighting
 * over check-counting, the debounce and where it dates an outage from, planned
 * work leaving the denominator, OR across agents, and what happens to time
 * nobody observed.
 *
 * Times are round numbers of minutes from a fixed origin. No `Date.now()` — a
 * test whose expectations move with the clock is one nobody trusts at 3 a.m.
 */

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0)
const MINUTE = 60_000
const at = (minutes: number) => T0 + minutes * MINUTE

/** A series one minute apart, from a string of letters. `o` up, `x` down. */
function series(pattern: string, agentId?: string): AvailabilitySample[] {
  return [...pattern].map((letter, index) => ({
    ts: at(index),
    agentId,
    status:
      letter === 'o'
        ? ('operational' as const)
        : letter === 'x'
          ? ('down' as const)
          : letter === 'd'
            ? ('degraded' as const)
            : letter === 'm'
              ? ('maintenance' as const)
              : ('unknown' as const),
  }))
}

const HOUR_WINDOW = { from: at(0), to: at(60) }

function run(pattern: string, overrides: Partial<Parameters<typeof computeAvailability>[0]> = {}) {
  return computeAvailability({
    window: HOUR_WINDOW,
    intervalMs: MINUTE,
    samples: series(pattern),
    ...overrides,
  })
}

describe('time-weighting rather than counting checks', () => {
  it('charges an outage the time it lasted, whatever the interval', () => {
    /*
     * The whole reason this module exists. Same service, same ten-minute
     * outage, two probing rates — the old `ok_samples / samples` gave two very
     * different percentages and this must give one.
     */
    const dense: AvailabilitySample[] = []
    for (let minute = 0; minute < 60; minute++) {
      // Six samples a minute, so a ten-minute outage is 60 failed points.
      for (let sixth = 0; sixth < 6; sixth++) {
        dense.push({
          ts: at(minute) + sixth * 10_000,
          status: minute >= 10 && minute < 20 ? 'down' : 'operational',
        })
      }
    }

    const sparse: AvailabilitySample[] = []
    for (let minute = 0; minute < 60; minute += 5) {
      sparse.push({ ts: at(minute), status: minute >= 10 && minute < 20 ? 'down' : 'operational' })
    }

    const fast = computeAvailability({
      window: HOUR_WINDOW,
      intervalMs: 10_000,
      samples: dense,
    })
    const slow = computeAvailability({
      window: HOUR_WINDOW,
      intervalMs: 5 * MINUTE,
      samples: sparse,
    })

    expect(fast.downMs).toBe(10 * MINUTE)
    expect(slow.downMs).toBe(10 * MINUTE)
    // Fifty available minutes out of sixty observed, both ways round.
    expect(fast.uptimePct).toBeCloseTo((100 * 50) / 60, 6)
    expect(slow.uptimePct).toBeCloseTo((100 * 50) / 60, 6)
  })

  it('counts degraded as available', () => {
    // A change from the aggregates, which count only `operational` as ok. The
    // ribbon says whether it worked; the latency band says how well.
    expect(run('d'.repeat(60)).uptimePct).toBe(100)
  })

  it('counts partial as unavailable, with down', () => {
    const half = computeAvailability({
      window: HOUR_WINDOW,
      intervalMs: MINUTE,
      samples: [...Array(60)].map((_, i) => ({
        ts: at(i),
        status: i < 30 ? ('partial' as const) : ('operational' as const),
      })),
    })
    expect(half.downMs).toBe(30 * MINUTE)
  })
})

describe('the debounce', () => {
  it('ignores a single failed check', () => {
    // Flapping. One failed check is as often a dropped packet as a dead
    // service, and the default of 2 exists to say so.
    const result = run('o'.repeat(30) + 'x' + 'o'.repeat(29))
    expect(result.downMs).toBe(0)
    expect(result.uptimePct).toBe(100)
  })

  it('counts an outage from the first failure, not from the confirmation', () => {
    /*
     * The rule that decides whether the figure is biased.
     *
     * Three consecutive failures at minutes 30, 31 and 32. The service was
     * already broken while the second check was being taken, so the outage is
     * three minutes and not two — dating it from the confirming check would
     * hide one interval of *every* real outage, always in the flattering
     * direction.
     */
    const result = run('o'.repeat(30) + 'xxx' + 'o'.repeat(27))
    expect(result.downMs).toBe(3 * MINUTE)
  })

  it('respects a debounce of one, which disables it', () => {
    const result = run('o'.repeat(30) + 'x' + 'o'.repeat(29), { debounce: 1 })
    expect(result.downMs).toBe(MINUTE)
  })

  it('defaults to two', () => {
    expect(DEFAULT_DEBOUNCE).toBe(2)
    const withDefault = run('o'.repeat(30) + 'xx' + 'o'.repeat(28))
    const spelledOut = run('o'.repeat(30) + 'xx' + 'o'.repeat(28), { debounce: 2 })
    expect(withDefault).toEqual(spelledOut)
    expect(withDefault.downMs).toBe(2 * MINUTE)
  })
})

describe('planned maintenance', () => {
  it('leaves the denominator rather than counting as up', () => {
    /*
     * Counting planned work as available would let a page reach 100% by
     * scheduling enough of it. Counting it as unavailable would punish
     * operators for announcing what they were about to do. It leaves.
     */
    const result = run('o'.repeat(20) + 'x'.repeat(20) + 'o'.repeat(20), {
      exclusions: [{ from: at(20), to: at(40) }],
    })

    expect(result.downMs).toBe(0)
    expect(result.excludedMs).toBe(20 * MINUTE)
    expect(result.observedMs).toBe(40 * MINUTE)
    expect(result.uptimePct).toBe(100)
  })

  it('excludes a maintenance status the same way as a declared window', () => {
    const result = run('o'.repeat(20) + 'm'.repeat(20) + 'o'.repeat(20))
    expect(result.excludedMs).toBe(20 * MINUTE)
    expect(result.observedMs).toBe(40 * MINUTE)
  })

  it('merges windows that overlap or touch', () => {
    const result = run('o'.repeat(60), {
      exclusions: [
        { from: at(10), to: at(20) },
        { from: at(15), to: at(25) },
        { from: at(25), to: at(30) },
      ],
    })
    expect(result.excludedMs).toBe(20 * MINUTE)
  })

  it('accounts for the whole window, whatever the mix', () => {
    // The invariant a reader is entitled to assume about these four numbers.
    const result = run('o'.repeat(20) + 'x'.repeat(10) + 'm'.repeat(10) + 'o'.repeat(20), {
      exclusions: [{ from: at(50), to: at(55) }],
    })
    expect(result.upMs + result.downMs + result.excludedMs + result.unknownMs).toBe(60 * MINUTE)
  })
})

describe('several agents on one control', () => {
  it('is down when any one of them says so', () => {
    /*
     * OR, not an average. If one vantage point cannot reach the service, the
     * service is unreachable from somewhere — which is what the reader wants to
     * know, and the reading that cannot be wrong in the dangerous direction.
     */
    const paris = series('o'.repeat(60), 'paris')
    const tokyo = series('o'.repeat(20) + 'x'.repeat(10) + 'o'.repeat(30), 'tokyo')

    const result = computeAvailability({
      window: HOUR_WINDOW,
      intervalMs: MINUTE,
      samples: [...paris, ...tokyo],
    })

    expect(result.downMs).toBe(10 * MINUTE)
    // Averaging would have given 100% — one healthy vantage point cancelling a
    // broken one is exactly the failure this rule forecloses.
    expect(result.uptimePct).toBeLessThan(100)
  })

  it('lets an agent that stops reporting stop having an opinion', () => {
    // Otherwise a decommissioned agent holds its last state for the width of
    // the window and outvotes the one still working.
    const stale = [{ ts: at(0), status: 'down' as const, agentId: 'gone' }]
    const live = series('o'.repeat(60), 'here')

    const result = computeAvailability({
      window: HOUR_WINDOW,
      intervalMs: MINUTE,
      samples: [...stale, ...live],
    })

    // Two minutes of it, then the stale agent falls silent: `maxGapMs` is twice
    // the interval, and the debounce needs two checks, so the run counts.
    expect(result.downMs).toBe(2 * MINUTE)
    expect(result.upMs).toBe(58 * MINUTE)
  })
})

describe('time nobody observed', () => {
  it('leaves the denominator rather than being guessed', () => {
    /*
     * Inventing uptime and inventing downtime are both worse than admitting the
     * agent was not reporting. Half an hour of samples, then silence.
     */
    const result = run('o'.repeat(30))

    // Samples at minutes 0..29; the last one speaks for one gap — two minutes —
    // and then the time is nobody's to claim.
    expect(result.observedMs).toBe(31 * MINUTE)
    expect(result.unknownMs).toBe(29 * MINUTE)
    expect(result.uptimePct).toBe(100)
  })

  it('reports nothing at all rather than zero when there are no samples', () => {
    // `null`, not `0`: a control nobody measured is not a control that was
    // down, and a ribbon that paints it red would be lying.
    const result = computeAvailability({ window: HOUR_WINDOW, intervalMs: MINUTE, samples: [] })
    expect(result.uptimePct).toBeNull()
    expect(result.unknownMs).toBe(60 * MINUTE)
  })

  it('carries the state from before the window into it', () => {
    /*
     * The window opens mid-series in every real query. Dropping the last sample
     * before it would make each window start with a stretch of unknown as long
     * as the interval — a rounding error for a daily figure, 8% of an hourly
     * one.
     */
    const result = computeAvailability({
      window: { from: at(30), to: at(60) },
      intervalMs: MINUTE,
      samples: series('o'.repeat(60)),
    })
    expect(result.unknownMs).toBe(0)
    expect(result.observedMs).toBe(30 * MINUTE)
  })

  it('does not let a stale sample speak for the whole window', () => {
    const result = computeAvailability({
      window: { from: at(30), to: at(60) },
      intervalMs: MINUTE,
      // One sample, long before the window opens.
      samples: [{ ts: at(0), status: 'operational' }],
    })
    expect(result.observedMs).toBe(0)
    expect(result.uptimePct).toBeNull()
  })
})

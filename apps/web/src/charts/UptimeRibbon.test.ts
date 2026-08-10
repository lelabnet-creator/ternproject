import { describe, expect, it } from 'vitest'
import { weightedUptime } from './UptimeRibbon'

/**
 * The headline percentage under the ribbon.
 *
 * Arithmetic, so it is tested as arithmetic. It was a plain mean of the daily
 * percentages, which undid at the last step the thing the daily figures had
 * just been fixed to do — and it would have gone on looking right, because a
 * mean of percentages looks like a percentage.
 */

describe('the figure under the ribbon', () => {
  it('weights each day by how much of it was measured', () => {
    /*
     * A fully observed day at 100% and a two-hour day at 0%. The unweighted
     * mean says 50%, which describes neither the window nor anything a reader
     * could act on: the service was up for twenty-four of twenty-six observed
     * hours.
     */
    const value = weightedUptime([
      { uptimePct: 100, samples: 1440 },
      { uptimePct: 0, samples: 120 },
    ])
    expect(value).toBeCloseTo((100 * 1440) / 1560, 6)
    expect(value).toBeGreaterThan(90)
  })

  it('ignores days with no data rather than reading them as zero', () => {
    // A day nobody measured is not a day that was down. Counting it as 0 is how
    // an agent outage becomes a service outage on the public page.
    const value = weightedUptime([
      { uptimePct: 100, samples: 1440 },
      { uptimePct: null, samples: 0 },
    ])
    expect(value).toBe(100)
  })

  it('says nothing when nothing was measured', () => {
    expect(weightedUptime([])).toBeNull()
    expect(weightedUptime([{ uptimePct: null, samples: 0 }])).toBeNull()
  })

  it('agrees with the plain mean when every day is equally covered', () => {
    // The property that makes the change safe: nothing moves for the ordinary
    // case, which is every day fully observed.
    const value = weightedUptime([
      { uptimePct: 100, samples: 1440 },
      { uptimePct: 98, samples: 1440 },
      { uptimePct: 99, samples: 1440 },
    ])
    expect(value).toBeCloseTo(99, 6)
  })
})

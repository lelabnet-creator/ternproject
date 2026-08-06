import { describe, expect, it } from 'vitest'
import { sizeDeployment } from './sizing.js'

const base = {
  agents: 10,
  probesPerAgent: 5,
  intervalS: 60,
  concurrentViewers: 20,
  retentionDays: 30,
}

describe('sizing a deployment', () => {
  it('counts requests per agent-run, not per point', () => {
    // An agent batches everything it measured in a tick into one request.
    // Sizing on points would over-provision by the probe count — here, fivefold.
    const sizing = sizeDeployment(base)
    expect(sizing.pointsPerMinute).toBe(50)
    expect(sizing.ingestRequestsPerMinute).toBe(10)
  })

  it('recommends headroom above the expected rate, never below a floor', () => {
    const sizing = sizeDeployment(base)
    expect(sizing.recommended.ingestRateLimitPerMinute).toBeGreaterThanOrEqual(
      sizing.ingestRequestsPerMinute,
    )

    // A tiny deployment must not end up with a limit so low that one retry
    // storm takes out the ingest path.
    const tiny = sizeDeployment({ ...base, agents: 1, probesPerAgent: 1, intervalS: 300 })
    expect(tiny.recommended.ingestRateLimitPerMinute).toBe(60)
  })

  it('scales with the fleet rather than sitting on a default', () => {
    const small = sizeDeployment(base)
    const large = sizeDeployment({ ...base, agents: 400 })

    expect(large.recommended.ingestRateLimitPerMinute).toBeGreaterThan(
      small.recommended.ingestRateLimitPerMinute * 10,
    )
    expect(large.recommended.dbPoolMax).toBeGreaterThan(small.recommended.dbPoolMax)
  })

  it('keeps the pool inside what one Postgres will tolerate', () => {
    // The failure this prevents: a recommendation that exhausts max_connections
    // and takes down every other client of the same database.
    const huge = sizeDeployment({
      ...base,
      agents: 100_000,
      probesPerAgent: 50,
      intervalS: 5,
      concurrentViewers: 100_000,
    })
    expect(huge.recommended.dbPoolMax).toBeLessThanOrEqual(50)
    expect(huge.notes.join(' ')).toMatch(/max_connections/)
  })

  it('warns about the interval that trips the limit first', () => {
    const fast = sizeDeployment({ ...base, intervalS: 10 })
    expect(fast.notes.join(' ')).toMatch(/ingest limit/)
  })

  it('estimates storage from retention, and says when it is large', () => {
    const modest = sizeDeployment(base)
    expect(modest.rawStorageMb).toBeGreaterThan(0)

    const heavy = sizeDeployment({
      ...base,
      agents: 500,
      probesPerAgent: 20,
      intervalS: 10,
      retentionDays: 365,
    })
    expect(heavy.notes.join(' ')).toMatch(/before compression/)
  })

  it('treats an impossible interval as the minimum rather than dividing by zero', () => {
    const sizing = sizeDeployment({ ...base, intervalS: 0 })
    expect(Number.isFinite(sizing.pointsPerMinute)).toBe(true)
  })
})

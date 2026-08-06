import { describe, expect, it } from 'vitest'
import { mergeRuns } from './StatusSwimlane'

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString()

describe('mergeRuns', () => {
  it('collapses a run of identical statuses into one band', () => {
    const bands = mergeRuns([
      { ts: at(0), status: 'operational' },
      { ts: at(15), status: 'operational' },
      { ts: at(30), status: 'operational' },
    ])
    expect(bands).toHaveLength(1)
  })

  it('keeps a short outage as its own band', () => {
    // The whole point of the chart. If a two-sample outage merges away, the
    // swimlane draws a solid green bar over an incident that happened.
    const bands = mergeRuns([
      { ts: at(0), status: 'operational' },
      { ts: at(15), status: 'operational' },
      { ts: at(30), status: 'down' },
      { ts: at(45), status: 'down' },
      { ts: at(60), status: 'operational' },
      { ts: at(75), status: 'operational' },
    ])

    expect(bands.map((b) => b.status)).toEqual(['operational', 'down', 'operational'])
    const outage = bands[1]!
    expect(outage.end.getTime()).toBeGreaterThan(outage.start.getTime())
  })

  it('leaves no gap between consecutive bands', () => {
    // A seam would read as missing data rather than as a change of state.
    const bands = mergeRuns([
      { ts: at(0), status: 'operational' },
      { ts: at(15), status: 'degraded' },
      { ts: at(30), status: 'operational' },
    ])
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i]!.start.getTime()).toBe(bands[i - 1]!.end.getTime())
    }
  })

  it('gives the final band a non-zero width', () => {
    // Otherwise the most recent state — the one people look at first — is drawn
    // as nothing.
    const bands = mergeRuns([
      { ts: at(0), status: 'operational' },
      { ts: at(15), status: 'operational' },
      { ts: at(30), status: 'down' },
    ])
    const last = bands[bands.length - 1]!
    expect(last.end.getTime()).toBeGreaterThan(last.start.getTime())
  })

  it('sorts unordered input before merging', () => {
    const bands = mergeRuns([
      { ts: at(30), status: 'down' },
      { ts: at(0), status: 'operational' },
      { ts: at(15), status: 'operational' },
    ])
    expect(bands[0]!.status).toBe('operational')
  })

  it('handles an empty series', () => {
    expect(mergeRuns([])).toEqual([])
  })
})

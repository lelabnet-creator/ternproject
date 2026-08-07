import { describe, expect, it } from 'vitest'
import { tourSteps } from './AdminApp'

/**
 * The tour is generated from the rail, not written beside it.
 *
 * That is the property worth pinning: a rail that grows an entry has to grow a
 * step, or the tour quietly stops covering the product. These assertions fail
 * the day someone adds a section and forgets the tour exists — which is the
 * whole reason the steps are derived rather than listed.
 */

describe('steps', () => {
  it('covers every rail entry an ordinary admin can see', () => {
    const steps = tourSteps(false)
    const targets = steps.map((s) => s.target)

    expect(targets).toContain('[data-tour="controls"]')
    expect(targets).toContain('[data-tour="logs"]')
    expect(targets).toContain('[data-tour="options"]')
    // Instance supervision is not theirs to be shown.
    expect(targets).not.toContain('[data-tour="platform"]')
  })

  it('adds the platform step for an admin of the system tenant', () => {
    const steps = tourSteps(true)
    expect(steps.map((s) => s.target)).toContain('[data-tour="platform"]')
    expect(steps.length).toBe(tourSteps(false).length + 1)
  })

  it('gives every step something to say', () => {
    // A step with an empty body is a step that wastes a click. The fallback in
    // TOUR_COPY exists so this holds even for a section nobody wrote copy for.
    for (const step of tourSteps(true)) {
      expect(step.title.length).toBeGreaterThan(0)
      expect(step.body.length).toBeGreaterThan(0)
    }
  })

  it('anchors each step to a selector, never to a screenshot', () => {
    for (const step of tourSteps(true)) {
      expect(step.target).toMatch(/^\[data-tour="[a-z-]+"\]$/)
    }
  })

  it('walks the rail in the order the rail is drawn', () => {
    // A tour that jumps around the navigation it is describing teaches the
    // navigation wrongly.
    const steps = tourSteps(true).map((s) => s.target)
    expect(steps[0]).toBe('[data-tour="controls"]')
    expect(steps[steps.length - 1]).toBe('[data-tour="platform"]')
  })
})

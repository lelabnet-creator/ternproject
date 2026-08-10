import { describe, expect, it } from 'vitest'
import { starterStylesheet } from './custom-style.js'

/**
 * The stylesheet a `custom` page starts from.
 *
 * What is worth pinning is not the design — that is meant to be edited the
 * minute it appears — but the two things an operator would not know to put back
 * if they were lost: the selector contract, and the fact that there is anything
 * in the box at all. An empty starter is the state this exists to end.
 */

describe('the starting stylesheet', () => {
  const css = starterStylesheet('Acme Corp')

  it('is not an empty box', () => {
    expect(css.trim()).not.toBe('')
  })

  it('names every hook the page promises', () => {
    // The `data-tern` attributes are the one thing nobody can guess, and the
    // one thing that stays put when the markup inside a block is refactored.
    // A missing name here is a part of the page nobody knows how to style.
    for (const hook of [
      'page',
      'header',
      'pulse',
      'subscribe',
      'incidents',
      'components',
      'arrangement',
    ]) {
      expect(css).toContain(`data-tern="${hook}"`)
    }
  })

  it('is addressed to this page, not to somebody else’s company', () => {
    expect(css).toContain('Acme Corp')
    expect(starterStylesheet('Crisislab')).toContain('Crisislab')
    // A page with no name still gets a first line rather than a dangling dash.
    expect(starterStylesheet()).toMatch(/^\/\* \S/)
  })

  it('restyles through the page’s own variables rather than over its rules', () => {
    // The difference between a four-line palette change and a rewrite: setting
    // `--color-accent` moves every card, border and label at once.
    expect(css).toContain('--color-accent')
  })

  it('never trades a word for a colour', () => {
    // Status is a word first, everywhere in this product. An example that hid a
    // label to leave a hue behind is where that rule would start eroding.
    expect(css).not.toMatch(/display:\s*none/)
  })
})

import { describe, expect, it } from 'vitest'
import { blocksSchema, clampBlock, GRID_COLUMNS, nextFreeRow } from './blocks.js'

/**
 * The grid model.
 *
 * These are the invariants that make a drag editor defensible where the backlog
 * turned one down: the position is whole numbers, so the keyboard can express
 * every move the pointer can, and nothing can be placed outside the page.
 */

const at = (x: number, y: number, w = 2, h = 2) => ({ x, y, w, h })

describe('staying on the page', () => {
  it('pulls a block back inside rather than refusing the move', () => {
    // An arrow key held down at the edge should stop, not throw the block away.
    expect(clampBlock(at(-3, -2))).toMatchObject({ x: 0, y: 0 })
  })

  it('never lets a block hang off the right edge', () => {
    const wide = clampBlock(at(11, 0, 6))
    expect(wide.x + wide.w).toBeLessThanOrEqual(GRID_COLUMNS)
  })

  it('caps a width at the grid rather than shrinking the column count', () => {
    expect(clampBlock(at(0, 0, 99)).w).toBe(GRID_COLUMNS)
  })

  it('keeps every block at least one cell', () => {
    expect(clampBlock(at(0, 0, 0, 0))).toMatchObject({ w: 1, h: 1 })
  })
})

describe('placing something new', () => {
  it('drops it below everything already there', () => {
    const blocks = [
      { type: 'text' as const, id: 'a', body: 'x', style: 'body' as const, ...at(0, 0, 2, 3) },
      { type: 'text' as const, id: 'b', body: 'y', style: 'body' as const, ...at(4, 2, 2, 2) },
    ]
    // Below the lowest edge, not below the highest origin — a tall block at the
    // top otherwise gets a new one dropped on top of it.
    expect(nextFreeRow(blocks)).toBe(4)
  })

  it('starts at the top of an empty page', () => {
    expect(nextFreeRow([])).toBe(0)
  })
})

describe('what the server will accept', () => {
  it('takes a well-formed arrangement', () => {
    const parsed = blocksSchema.safeParse([
      { type: 'control', id: 'a', controlId: 'c1', x: 0, y: 0, w: 4, h: 3 },
      { type: 'text', id: 'b', body: 'Hello', style: 'heading', x: 4, y: 0, w: 8, h: 1 },
      {
        type: 'image',
        id: 'c',
        url: 'https://example.com/l.svg',
        alt: 'Logo',
        x: 0,
        y: 3,
        w: 3,
        h: 2,
      },
    ])
    expect(parsed.success).toBe(true)
  })

  it('refuses a position off the grid', () => {
    expect(
      blocksSchema.safeParse([
        { type: 'control', id: 'a', controlId: 'c', x: 99, y: 0, w: 1, h: 1 },
      ]).success,
    ).toBe(false)
  })

  it('refuses an image with no URL', () => {
    // Coordinates the server renders from, so a bad one is a broken page —
    // unlike the document beside it, which is validated by its sandbox.
    expect(
      blocksSchema.safeParse([
        { type: 'image', id: 'a', url: 'not a url', alt: '', x: 0, y: 0, w: 1, h: 1 },
      ]).success,
    ).toBe(false)
  })

  it('requires an alt text field on every image', () => {
    expect(
      blocksSchema.safeParse([
        { type: 'image', id: 'a', url: 'https://example.com/x.png', x: 0, y: 0, w: 1, h: 1 },
      ]).success,
    ).toBe(false)
  })
})

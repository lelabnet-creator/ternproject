import { describe, expect, it } from 'vitest'
import {
  blocksSchema,
  clampBlock,
  GRID_COLUMNS,
  hasIncidentsBlock,
  nextFreeRow,
  type Block,
} from './blocks.js'

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

  it('takes an incidents block, which is a position and nothing else', () => {
    const parsed = blocksSchema.safeParse([{ type: 'incidents', id: 'a', x: 0, y: 0, w: 12, h: 2 }])
    expect(parsed.success).toBe(true)
  })

  it('holds the incidents block to the grid like any other', () => {
    expect(
      blocksSchema.safeParse([{ type: 'incidents', id: 'a', x: 0, y: 0, w: 99, h: 2 }]).success,
    ).toBe(false)
  })

  it('drops anything that would configure the incidents block', () => {
    // The load-bearing assertion of the whole feature. The block says *where*
    // the incidents go and never *whether*: a severity floor, a "hide when
    // resolved" or a count cap smuggled through here is how a status page ends
    // up able to suppress its own bad news.
    const parsed = blocksSchema.safeParse([
      { type: 'incidents', id: 'a', x: 0, y: 0, w: 12, h: 2, minSeverity: 'critical', hide: true },
    ])
    expect(parsed.success).toBe(true)
    expect(parsed.data?.[0]).not.toHaveProperty('minSeverity')
    expect(parsed.data?.[0]).not.toHaveProperty('hide')
  })
})

describe('whether the arrangement takes the incidents', () => {
  const incidents: Block = { type: 'incidents', id: 'i', x: 0, y: 0, w: 12, h: 2 }
  const text: Block = { type: 'text', id: 't', body: 'x', style: 'body', x: 0, y: 2, w: 6, h: 1 }

  it('says no for an arrangement that never mentions them', () => {
    // Which is every page arranged before the block existed. They keep being
    // drawn above the arrangement; nothing had to be migrated.
    expect(hasIncidentsBlock([text])).toBe(false)
  })

  it('says no for an empty arrangement', () => {
    expect(hasIncidentsBlock([])).toBe(false)
  })

  it('says yes as soon as one is placed', () => {
    expect(hasIncidentsBlock([text, incidents])).toBe(true)
  })
})

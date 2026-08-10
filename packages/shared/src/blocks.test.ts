import { describe, expect, it } from 'vitest'
import {
  blocksSchema,
  clampBlock,
  defaultBlocks,
  GRID_COLUMNS,
  hasComponentsBlock,
  hasIncidentsBlock,
  nextFreeRow,
  parseBlocks,
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

describe('the page as blocks', () => {
  it('takes every part the default layouts draw', () => {
    const parsed = blocksSchema.safeParse([
      { type: 'header', id: 'a', x: 0, y: 0, w: 12, h: 1 },
      { type: 'pulse', id: 'b', x: 0, y: 1, w: 12, h: 4 },
      { type: 'subscribe', id: 'c', x: 0, y: 5, w: 12, h: 1 },
      { type: 'components', id: 'd', x: 0, y: 6, w: 12, h: 6 },
    ])
    expect(parsed.success).toBe(true)
  })

  it('defaults the pulse to showing when it was updated, and the components to a list', () => {
    const parsed = blocksSchema.safeParse([
      { type: 'pulse', id: 'b', x: 0, y: 0, w: 12, h: 4 },
      { type: 'components', id: 'd', x: 0, y: 4, w: 12, h: 6 },
    ])
    expect(parsed.data?.[0]).toMatchObject({ showUpdatedAt: true })
    expect(parsed.data?.[1]).toMatchObject({ density: 'list' })
  })

  it('gives the header a position and nothing to configure', () => {
    // The logo and the name come from the branding settings. An option here
    // would be a second place to set the same thing, and the two would disagree.
    const parsed = blocksSchema.safeParse([
      { type: 'header', id: 'a', x: 0, y: 0, w: 12, h: 1, logoUrl: 'https://evil.example/x.png' },
    ])
    expect(parsed.success).toBe(true)
    expect(parsed.data?.[0]).not.toHaveProperty('logoUrl')
  })

  it('offers the default page, and the server would accept it', () => {
    expect(blocksSchema.safeParse(defaultBlocks()).success).toBe(true)
  })

  it('starts everybody on a page that shows a status', () => {
    // The point of seeding: the mode opens on the page the operator already
    // had, so neither guarantee has to rescue the first save.
    expect(hasIncidentsBlock(defaultBlocks())).toBe(true)
    expect(hasComponentsBlock(defaultBlocks())).toBe(true)
  })
})

describe('whether the arrangement shows any component', () => {
  const text: Block = { type: 'text', id: 't', body: 'x', style: 'body', x: 0, y: 0, w: 6, h: 1 }

  it('says no for an arrangement of nothing but decoration', () => {
    expect(hasComponentsBlock([text])).toBe(false)
  })

  it('says no for an empty arrangement', () => {
    expect(hasComponentsBlock([])).toBe(false)
  })

  it('counts the block that draws them all', () => {
    const all: Block = { type: 'components', id: 'c', density: 'grid', x: 0, y: 1, w: 12, h: 6 }
    expect(hasComponentsBlock([text, all])).toBe(true)
  })

  it('counts a single hand-placed component', () => {
    // Somebody who placed three components chose those three. Appending the
    // full list under them would override a decision rather than protect one.
    const one: Block = { type: 'control', id: 'c', controlId: 'x', x: 0, y: 1, w: 4, h: 3 }
    expect(hasComponentsBlock([one])).toBe(true)
  })
})

describe('reading an arrangement back', () => {
  it('drops a block it cannot read and draws the rest', () => {
    // All-or-nothing parsing sent the whole page to `[]` because one block came
    // from a newer version. Survivable when custom was one panel; now it is the
    // page.
    const blocks = parseBlocks([
      { type: 'header', id: 'a', x: 0, y: 0, w: 12, h: 1 },
      { type: 'sparkline-from-2027', id: 'b', x: 0, y: 1, w: 6, h: 2 },
      { type: 'components', id: 'c', x: 0, y: 3, w: 12, h: 6 },
    ])
    expect(blocks.map((block) => block.id)).toEqual(['a', 'c'])
  })

  it('drops a block placed off the grid rather than the page around it', () => {
    const blocks = parseBlocks([
      { type: 'incidents', id: 'a', x: 99, y: 0, w: 12, h: 2 },
      { type: 'incidents', id: 'b', x: 0, y: 0, w: 12, h: 2 },
    ])
    expect(blocks.map((block) => block.id)).toEqual(['b'])
  })

  it('reads nothing out of anything that is not an arrangement', () => {
    expect(parseBlocks(null)).toEqual([])
    expect(parseBlocks({ blocks: [] })).toEqual([])
    expect(parseBlocks('[]')).toEqual([])
  })

  it('stops at the same length the server stores', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      type: 'text',
      id: `t${i}`,
      body: 'x',
      style: 'body',
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    }))
    expect(parseBlocks(many)).toHaveLength(200)
  })
})

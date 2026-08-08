import { z } from 'zod'

/**
 * The custom page, as blocks on a grid.
 *
 * Structured rather than the HTML the `custom` layout also accepts, and that is
 * the whole point: a visual builder that emitted HTML would lose every hand
 * edit the next time somebody dragged something, and one that parsed HTML back
 * into shapes would be a second, worse parser. Two modes, each honest about
 * what it owns — this one for arranging, the document for writing.
 *
 * The grid is what makes free placement reachable from a keyboard. The backlog
 * turned a drag editor down partly because "dragging in two dimensions has no
 * obvious arrow-key analogue"; on a grid it has exactly one, a cell at a time,
 * which is why the coordinates here are integers and not pixels.
 */

/** Columns the canvas is divided into. Twelve divides by 2, 3, 4 and 6. */
export const GRID_COLUMNS = 12

export const blockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('control'),
    id: z.string(),
    /** Which component this draws. Its widget comes from the control itself. */
    controlId: z.string(),
    x: z
      .number()
      .int()
      .min(0)
      .max(GRID_COLUMNS - 1),
    y: z.number().int().min(0).max(200),
    w: z.number().int().min(1).max(GRID_COLUMNS),
    h: z.number().int().min(1).max(20),
  }),
  z.object({
    type: z.literal('text'),
    id: z.string(),
    /** Plain text, rendered as text. Never parsed as markup — see the note above. */
    body: z.string().max(2_000),
    /** `heading` is larger and bolder; nothing here chooses a font. */
    style: z.enum(['heading', 'body']).default('body'),
    x: z
      .number()
      .int()
      .min(0)
      .max(GRID_COLUMNS - 1),
    y: z.number().int().min(0).max(200),
    w: z.number().int().min(1).max(GRID_COLUMNS),
    h: z.number().int().min(1).max(20),
  }),
  z.object({
    type: z.literal('image'),
    id: z.string(),
    url: z.string().url().max(2_000),
    /**
     * Required, and not defaulted to the empty string.
     *
     * An image placed on a status page is usually a logo or a diagram carrying
     * meaning. The field is asked for at the point of adding one, because an
     * alt text collected later is an alt text nobody writes.
     */
    alt: z.string().max(300),
    x: z
      .number()
      .int()
      .min(0)
      .max(GRID_COLUMNS - 1),
    y: z.number().int().min(0).max(200),
    w: z.number().int().min(1).max(GRID_COLUMNS),
    h: z.number().int().min(1).max(20),
  }),
])

export type Block = z.infer<typeof blockSchema>
export type BlockType = Block['type']

/** Bounded: a page is arranged, not assembled from a thousand parts. */
export const blocksSchema = z.array(blockSchema).max(200)

/** Where a new block lands: the first row with nothing on it. */
export function nextFreeRow(blocks: Block[]): number {
  return blocks.reduce((lowest, block) => Math.max(lowest, block.y + block.h), 0)
}

/**
 * Keeps a block inside the grid after a move or a resize.
 *
 * Clamped rather than refused: an arrow key held down at the edge should stop,
 * not throw the block away, and a width dragged past the last column should
 * become the widest that fits.
 */
export function clampBlock<T extends { x: number; y: number; w: number; h: number }>(block: T): T {
  const w = Math.min(Math.max(1, block.w), GRID_COLUMNS)
  const x = Math.min(Math.max(0, block.x), GRID_COLUMNS - w)
  return { ...block, x, w, y: Math.max(0, block.y), h: Math.max(1, block.h) }
}

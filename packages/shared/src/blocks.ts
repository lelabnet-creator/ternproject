import { z } from 'zod'

/**
 * The custom page, as blocks on a grid.
 *
 * `custom` is not a hole cut in TERN's page for the tenant to fill — it is the
 * page. Everything the default layouts draw in a fixed order (the header, the
 * pulse, the subscribe box, the components) is a block here, so an operator who
 * chooses the mode arranges the whole thing rather than a panel in the middle
 * of somebody else's design. What TERN keeps for itself is the utility strip
 * and its own credit, neither of which reports anything about the service.
 *
 * The other half of `custom` is a stylesheet, applied to this same page. The
 * two do not overlap: blocks say *what* is on the page and *where*, CSS says
 * what it looks like.
 *
 * The grid is what makes free placement reachable from a keyboard. The backlog
 * turned a drag editor down partly because "dragging in two dimensions has no
 * obvious arrow-key analogue"; on a grid it has exactly one, a cell at a time,
 * which is why the coordinates here are integers and not pixels.
 */

/** Columns the canvas is divided into. Twelve divides by 2, 3, 4 and 6. */
export const GRID_COLUMNS = 12

/**
 * Where a block sits, which is the one thing every block has.
 *
 * Spelled once and spread into each variant. It was repeated verbatim four
 * times before the page's own parts became blocks; at eight it would be the
 * kind of duplication that eventually disagrees with itself in one branch.
 */
const placement = {
  x: z
    .number()
    .int()
    .min(0)
    .max(GRID_COLUMNS - 1),
  y: z.number().int().min(0).max(200),
  w: z.number().int().min(1).max(GRID_COLUMNS),
  h: z.number().int().min(1).max(20),
}

export const blockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('control'),
    id: z.string(),
    /** Which component this draws. Its widget comes from the control itself. */
    controlId: z.string(),
    ...placement,
  }),
  z.object({
    type: z.literal('text'),
    id: z.string(),
    /** Plain text, rendered as text. Never parsed as markup — see the note above. */
    body: z.string().max(2_000),
    /** `heading` is larger and bolder; nothing here chooses a font. */
    style: z.enum(['heading', 'body']).default('body'),
    ...placement,
  }),
  z.object({
    type: z.literal('incidents'),
    id: z.string(),
    /*
     * Deliberately nothing but a position.
     *
     * Every other block says *what* to draw; this one only says *where*. There
     * is no severity filter, no "hide when resolved", no count cap — because a
     * status page whose incidents could be configured into silence would not be
     * one, and an option here is exactly how that would arrive. The page
     * decides what it has to say; the arrangement decides where it lands.
     */
    ...placement,
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
    ...placement,
  }),
  z.object({
    /**
     * The page's own header: the tenant's logo or the TERN wordmark, and the
     * page name beside it.
     *
     * A position and nothing else, for the same reason the incidents block is:
     * what it draws comes from the branding settings, which is where somebody
     * looking for their logo goes. An option here would be a second place to
     * set the same thing.
     */
    type: z.literal('header'),
    id: z.string(),
    ...placement,
  }),
  z.object({
    type: z.literal('pulse'),
    id: z.string(),
    /**
     * The "Updated at" line under the ring.
     *
     * Optional because it is a timestamp rather than a status, and a page built
     * for a wall display has a clock on the wall. The ring itself is not
     * optional: it is the answer to the question the page exists for.
     */
    showUpdatedAt: z.boolean().default(true),
    ...placement,
  }),
  z.object({
    /** The subscribe disclosure. Its channels come from the tenant's settings. */
    type: z.literal('subscribe'),
    id: z.string(),
    ...placement,
  }),
  z.object({
    /**
     * Every component, grouped, in the order the Order tab gives them.
     *
     * The block that keeps the mode usable: a page with forty controls should
     * not need forty `control` blocks placed by hand to say "and then the
     * components". Its density is the choice the three other layouts are.
     */
    type: z.literal('components'),
    id: z.string(),
    density: z.enum(['list', 'grid', 'compact']).default('list'),
    ...placement,
  }),
])

export type Block = z.infer<typeof blockSchema>
export type BlockType = Block['type']

/** Bounded: a page is arranged, not assembled from a thousand parts. */
export const blocksSchema = z.array(blockSchema).max(200)

/**
 * Whether an arrangement takes the incidents on itself.
 *
 * The one question the page asks before it decides where to put them: an
 * arrangement that names no `incidents` block gets them above it anyway. Lives
 * here rather than in the renderer because it is a fact about the blocks, and
 * because the builder wants the same answer to tell an operator which state
 * they are in.
 */
export function hasIncidentsBlock(blocks: Block[]): boolean {
  return blocks.some((block) => block.type === 'incidents')
}

/**
 * Whether an arrangement shows any component at all.
 *
 * The second half of the same guarantee, and it exists because `custom` now
 * owns the whole page rather than one panel of it. Before, an arrangement that
 * placed nothing still had TERN's components underneath; now the arrangement is
 * everything, so an empty one would publish a status page that reports no
 * status. It is not removable for the same reason the incidents are not.
 *
 * A single `control` counts. Somebody who placed three components deliberately
 * chose those three, and appending the full list under them would override a
 * decision rather than protect one — the guarantee is against a page saying
 * *nothing*, not against a page being selective.
 */
export function hasComponentsBlock(blocks: Block[]): boolean {
  return blocks.some((block) => block.type === 'components' || block.type === 'control')
}

/**
 * The default page, expressed as blocks.
 *
 * What the Design tab opens on. Custom used to start from an empty canvas and a
 * blank document, which asked an operator to rebuild from nothing the page they
 * already had — and made the mode look like it concerned some sub-part of the
 * page rather than the page. Starting from the real arrangement says the true
 * thing in one screen: this is your page, now movable.
 *
 * The block counterpart of `starterDocument`, and seeded the same way — once,
 * into a draft, saved only when the operator saves.
 */
export function defaultBlocks(): Block[] {
  return [
    { type: 'header', id: 'header', x: 0, y: 0, w: 12, h: 1 },
    { type: 'pulse', id: 'pulse', showUpdatedAt: true, x: 0, y: 1, w: 12, h: 4 },
    { type: 'subscribe', id: 'subscribe', x: 0, y: 5, w: 12, h: 1 },
    { type: 'incidents', id: 'incidents', x: 0, y: 6, w: 12, h: 2 },
    { type: 'components', id: 'components', density: 'list', x: 0, y: 8, w: 12, h: 6 },
  ]
}

/**
 * An arrangement read from storage, block by block.
 *
 * Deliberately not `blocksSchema.safeParse` on the whole array, which is
 * all-or-nothing: one block written by a newer version — a type this build has
 * never heard of — took the entire page down to `[]`. That was survivable when
 * `custom` was one panel; now it is the difference between a page missing a
 * heading and a page missing itself.
 *
 * So an unreadable block is dropped and the rest is drawn. The guarantees below
 * still hold on what survives: lose the incidents block and the incidents come
 * back above the arrangement, lose the components block and they come back
 * under it. Writes stay strict — `blocksSchema` is what the API validates
 * against, so nothing malformed is stored in the first place.
 */
export function parseBlocks(value: unknown): Block[] {
  if (!Array.isArray(value)) return []
  const blocks: Block[] = []
  for (const candidate of value.slice(0, 200)) {
    const parsed = blockSchema.safeParse(candidate)
    if (parsed.success) blocks.push(parsed.data)
  }
  return blocks
}

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

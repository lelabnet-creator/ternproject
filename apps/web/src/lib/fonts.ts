/**
 * The typefaces a tenant may choose.
 *
 * Two, both rounded and both variable, and the choice between them is narrower
 * than the accent's: it is not "any font", it is "which of the faces this
 * instance already ships". Every family here has its `@font-face` rules in
 * ../styles/fonts.css and its woff2 subsets in ../assets/fonts, served from
 * this origin. A free-text field naming a Google family was the obvious
 * alternative and is the wrong one twice over — it would put the page's
 * typography back on a third-party host during an incident, and it would let a
 * tenant admin write arbitrary text into a CSS property.
 *
 * They are close relatives rather than opposites, which is deliberate. This is
 * the typeface of a page people read to find out whether something is broken;
 * the range worth offering runs from "rounded and open" to "rounded and
 * ordinary", not to a slab or a display face.
 */

export interface Font {
  id: string
  label: string
  /** What the face actually looks like, for a picker that shows it set in itself. */
  description: string
  /**
   * The whole `--font-sans` value, fallbacks included, rather than the family
   * name alone. The stack is part of the choice: `font-display: swap` means
   * these fallbacks are what a reader sees for the first few hundred
   * milliseconds of every cold load, and that is not a detail to leave to
   * whoever writes the next caller.
   */
  stack: string
}

export const FONTS: Font[] = [
  {
    id: 'comfortaa',
    label: 'Comfortaa',
    description: 'Rounded and wide, with tall open letters',
    stack: "'Comfortaa', system-ui, -apple-system, sans-serif",
  },
  {
    id: 'nunito',
    label: 'Nunito',
    description: 'Rounded too, but narrower and plainer',
    stack: "'Nunito', system-ui, -apple-system, sans-serif",
  },
]

/**
 * Named rather than positional, for the reason `DEFAULT_ACCENT` is: reordering
 * this list must not silently change the typeface of every tenant that never
 * picked one. Comfortaa because it is what the interface was set in before this
 * setting existed, and a tenant who has not chosen should see no change.
 */
export const DEFAULT_FONT = FONTS.find((f) => f.id === 'comfortaa') ?? FONTS[0]!

/**
 * Falls back rather than failing.
 *
 * A stored id may name a family this instance no longer ships — a downgrade, or
 * a font dropped from the list. Rendering the default is the right answer:
 * every face here is legible, no data depends on which one is used, and a page
 * that refuses to draw because it does not recognise a font name is worse than
 * a page drawn in the wrong one.
 *
 * It is also the guard that matters. Everything reaching `applyFont` comes
 * through here, so the only strings that ever reach a CSS property are the
 * `stack` values written above.
 */
export function fontById(id: string | null | undefined): Font {
  return FONTS.find((font) => font.id === id) ?? DEFAULT_FONT
}

/**
 * Writes the chosen typeface onto the document.
 *
 * One variable rather than two, which is where this differs from `applyAccent`:
 * a typeface does not change with the theme, so there is no second value to
 * lose when someone switches to dark.
 */
export function applyFont(font: Font): void {
  document.documentElement.style.setProperty('--font-sans', font.stack)
}

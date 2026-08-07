/**
 * The accents a tenant may choose.
 *
 * Four, and visibly four different things: a warm pink, a yellow, a blue and
 * the brand's own near-black. This is decoration — which colour the primary
 * buttons, the selected row and the focus ring take — and nothing here means
 * anything about a service.
 *
 * A note rather than a guard, because it is worth knowing once: `rose`, `amber`
 * and `ocean` sit near the `down`, `degraded` and `maintenance` status colours
 * respectively. The picker used to measure that and label each swatch with the
 * distance. It no longer does: an accent is a matter of taste, the statuses
 * always carry their own word beside the colour, and a settings screen that
 * argues with you about a colour choice is a settings screen nobody enjoys.
 */

export interface Accent {
  id: string
  label: string
  /** What the colour actually is, for a picker that shows a word beside a dot. */
  description: string
  /** Fill: buttons, selected chips. Read against its own background. */
  light: string
  /** The same colour as text or an edge, which must clear 4.5:1 on a card. */
  lightInk: string
  /** Tinted surface for a selected row. */
  lightSoft: string
  dark: string
  darkInk: string
  darkSoft: string
  darkFg: string
  lightFg: string
}

export const ACCENTS: Accent[] = [
  {
    id: 'rose',
    description: 'A warm pink',
    label: 'Rose',
    light: '#d23a60',
    // A different colour from the fill, because #d23a60 as text on white is
    // 3.6:1 — fine for a button's background, short of the floor for a word.
    lightInk: '#c2274f',
    lightSoft: '#fde7ec',
    lightFg: '#ffffff',
    dark: '#e4486b',
    darkInk: '#f7a8bd',
    darkSoft: '#45182a',
    darkFg: '#2b0711',
  },
  {
    id: 'amber',
    description: 'A soft yellow',
    label: 'Amber',
    light: '#f9d276',
    // Same reason, further: #f9d276 as text on white is 1.6:1 and unreadable,
    // and the fill is light enough that its foreground is dark rather than
    // white — the only one of the four that way round.
    lightInk: '#8a6d1f',
    lightSoft: '#fdf3dc',
    lightFg: '#17384b',
    dark: '#f9d276',
    darkInk: '#fbdf9e',
    darkSoft: '#42381c',
    darkFg: '#17384b',
  },
  {
    id: 'ocean',
    description: 'A muted blue',
    label: 'Ocean',
    light: '#2a7ba0',
    lightInk: '#1f6a8c',
    lightSoft: '#e2f0f7',
    lightFg: '#ffffff',
    dark: '#3288b0',
    darkInk: '#8ec9e4',
    darkSoft: '#14313f',
    darkFg: '#05161f',
  },
  {
    id: 'ink',
    description: 'Near-black; no colour at all',
    label: 'Ink',
    // The marque's own navy, and the option for anyone who wants no colour at
    // all. The highest contrast of the four, at 14.8:1.
    light: '#0d2a3f',
    lightInk: '#0d2a3f',
    lightSoft: '#dfe7ee',
    lightFg: '#ffffff',
    dark: '#e2e8f0',
    darkInk: '#e2e8f0',
    darkSoft: '#24455e',
    darkFg: '#0d2a3f',
  },
]

/**
 * The chip colours for a control's specs.
 *
 * A chosen palette rather than a single tint, and the trade is deliberate:
 * measured against the status colours, only the mint clears the ΔE 15 floor
 * (19.3). The rose sits 10.0 from `partial` orange, the amber 9.3 from
 * `degraded`, the blue 9.7 from `maintenance`, the deep navy 12.4 from
 * `unknown`.
 *
 * What makes that acceptable *here* and nowhere else: these appear on the
 * Controls list, which shows no statuses at all, in a footer strip, at 22px,
 * with the word always beside the icon. They are labels for "which chart" and
 * "how it is fed" — never for a service's state. Do not reuse this palette on a
 * surface where a status is also drawn.
 *
 * Each chip carries its own foreground, measured: navy on amber 8.5:1, navy on
 * mint 6.5:1, white on rose 3.9:1 and on blue 4.0:1 — above the 3:1 floor for a
 * graphic, which is what these are.
 */
export interface ChipColour {
  fill: string
  fg: string
}

export const CHIPS: Record<string, ChipColour> = {
  rose: { fill: '#e4486b', fg: '#ffffff' },
  amber: { fill: '#f9d276', fg: '#17384b' },
  mint: { fill: '#4ed2a6', fg: '#17384b' },
  blue: { fill: '#3288b0', fg: '#ffffff' },
  deep: { fill: '#17384b', fg: '#ffffff' },
}

/**
 * Named rather than positional.
 *
 * It was `ACCENTS[1]`, which meant reordering the list silently changed every
 * tenant that had never chosen one. Ink is the default because it is the
 * marque's own and the one that commits to nothing.
 */
export const DEFAULT_ACCENT = ACCENTS.find((a) => a.id === 'ink') ?? ACCENTS[0]!

/**
 * Falls back rather than failing.
 *
 * A tenant may hold an id this list no longer has — `violet`, `purple`, `mint`
 * and `magenta` were all offered once. They get the default, which is a visible
 * change to their admin but breaks nothing: the accent decorates, and no data
 * depends on it.
 */
export function accentById(id: string | null | undefined): Accent {
  return ACCENTS.find((accent) => accent.id === id) ?? DEFAULT_ACCENT
}

/**
 * Writes the chosen accent onto the document.
 *
 * Both themes at once, as separate variables, because the theme can change
 * without the accent changing — a picker that only set "the current one" would
 * lose the other half the moment someone switched to dark.
 */
export function applyAccent(accent: Accent): void {
  const root = document.documentElement
  root.style.setProperty('--accent-light', accent.light)
  root.style.setProperty('--accent-light-ink', accent.lightInk)
  root.style.setProperty('--accent-light-soft', accent.lightSoft)
  root.style.setProperty('--accent-light-fg', accent.lightFg)
  root.style.setProperty('--accent-dark', accent.dark)
  root.style.setProperty('--accent-dark-ink', accent.darkInk)
  root.style.setProperty('--accent-dark-soft', accent.darkSoft)
  root.style.setProperty('--accent-dark-fg', accent.darkFg)
}

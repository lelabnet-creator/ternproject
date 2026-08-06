/**
 * The accents a tenant may choose.
 *
 * Short list, and the reason is arithmetic rather than taste. The status palette
 * already occupies green, amber, orange, crimson, blue and grey, and an accent
 * that lands near any of them starts being read as a state — a primary button
 * that looks "operational" is the defect this whole file exists to prevent.
 *
 * Every candidate was measured against all six statuses in both themes. Teal
 * failed against operational (ΔE 8.6) and maintenance (4.8); steel blue failed
 * at 3.2; amber at 10.6; pink at 9.9; indigo at 14.1. What survives is the
 * purple-to-magenta arc, plus the brand's own ink — which passes at 17.3 and is
 * the option for anyone who wants no colour at all.
 *
 * The number beside each is its worst pair, so a future change can be checked
 * rather than argued about.
 */

export interface Accent {
  id: string
  label: string
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
  /** Worst normal-vision ΔE against any status colour. */
  separation: number
  /** Which status it is nearest, named when the separation is below the floor. */
  nearest?: string
}

/** Below this, two colours are hard to tell apart even with full colour vision. */
export const SEPARATION_FLOOR = 15

export const ACCENTS: Accent[] = [
  {
    id: 'ink',
    label: 'Ink',
    // The marque's own navy. No hue to clash with anything, and the highest
    // contrast of the set at 14.8:1.
    light: '#0d2a3f',
    lightInk: '#0d2a3f',
    lightSoft: '#dfe7ee',
    lightFg: '#ffffff',
    dark: '#e2e8f0',
    darkInk: '#e2e8f0',
    darkSoft: '#24455e',
    darkFg: '#0d2a3f',
    separation: 17.3,
  },
  {
    id: 'violet',
    label: 'Violet',
    light: '#7c3aed',
    lightInk: '#7c3aed',
    lightSoft: '#f1eafe',
    lightFg: '#ffffff',
    dark: '#8b5cf6',
    darkInk: '#b8a3ff',
    darkSoft: '#2a2050',
    darkFg: '#1a0b2e',
    separation: 19.8,
  },
  {
    id: 'purple',
    label: 'Purple',
    light: '#9333ea',
    lightInk: '#9333ea',
    lightSoft: '#f5e9fe',
    lightFg: '#ffffff',
    dark: '#a855f7',
    darkInk: '#d8b4fe',
    darkSoft: '#2f1d4d',
    darkFg: '#1e0836',
    separation: 22.5,
  },
  {
    id: 'mint',
    label: 'Mint',
    // From the chip palette, and the only one of the five that clears the floor
    // as an accent: 19.3 from `degraded` amber, its nearest status.
    light: '#0f8f68',
    lightInk: '#0f8f68',
    lightSoft: '#dcf6ec',
    lightFg: '#ffffff',
    dark: '#4ed2a6',
    darkInk: '#7ee0c0',
    darkSoft: '#123c31',
    darkFg: '#06251b',
    separation: 19.3,
  },

  /*
   * The rest of the chosen palette, shipped because it was asked for twice, and
   * shipped with the number visible because the number is the point.
   *
   * These sit below the floor: an accent this close to a status colour can be
   * misread as one, and the misreading that matters is a primary button that
   * looks like a "down" badge on a status page. The picker names the status
   * each one is nearest, so the trade is made in front of the person making it
   * rather than discovered afterwards.
   *
   * Darkening does not rescue them — it makes them worse. A rose dark enough to
   * carry white text at 4.5:1 measures ΔE 2.9 from `down`; the value below is
   * the lightest that still holds contrast, at 7.4.
   */
  {
    id: 'rose',
    label: 'Rose',
    light: '#d23a60',
    lightInk: '#c2274f',
    lightSoft: '#fde7ec',
    lightFg: '#ffffff',
    dark: '#e4486b',
    darkInk: '#f7a8bd',
    darkSoft: '#45182a',
    darkFg: '#2b0711',
    separation: 7.4,
    nearest: 'down',
  },
  {
    id: 'amber',
    label: 'Amber',
    light: '#f9d276',
    // The fill is light enough to need a dark foreground, which is why the ink
    // is a different colour rather than the same one: #f9d276 as text on white
    // is 1.6:1 and unreadable.
    lightInk: '#8a6d1f',
    lightSoft: '#fdf3dc',
    lightFg: '#17384b',
    dark: '#f9d276',
    darkInk: '#fbdf9e',
    darkSoft: '#42381c',
    darkFg: '#17384b',
    separation: 9.3,
    nearest: 'degraded',
  },
  {
    id: 'ocean',
    label: 'Ocean',
    light: '#2a7ba0',
    lightInk: '#1f6a8c',
    lightSoft: '#e2f0f7',
    lightFg: '#ffffff',
    dark: '#3288b0',
    darkInk: '#8ec9e4',
    darkSoft: '#14313f',
    darkFg: '#05161f',
    separation: 6.0,
    nearest: 'maintenance',
  },
  {
    id: 'magenta',
    label: 'Magenta',
    light: '#c026d3',
    lightInk: '#c026d3',
    lightSoft: '#fbe8fd',
    lightFg: '#ffffff',
    dark: '#d946ef',
    darkInk: '#f0abfc',
    darkSoft: '#3d1247',
    darkFg: '#2b0630',
    separation: 22.7,
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

export const DEFAULT_ACCENT = ACCENTS[1]!

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

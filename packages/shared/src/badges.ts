/**
 * The badge shapes, named once.
 *
 * Shared rather than declared twice because the two declarations had already
 * disagreed: the product copy promised a circle, an alert block and a status
 * bar while the renderer served two pills. A screen that offers a style the
 * renderer cannot draw is the same bug in the other direction, so both ends
 * read this list.
 */

export const BADGE_STYLES = ['flat', 'plastic', 'circle', 'alert-block', 'status-bar'] as const

export type BadgeStyle = (typeof BADGE_STYLES)[number]

export interface BadgeStyleInfo {
  label: string
  /** What it is for, in the words someone choosing between them would use. */
  hint: string
}

export const BADGE_STYLE_INFO: Record<BadgeStyle, BadgeStyleInfo> = {
  flat: {
    label: 'Flat',
    hint: 'The two-part pill every README already has a row of.',
  },
  plastic: {
    label: 'Plastic',
    hint: 'The same pill with a gloss, for pages whose other badges have one.',
  },
  circle: {
    label: 'Circle',
    hint: 'A dot and the word beside it — compact enough to sit inside a sentence.',
  },
  'alert-block': {
    label: 'Alert block',
    hint: 'A callout with a coloured rule, for the top of a page or a docs section.',
  },
  'status-bar': {
    label: 'Status bar',
    hint: 'A strip that spans a column, with the state in a chip on the right.',
  },
}

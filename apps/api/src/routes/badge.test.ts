import { describe, expect, it } from 'vitest'
import type { CheckStatusValue } from '@tern/shared'
import { BADGE_STYLES } from '@tern/shared/badges'
import { __testables as badge } from './badge.js'

/**
 * The badge renderers.
 *
 * Worth testing without a database because these strings are embedded in other
 * people's pages: what matters is that every style escapes what it interpolates,
 * names itself for a screen reader, and never renders state as colour alone.
 */

const STATUSES: CheckStatusValue[] = [
  'operational',
  'degraded',
  'partial',
  'down',
  'maintenance',
  'unknown',
]

describe('every style', () => {
  it.each(BADGE_STYLES)('%s renders well-formed standalone SVG', (style) => {
    const svg = badge.renderBadge('api', 'operational', style)
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true)
    expect(svg).toContain('role="img"')
  })

  it.each(BADGE_STYLES)('%s carries an accessible name', (style) => {
    const svg = badge.renderBadge('checkout', 'down', style)
    expect(svg).toMatch(/aria-label="[^"]+"/)
    expect(svg).toContain('<title>')
    // The status is spelled out, never left to the fill colour alone.
    expect(svg).toContain('major outage')
  })

  it.each(BADGE_STYLES)('%s escapes markup in the label', (style) => {
    const svg = badge.renderBadge('"><script>alert(1)</script>', 'operational', style)
    expect(svg).not.toContain('<script>')
  })

  it.each(BADGE_STYLES)('%s declares a positive width and height', (style) => {
    const svg = badge.renderBadge('api', 'degraded', style)
    const width = Number(/width="(\d+(?:\.\d+)?)"/.exec(svg)?.[1])
    const height = Number(/height="(\d+(?:\.\d+)?)"/.exec(svg)?.[1])
    expect(width).toBeGreaterThan(0)
    expect(height).toBeGreaterThan(0)
  })

  it('renders every status in every style', () => {
    for (const style of BADGE_STYLES) {
      for (const status of STATUSES) {
        expect(badge.renderBadge('api', status, style)).toContain('</svg>')
      }
    }
  })
})

describe('sizing', () => {
  it('grows with the text', () => {
    expect(badge.textWidth('operational')).toBeGreaterThan(badge.textWidth('down'))
    expect(badge.textLength('operational')).toBeGreaterThan(badge.textLength('down'))
  })

  it('scales with the font size', () => {
    expect(badge.textLength('status', 13)).toBeGreaterThan(badge.textLength('status', 11))
  })

  it('keeps the pill wide enough for its longest status', () => {
    const svg = badge.renderBadge('status', 'partial', 'flat')
    const width = Number(/width="(\d+)"/.exec(svg)?.[1])
    // Both halves plus their padding, or the words are clipped.
    expect(width).toBeGreaterThanOrEqual(
      badge.textWidth('status') + badge.textWidth('partial outage'),
    )
  })
})

describe('the shapes themselves', () => {
  it('gives the circle a dot and the word', () => {
    const svg = badge.renderBadge('api', 'operational', 'circle')
    expect(svg).toContain('<circle')
    expect(svg).toContain('operational')
  })

  it('gives the alert block a coloured rule and a wash', () => {
    const svg = badge.renderBadge('api', 'down', 'alert-block')
    expect(svg).toContain('#d1364f')
    expect(svg).toContain('#fce8ec')
  })

  it('puts the status in its own chip on the bar', () => {
    const svg = badge.renderBadge('api', 'maintenance', 'status-bar')
    expect(svg).toContain('#0b7ec4')
    expect(svg).toContain('maintenance')
  })

  it('shades only the plastic pill', () => {
    expect(badge.renderBadge('api', 'operational', 'plastic')).toContain('url(#s)')
    expect(badge.renderBadge('api', 'operational', 'flat')).not.toContain('url(#s)')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { applyFont, DEFAULT_FONT, fontById, FONTS } from './fonts'

describe('fontById', () => {
  it('returns the font a stored id names', () => {
    expect(fontById('nunito').label).toBe('Nunito')
  })

  /**
   * The three shapes a tenant's stored value actually takes: a family this
   * instance no longer ships, and the two ways "never chose one" arrives from
   * the API — `branding.font` missing, or explicitly null.
   */
  it.each([['helvetica'], [undefined], [null]])('falls back to the default for %s', (id) => {
    expect(fontById(id)).toBe(DEFAULT_FONT)
  })

  it('defaults to the typeface the interface was set in before the setting existed', () => {
    expect(DEFAULT_FONT.id).toBe('comfortaa')
  })
})

describe('FONTS', () => {
  it('has unique ids', () => {
    expect(new Set(FONTS.map((font) => font.id)).size).toBe(FONTS.length)
  })

  /**
   * A blank stack would not throw anywhere — `--font-sans: ''` is simply
   * ignored and the page keeps whatever it had, so the picker would offer an
   * option that does nothing and say nothing about it.
   */
  it('gives every font a non-empty stack, label and description', () => {
    for (const font of FONTS) {
      expect(font.stack.trim()).not.toBe('')
      expect(font.label.trim()).not.toBe('')
      expect(font.description.trim()).not.toBe('')
    }
  })

  it('ends every stack in a generic family, so a failed download still renders', () => {
    for (const font of FONTS) {
      expect(font.stack).toMatch(/(sans-serif|serif|monospace|system-ui)$/)
    }
  })
})

describe('applyFont', () => {
  it('sets --font-sans on the document element', () => {
    // The suite runs in Node. `setProperty` is the whole of the DOM this
    // module touches, so a spy on it is enough and cheaper than a jsdom.
    const setProperty = vi.fn()
    vi.stubGlobal('document', { documentElement: { style: { setProperty } } })

    applyFont(fontById('nunito'))

    expect(setProperty).toHaveBeenCalledWith('--font-sans', fontById('nunito').stack)
    vi.unstubAllGlobals()
  })
})

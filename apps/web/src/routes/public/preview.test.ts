import { describe, expect, it } from 'vitest'
import { previewOverrides } from './preview'

/**
 * The contract between the layout editor's preview frame and the page it
 * frames.
 *
 * Pinned because the failure it had was invisible: `custom` was missing from
 * the accepted set while the return type named it, so previewing that density
 * fell back to the *saved* layout and showed something plausible. A preview
 * that quietly shows the wrong thing is worse than one that shows nothing —
 * nothing gets reported.
 */

describe('the preview overrides', () => {
  it('accepts every density the editor can choose', () => {
    for (const layout of ['list', 'grid', 'compact', 'custom']) {
      expect(previewOverrides(`?preview=1&layout=${layout}`).layout, layout).toBe(layout)
    }
  })

  it('ignores a density it does not know', () => {
    // Falls back to the saved layout rather than being passed on: this comes
    // from a query string, which anyone can type.
    expect(previewOverrides('?preview=1&layout=wall').layout).toBeUndefined()
    expect(previewOverrides('?preview=1&layout=').layout).toBeUndefined()
  })

  it('does nothing at all without the preview flag', () => {
    // The public page must not be arrangeable by a link. A visitor handed
    // `?layout=compact` sees the page as its operator saved it.
    expect(previewOverrides('?layout=grid&order=a,b')).toEqual({})
    expect(previewOverrides('')).toEqual({})
  })

  it('reads the order as a list of ids, dropping the empties', () => {
    expect(previewOverrides('?preview=1&order=a,b,c').order).toEqual(['a', 'b', 'c'])
    // A trailing comma is what a one-item list looks like mid-edit.
    expect(previewOverrides('?preview=1&order=a,,b,').order).toEqual(['a', 'b'])
    expect(previewOverrides('?preview=1').order).toBeUndefined()
  })
})

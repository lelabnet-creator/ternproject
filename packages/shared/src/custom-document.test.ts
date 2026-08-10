import { describe, expect, it } from 'vitest'
import { starterDocument } from './custom-document.js'

/**
 * The document a `custom` page starts from.
 *
 * What is worth pinning is not the design — that is meant to be edited the
 * minute it appears — but the two things an operator would not know to put back
 * if they were lost: the contract with the page, and the fact that there is
 * something in all three boxes at all. An empty starter is the state this
 * existed to end.
 */

describe('the starting document', () => {
  const doc = starterDocument('Acme Corp')

  it('fills all three fields, which is the whole point', () => {
    // `custom` draws none of TERN's own widgets, so any empty field here is a
    // public page that renders less than it should — and an empty set of them
    // is a page that says nothing has been written yet.
    expect(doc.html.trim()).not.toBe('')
    expect(doc.css.trim()).not.toBe('')
    expect(doc.js.trim()).not.toBe('')
  })

  it('carries the data contract, not just markup', () => {
    // `tern.onUpdate` is the only thing the document is given, and it is the
    // one line nobody can guess. It fires on load and on every refresh, which
    // is what makes a document stay live without polling.
    expect(doc.js).toContain('tern.onUpdate')
    // The ids the script writes into have to exist in the markup, or the
    // example arrives broken — the worst possible first impression of a mode
    // whose whole promise is that you can write the page yourself.
    for (const id of ['summary', 'tiles', 'notes']) {
      expect(doc.html).toContain(`id="${id}"`)
      expect(doc.js).toContain(`'${id}'`)
    }
  })

  it('is addressed to this page, not to somebody else’s company', () => {
    expect(doc.html).toContain('Acme Corp')
    expect(starterDocument('Crisislab').html).toContain('Crisislab')
    // A page with no name still gets a heading rather than an empty one.
    expect(starterDocument().html).toMatch(/<h1>[^<]+<\/h1>/)
  })

  it('says the state in words before it says it in colour', () => {
    // The rule the rest of the product follows, and an example is where a rule
    // gets copied from. The tile prints the status; the hue is on the edge.
    expect(doc.js).toContain('class="state"')
    expect(doc.css).toContain('border-left-color')
  })
})

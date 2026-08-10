import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GroupPanes, type PaneGroup } from './GroupPanes'

/**
 * Paging through the groups on a phone.
 *
 * What is pinned here are the two safety properties, not the swipe. The swipe
 * is CSS scroll-snap and the browser's own physics; what could quietly go wrong
 * is a status page that hides an outage behind a gesture — so these check that
 * it cannot.
 */

const groups: PaneGroup[] = [
  { id: 'a', name: 'Platform', statuses: ['operational'], content: <p>A</p> },
  { id: 'b', name: 'Payments', statuses: ['operational', 'down'], content: <p>B</p> },
  { id: 'c', name: null, statuses: ['operational'], content: <p>C</p> },
]

describe('the panes', () => {
  const html = renderToStaticMarkup(<GroupPanes groups={groups} />)

  it('gives every group a real control, not only a swipe', () => {
    /*
     * `gesture-alternative`: a page indicator that only reports is one more
     * thing a keyboard cannot use. Each dot is a button carrying the group's
     * name, so a screen reader hears "Payments" rather than "button, 2 of 3".
     */
    const dots = html.match(/id="pane-dot-/g) ?? []
    expect(dots).toHaveLength(3)
    expect(html).toContain('aria-label="Platform"')
    expect(html).toContain('aria-label="Payments"')
    // The unnamed group still gets a label rather than an empty one.
    expect(html).toContain('aria-label="Other"')
  })

  it("puts each group's title inside its own pane", () => {
    // The title travels with the content it names; a heading left behind in a
    // strip describes whichever pane happens to be showing.
    expect(html).toContain('>Platform<')
    expect(html).toContain('>Payments<')
  })

  it('renders every pane rather than only the visible one', () => {
    // The content has to be in the document for find-in-page, for a screen
    // reader walking the panels, and so that a swipe reveals something that is
    // already there instead of waiting on a render.
    for (const letter of ['A', 'B', 'C']) expect(html).toContain(`<p>${letter}</p>`)
  })

  it('marks the group that has a problem, so it need not be swiped to', () => {
    /*
     * The property that makes this safe on a status page. A failure two panes
     * away must be visible from the first pane, or the page hides the one thing
     * somebody opened it to find.
     */
    // Exactly one dot wears a status colour, and it is the failing group's.
    const coloured = html.match(/var\(--status-down\)/g) ?? []
    expect(coloured).toHaveLength(1)
  })

  it('does not build a carousel for a single group', () => {
    // One pane is not a choice, and a tab strip over it is furniture.
    const single = renderToStaticMarkup(<GroupPanes groups={[groups[0]!]} />)
    expect(single).not.toContain('id="pane-dot-')
    expect(single).toContain('<p>A</p>')
  })

  it('keeps one tab stop for the strip', () => {
    const stops = html.match(/tabindex="0"/gi) ?? []
    expect(stops).toHaveLength(1)
  })
})

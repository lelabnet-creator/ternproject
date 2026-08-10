import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { defaultBlocks, hasComponentsBlock, type Block } from '@tern/shared/blocks'
import { communicationsPlacement, CustomLayout } from './CustomLayout'
import type { StatusSummary } from '../../lib/api'

/**
 * That the incidents are on the page exactly once, wherever they are — and now
 * that the components are too.
 *
 * The two failures this guards against are opposites and both are silent. Drop
 * the fallback and a page whose arrangement never mentioned incidents stops
 * showing them at all — an operator would have to notice the absence of
 * something that only appears during an outage. Keep the notes above *and*
 * render the block and every incident is printed twice.
 *
 * The same pair of failures now applies to the components, and matters more:
 * `custom` is the whole page, so an arrangement that names neither is a status
 * page reporting nothing.
 */

const INCIDENTS = '<p>incident-marker</p>'
const COMPONENTS = '<p>components-marker</p>'

const data = {
  components: [{ id: 'c1', name: 'API' }],
  incidents: [],
  maintenances: [],
} as unknown as StatusSummary

function render(blocks: Block[]) {
  return renderToStaticMarkup(
    <CustomLayout
      blocks={blocks}
      data={data}
      days={() => []}
      locale="en"
      timeZone="UTC"
      renderComponent={(component) => <p>{component.name}</p>}
      renderCommunications={() => <p>incident-marker</p>}
      renderHeader={() => <p>header-marker</p>}
      renderPulse={(showUpdatedAt) => <p>pulse-marker:{String(showUpdatedAt)}</p>}
      renderSubscribe={() => <p>subscribe-marker</p>}
      renderComponents={(density) => (
        <>
          <p>components-marker</p>
          <span>{density}</span>
        </>
      )}
    />,
  )
}

const text: Block = { type: 'text', id: 't', body: 'Hello', style: 'body', x: 0, y: 0, w: 6, h: 1 }
const incidents: Block = { type: 'incidents', id: 'i', x: 0, y: 1, w: 12, h: 2 }

describe('where the incidents end up', () => {
  it('leaves them above an arrangement that does not ask for them', () => {
    // The original intent, unchanged: the constraint is that incidents cannot
    // be removed, not that they cannot be placed.
    expect(communicationsPlacement('custom', [text])).toBe('above')
    expect(render([text])).not.toContain(INCIDENTS)
  })

  it('leaves them above a custom page with no blocks at all', () => {
    // An empty arrangement draws nothing, so nothing on it claimed the notes.
    // The page substitutes the default arrangement before it ever gets here;
    // this is the answer for the case where it does not.
    expect(communicationsPlacement('custom', [])).toBe('above')
  })

  it('leaves them above every layout that is not custom', () => {
    // Even when stale blocks are still stored from a previous custom
    // arrangement — a `list` page renders none of them, so a block naming the
    // incidents there would make them vanish.
    for (const layout of ['list', 'grid', 'compact'] as const) {
      expect(communicationsPlacement(layout, [incidents])).toBe('above')
    }
  })

  it('draws them inside the block when one is placed, and only there', () => {
    expect(communicationsPlacement('custom', [text, incidents])).toBe('arranged')

    const html = render([text, incidents])
    expect(html.split(INCIDENTS)).toHaveLength(2)
  })
})

describe('where the components end up', () => {
  const all: Block = { type: 'components', id: 'a', density: 'grid', x: 0, y: 0, w: 12, h: 6 }
  const one: Block = { type: 'control', id: 'o', controlId: 'c1', x: 0, y: 0, w: 4, h: 3 }

  it('says the arrangement does not have them when it only decorates', () => {
    // The page then draws them underneath. Same rule as the incidents: absence
    // of the block is what brings them back, so there is no state in which a
    // status page reports no status.
    expect(hasComponentsBlock([text])).toBe(false)
    expect(render([text])).not.toContain(COMPONENTS)
  })

  it('draws them inside the block when one is placed, and only there', () => {
    expect(hasComponentsBlock([text, all])).toBe(true)
    expect(render([text, all]).split(COMPONENTS)).toHaveLength(2)
  })

  it('passes the block its own density rather than the page’s', () => {
    // The one place the three densities still mean something in `custom`.
    expect(render([all])).toContain('<span>grid</span>')
  })

  it('counts a hand-placed component as the arrangement having them', () => {
    expect(hasComponentsBlock([one])).toBe(true)
    // And it is the component card that gets drawn, not the whole list.
    const html = render([one])
    expect(html).toContain('<p>API</p>')
    expect(html).not.toContain(COMPONENTS)
  })
})

describe('the page’s own parts, as blocks', () => {
  it('draws each of them where it was placed', () => {
    const html = render(defaultBlocks())
    expect(html).toContain('<p>header-marker</p>')
    expect(html).toContain('<p>pulse-marker:true</p>')
    expect(html).toContain('<p>subscribe-marker</p>')
    expect(html).toContain(COMPONENTS)
    expect(html).toContain(INCIDENTS)
  })

  it('hands the pulse its own timestamp setting', () => {
    const quiet: Block = { type: 'pulse', id: 'p', showUpdatedAt: false, x: 0, y: 0, w: 12, h: 4 }
    expect(render([quiet])).toContain('<p>pulse-marker:false</p>')
  })

  it('labels every block for the stylesheet to select', () => {
    // The `data-tern` contract is what a tenant's CSS is written against. It
    // has to survive any refactor of the markup inside a block, which is the
    // point of it existing rather than letting people target our elements.
    const html = render(defaultBlocks())
    for (const type of ['header', 'pulse', 'subscribe', 'incidents', 'components']) {
      expect(html).toContain(`data-tern="${type}"`)
    }
  })

  it('draws nothing at all for an arrangement with nothing in it', () => {
    // No "nothing placed yet" notice on a public page: that sentence is for the
    // editor. A visitor gets the guarantees the page renders around this.
    expect(render([])).not.toContain('<p>')
  })
})

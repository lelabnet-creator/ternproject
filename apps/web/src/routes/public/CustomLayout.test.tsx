import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Block } from '@tern/shared/blocks'
import { communicationsPlacement, CustomLayout } from './CustomLayout'
import type { StatusSummary } from '../../lib/api'

/**
 * That the incidents are on the page exactly once, wherever they are.
 *
 * The two failures this guards against are opposites and both are silent. Drop
 * the fallback and a page whose arrangement never mentioned incidents stops
 * showing them at all — an operator would have to notice the absence of
 * something that only appears during an outage. Keep the notes above *and*
 * render the block and every incident is printed twice.
 */

const INCIDENTS = '<p>incident-marker</p>'

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
    // An empty arrangement falls through to the document mode, which renders
    // whatever the tenant wrote and never the incidents.
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

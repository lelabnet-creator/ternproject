import { GRID_COLUMNS, hasIncidentsBlock, type Block } from '@tern/shared/blocks'
import type { StatusComponent, StatusSummary } from '../../lib/api'
import type { UptimeDay } from '../../charts/UptimeRibbon'

/**
 * Where the page's incidents and maintenance windows are drawn.
 *
 * The rule used to be "incidents cannot be placed": they were rendered above
 * the component area unconditionally, for every layout, and the builder offered
 * no block for them. The reason given was sound — a status page that could be
 * made to hide its own incidents would not be one — but the conclusion was
 * broader than the reason. Placing something is not the same as removing it.
 *
 * So the rule is now "incidents cannot be *removed*". An arrangement that names
 * an `incidents` block draws them there; an arrangement that names none — which
 * includes every page built before this existed, every document-mode page, and
 * any page where somebody deleted the block — gets them back above the
 * arrangement, exactly as before. There is no state in which they are absent,
 * because absence of the block is what brings them back.
 *
 * Lives beside the arranged layout rather than in the page, so the two halves
 * of the decision cannot drift: whoever renders the blocks owns the answer to
 * whether the blocks already covered it.
 */
export function communicationsPlacement(
  layout: 'list' | 'grid' | 'compact' | 'custom',
  blocks: Block[],
): 'above' | 'arranged' {
  // `blocks.length > 0` and not just the layout: an empty arrangement falls
  // through to the document mode, which draws no blocks at all.
  const arranged = layout === 'custom' && blocks.length > 0
  return arranged && hasIncidentsBlock(blocks) ? 'arranged' : 'above'
}

/**
 * A page arranged on a grid.
 *
 * The other half of the `custom` layout. Where the document mode hands a
 * sandboxed frame whatever the tenant wrote, this draws structured blocks — and
 * because they are structured, a component block renders the component's own
 * widget. That closes the gap the document mode has by construction: a frame
 * confined enough to be safe cannot reach React, so it can only redraw the
 * charts approximately, and the ones here are the same charts the other layouts
 * use.
 *
 * Free placement without pixel coordinates. A twelve-column grid with explicit
 * spans is what makes the arrangement reachable from a keyboard in the builder,
 * responsive without a per-breakpoint schema, and expressible as three integers
 * instead of a stylesheet.
 */
export function CustomLayout({
  blocks,
  data,
  days,
  locale,
  timeZone,
  renderComponent,
  renderCommunications,
}: {
  blocks: Block[]
  data: StatusSummary
  /** Filtered per component by the caller, exactly as the other layouts do. */
  days: (component: StatusComponent) => UptimeDay[]
  locale: string
  timeZone: string
  /** The card the other layouts draw, passed in rather than imported twice. */
  renderComponent: (component: StatusComponent, componentDays: UptimeDay[]) => React.ReactNode
  /**
   * The incident and maintenance notes, for the same reason: there is one
   * Communications on the page, and an arranged page must show the same words,
   * tones and timestamps as an unarranged one rather than a second rendering
   * of them that drifts.
   */
  renderCommunications: () => React.ReactNode
}) {
  if (blocks.length === 0) {
    return (
      <section className="page-group">
        <p style={{ margin: 0, color: 'var(--color-fg-subtle)' }}>
          This page uses a custom layout, and nothing has been placed on it yet.
        </p>
      </section>
    )
  }

  return (
    <section
      className="page-group"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))`,
        gap: 'var(--space-3)',
        // Rows size themselves to what is in them. A fixed row height would
        // clip a chart on one page and leave a gap under a line of text on the
        // next, and the blocks already say how many rows they span.
        gridAutoRows: 'minmax(3.5rem, auto)',
      }}
    >
      {blocks.map((block) => (
        <div
          key={block.id}
          style={{
            /*
             * One column on a narrow screen, whatever the block asked for.
             *
             * The span is the arrangement someone built on a wide canvas; below
             * that width it would be a horizontal scrollbar. This is the
             * responsive strategy the backlog said a free grid owes, and it is
             * one line because the grid is the model rather than pixels.
             */
            gridColumn: `span ${block.w} / span ${block.w}`,
            gridRow: `span ${block.h} / span ${block.h}`,
            minWidth: 0,
          }}
        >
          <BlockBody
            block={block}
            data={data}
            days={days}
            locale={locale}
            timeZone={timeZone}
            renderComponent={renderComponent}
            renderCommunications={renderCommunications}
          />
        </div>
      ))}
    </section>
  )
}

function BlockBody({
  block,
  data,
  days,
  renderComponent,
  renderCommunications,
}: {
  block: Block
  data: StatusSummary
  days: (component: StatusComponent) => UptimeDay[]
  locale: string
  timeZone: string
  renderComponent: (component: StatusComponent, componentDays: UptimeDay[]) => React.ReactNode
  renderCommunications: () => React.ReactNode
}) {
  if (block.type === 'incidents') {
    // Nothing is drawn when there is nothing to say, here as everywhere else —
    // the block leaves a gap on a quiet day rather than a "no incidents" panel
    // that trains people to skip the place where the news appears.
    return <>{renderCommunications()}</>
  }

  if (block.type === 'text') {
    return (
      <p
        style={{
          margin: 0,
          fontSize: block.style === 'heading' ? 'var(--text-lg)' : 'var(--text-base)',
          fontWeight: block.style === 'heading' ? 600 : 400,
          color: block.style === 'heading' ? 'var(--color-fg)' : 'var(--color-fg-muted)',
          // Written as text and rendered as text. The document mode is where
          // markup goes, behind a sandbox; this one takes none.
          whiteSpace: 'pre-wrap',
        }}
      >
        {block.body}
      </p>
    )
  }

  if (block.type === 'image') {
    return (
      <img
        src={block.url}
        alt={block.alt}
        // Fits the box it was given without deciding the box's shape.
        style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
      />
    )
  }

  const component = data.components.find((c) => c.id === block.controlId)
  if (!component) {
    // A component deleted after the page was arranged. The block is left in
    // place rather than dropped, so the arrangement does not silently reflow
    // the moment somebody removes a control.
    return (
      <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)' }}>
        This component is no longer on the page.
      </p>
    )
  }

  return <>{renderComponent(component, days(component))}</>
}

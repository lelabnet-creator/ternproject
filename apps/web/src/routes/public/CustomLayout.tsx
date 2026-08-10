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
 * The whole of the `custom` layout, and the whole of the page: the header, the
 * pulse, the subscribe box and the components are blocks here, not fixtures
 * around it. What the tenant does not place is not drawn — with the two
 * exceptions the page keeps for itself, incidents and components, which come
 * back on their own when no block claims them.
 *
 * Nothing here re-implements what it draws. Every part arrives as a render
 * prop from the page, so an arranged header is the same header, an arranged
 * pulse the same ring, an arranged component the same card with the same
 * widget. A second rendering of any of them would drift the first time either
 * side was touched.
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
  renderHeader,
  renderPulse,
  renderSubscribe,
  renderComponents,
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
  /** The tenant's mark and the page name. */
  renderHeader: () => React.ReactNode
  /** The ring. The argument is the block's own `showUpdatedAt`. */
  renderPulse: (showUpdatedAt: boolean) => React.ReactNode
  renderSubscribe: () => React.ReactNode
  /** Every component, grouped, at the density the block asked for. */
  renderComponents: (density: 'list' | 'grid' | 'compact') => React.ReactNode
}) {
  return (
    <section
      data-tern="arrangement"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))`,
        gap: 'var(--space-3)',
        // Rows size themselves to what is in them. A fixed row height would
        // clip a chart on one page and leave a gap under a line of text on the
        // next, and the blocks already say how many rows they span.
        gridAutoRows: 'minmax(3.5rem, auto)',
        // The panel is gone with the card around it: the arrangement is the
        // page, not a section of one. What is left is the gap before whatever
        // the guarantees put underneath.
        marginBottom: 'var(--space-5)',
      }}
    >
      {blocks.map((block) => (
        <div
          key={block.id}
          // The selector contract the tenant's stylesheet is written against.
          // Stable across every refactor of what is inside it, which is the
          // point of having one rather than letting people target our markup.
          data-tern={block.type}
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
            renderHeader={renderHeader}
            renderPulse={renderPulse}
            renderSubscribe={renderSubscribe}
            renderComponents={renderComponents}
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
  renderHeader,
  renderPulse,
  renderSubscribe,
  renderComponents,
}: {
  block: Block
  data: StatusSummary
  days: (component: StatusComponent) => UptimeDay[]
  locale: string
  timeZone: string
  renderComponent: (component: StatusComponent, componentDays: UptimeDay[]) => React.ReactNode
  renderCommunications: () => React.ReactNode
  renderHeader: () => React.ReactNode
  renderPulse: (showUpdatedAt: boolean) => React.ReactNode
  renderSubscribe: () => React.ReactNode
  renderComponents: (density: 'list' | 'grid' | 'compact') => React.ReactNode
}) {
  if (block.type === 'incidents') {
    // Nothing is drawn when there is nothing to say, here as everywhere else —
    // the block leaves a gap on a quiet day rather than a "no incidents" panel
    // that trains people to skip the place where the news appears.
    return <>{renderCommunications()}</>
  }

  // The page's own parts, drawn by the page. Each of these was a fixture above
  // the arrangement until `custom` came to mean the whole page rather than the
  // panel in the middle of it.
  if (block.type === 'header') return <>{renderHeader()}</>
  if (block.type === 'pulse') return <>{renderPulse(block.showUpdatedAt)}</>
  if (block.type === 'subscribe') return <>{renderSubscribe()}</>
  if (block.type === 'components') return <>{renderComponents(block.density)}</>

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

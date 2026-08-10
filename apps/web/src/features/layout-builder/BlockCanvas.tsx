import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  clampBlock,
  GRID_COLUMNS,
  hasIncidentsBlock,
  nextFreeRow,
  type Block,
} from '@tern/shared/blocks'
import { Button, Field, Input, Select, Textarea } from '../../components/ui'
import type { Control } from '../../lib/adminApi'

/**
 * Arranging the page by hand.
 *
 * The backlog turned a drag editor down for three reasons, and the grid answers
 * all three. Per-breakpoint coordinates are unnecessary because a span collapses
 * to one column on a narrow screen. The responsive question has one answer
 * rather than a table of them. And "dragging in two dimensions has no obvious
 * arrow-key analogue" stops being true the moment the two dimensions are
 * integers: the arrow keys move a block one cell, which is the same move the
 * pointer makes.
 *
 * So every action here has a keyboard path, and that is not a courtesy — the
 * reordering screen beside it deliberately never offers a move the keyboard
 * cannot make, and an editor that broke that rule would be the odd one out.
 */
export function BlockCanvas({
  blocks,
  controls,
  onChange,
}: {
  blocks: Block[]
  controls: Control[]
  onChange: (next: Block[]) => void
}) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<string | null>(null)

  const update = (id: string, patch: Partial<Block>) =>
    onChange(
      blocks.map((block) =>
        block.id === id ? (clampBlock({ ...block, ...patch }) as Block) : block,
      ),
    )

  const add = (block: Block) => {
    onChange([...blocks, block])
    setSelected(block.id)
  }

  const remove = (id: string) => {
    onChange(blocks.filter((block) => block.id !== id))
    setSelected(null)
  }

  const move = (id: string, dx: number, dy: number) => {
    const block = blocks.find((b) => b.id === id)
    if (block) update(id, { x: block.x + dx, y: block.y + dy })
  }

  const resize = (id: string, dw: number, dh: number) => {
    const block = blocks.find((b) => b.id === id)
    if (block) update(id, { w: block.w + dw, h: block.h + dh })
  }

  const current = blocks.find((b) => b.id === selected) ?? null

  /*
   * Dragging, in cells.
   *
   * Pointer events rather than a drag library: what is being dragged is two
   * integers, and the whole gesture is "how many columns and rows has the
   * pointer travelled". A library would bring a sensor abstraction, a collision
   * strategy and a keyboard coordinate-getter to reproduce arithmetic that is
   * four lines — and the keyboard path here is the arrow keys, which do not go
   * through the pointer at all.
   *
   * Capturing the pointer means the drag survives leaving the block, which is
   * exactly what happens when you drag something to the other side of a grid.
   */
  const startDrag = (event: React.PointerEvent, block: Block) => {
    // Left button only, and never from a control inside the block.
    if (event.button !== 0) return
    const canvas = event.currentTarget.parentElement
    if (!canvas) return

    setSelected(block.id)
    event.currentTarget.setPointerCapture(event.pointerId)

    const rect = canvas.getBoundingClientRect()
    const cellWidth = rect.width / GRID_COLUMNS
    // Read from the element rather than assumed: the row height is a CSS
    // minimum plus whatever the content needed.
    const cellHeight = event.currentTarget.getBoundingClientRect().height / block.h
    const originX = event.clientX
    const originY = event.clientY

    const onMove = (moveEvent: PointerEvent) => {
      const dx = Math.round((moveEvent.clientX - originX) / cellWidth)
      const dy = Math.round((moveEvent.clientY - originY) / (cellHeight || 1))
      if (dx !== 0 || dy !== 0) update(block.id, { x: block.x + dx, y: block.y + dy })
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <Palette controls={controls} blocks={blocks} onAdd={add} />

      <div
        role="application"
        aria-label="Page canvas"
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))`,
          gap: 'var(--space-2)',
          gridAutoRows: 'minmax(3rem, auto)',
          padding: 'var(--space-3)',
          border: '1px dashed var(--color-border-strong)',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--color-bg)',
          minHeight: '12rem',
        }}
      >
        {blocks.length === 0 && (
          <p
            style={{
              gridColumn: `span ${GRID_COLUMNS}`,
              margin: 0,
              alignSelf: 'center',
              textAlign: 'center',
              color: 'var(--color-fg-subtle)',
              fontSize: 'var(--text-sm)',
            }}
          >
            Nothing placed yet. Add a component, your incidents, a line of text or an image above.
          </p>
        )}

        {blocks.map((block) => (
          <button
            key={block.id}
            type="button"
            // A real button, so Tab reaches every block and Enter selects it.
            // The arrow keys then move the selected one, which is the whole
            // keyboard equivalent of dragging.
            onClick={() => setSelected(block.id)}
            onPointerDown={(event) => startDrag(event, block)}
            onKeyDown={(event) => {
              const step: Record<string, [number, number]> = {
                ArrowLeft: [-1, 0],
                ArrowRight: [1, 0],
                ArrowUp: [0, -1],
                ArrowDown: [0, 1],
              }
              const delta = step[event.key]
              if (!delta) return
              event.preventDefault()
              // Shift resizes instead of moving — one modifier, both dimensions,
              // and no second control to find.
              if (event.shiftKey) resize(block.id, delta[0], delta[1])
              else move(block.id, delta[0], delta[1])
            }}
            aria-label={`${describe(block, controls, t)}. Column ${block.x + 1}, row ${block.y + 1}, ${block.w} wide, ${block.h} tall. Arrow keys move, shift and arrow keys resize.`}
            style={{
              gridColumn: `${block.x + 1} / span ${block.w}`,
              gridRow: `${block.y + 1} / span ${block.h}`,
              minWidth: 0,
              padding: 'var(--space-2)',
              textAlign: 'left',
              borderRadius: 'var(--radius-sm)',
              border: `2px solid ${block.id === selected ? 'var(--color-accent)' : 'var(--color-border)'}`,
              background: 'var(--color-surface)',
              color: 'var(--color-fg)',
              font: 'inherit',
              fontSize: 'var(--text-xs)',
              cursor: 'grab',
              touchAction: 'none',
              overflow: 'hidden',
            }}
          >
            {describe(block, controls, t)}
          </button>
        ))}
      </div>

      {current ? (
        <Inspector
          block={current}
          onChange={(patch) => update(current.id, patch)}
          onMove={(dx, dy) => move(current.id, dx, dy)}
          onResize={(dw, dh) => resize(current.id, dw, dh)}
          onRemove={() => remove(current.id)}
        />
      ) : (
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)' }}>
          Drag a block to move it, or select one and use the arrow keys — hold shift to resize. Both
          do the same thing, because the position is two whole numbers rather than a pair of pixel
          offsets.
        </p>
      )}
    </div>
  )
}

function Palette({
  controls,
  blocks,
  onAdd,
}: {
  controls: Control[]
  blocks: Block[]
  onAdd: (block: Block) => void
}) {
  const { t } = useTranslation()
  const [controlId, setControlId] = useState('')
  const y = nextFreeRow(blocks)

  // One is the whole point: the block says *where* the page's incidents go, and
  // a second would print the same notes twice rather than say anything new.
  // Disabled rather than hidden, so the reason is where the button was.
  const incidentsPlaced = hasIncidentsBlock(blocks)

  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'end', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: '14rem' }}>
          <Field label="Add a component" hint="It draws with the widget the control already has.">
            <Select value={controlId} onChange={(e) => setControlId(e.target.value)}>
              <option value="">Choose a control…</option>
              {controls.map((control) => (
                <option key={control.id} value={control.id}>
                  {control.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Button
          onClick={() => {
            if (!controlId) return
            onAdd({ type: 'control', id: newId(), controlId, x: 0, y, w: 4, h: 3 })
            setControlId('')
          }}
        >
          Place
        </Button>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {/* Full width and two rows deep by default: an incident note is a
            paragraph, and a paragraph in a three-column block is a column of
            single words. */}
        <Button
          disabled={incidentsPlaced}
          onClick={() => onAdd({ type: 'incidents', id: newId(), x: 0, y, w: 12, h: 2 })}
        >
          {t('blocks.addIncidents')}
        </Button>
        <Button
          onClick={() =>
            onAdd({
              type: 'text',
              id: newId(),
              body: 'A heading',
              style: 'heading',
              x: 0,
              y,
              w: 12,
              h: 1,
            })
          }
        >
          Add a heading
        </Button>
        <Button
          onClick={() =>
            onAdd({
              type: 'text',
              id: newId(),
              body: 'Some text.',
              style: 'body',
              x: 0,
              y,
              w: 6,
              h: 1,
            })
          }
        >
          Add text
        </Button>
        <Button
          onClick={() =>
            onAdd({
              type: 'image',
              id: newId(),
              url: 'https://example.com/logo.svg',
              alt: '',
              x: 0,
              y,
              w: 3,
              h: 2,
            })
          }
        >
          Add an image
        </Button>
      </div>

      {/* Said here, next to the button, because the behaviour is surprising
          exactly once: removing the block does not remove the incidents. */}
      <p
        className="measure"
        style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)' }}
      >
        {t('blocks.incidentsHint')}
      </p>
    </div>
  )
}

function Inspector({
  block,
  onChange,
  onMove,
  onResize,
  onRemove,
}: {
  block: Block
  onChange: (patch: Partial<Block>) => void
  onMove: (dx: number, dy: number) => void
  onResize: (dw: number, dh: number) => void
  onRemove: () => void
}) {
  return (
    <div
      style={{
        display: 'grid',
        gap: 'var(--space-3)',
        padding: 'var(--space-3)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
      }}
    >
      {block.type === 'text' && (
        <>
          <Field label="Text" hint="Rendered as written. Markup goes in the Document tab.">
            <Textarea
              value={block.body}
              rows={3}
              onChange={(e) => onChange({ body: e.target.value } as Partial<Block>)}
            />
          </Field>
          <Field label="Style" hint="A heading is larger and bolder. Nothing here picks a font.">
            <Select
              value={block.style}
              onChange={(e) => onChange({ style: e.target.value } as Partial<Block>)}
            >
              <option value="heading">Heading</option>
              <option value="body">Body</option>
            </Select>
          </Field>
        </>
      )}

      {block.type === 'image' && (
        <>
          <Field label="Image URL" hint="Served from wherever you host it.">
            <Input
              type="url"
              value={block.url}
              onChange={(e) => onChange({ url: e.target.value } as Partial<Block>)}
            />
          </Field>
          <Field
            label="Alternative text"
            hint="What the image says, for a reader who cannot see it. An image on a status page usually carries meaning."
          >
            <Input
              value={block.alt}
              onChange={(e) => onChange({ alt: e.target.value } as Partial<Block>)}
            />
          </Field>
        </>
      )}

      {/* The same moves the arrow keys make, as buttons — for a pointer, and
          for anyone who would rather press a thing than learn a shortcut. */}
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <Button onClick={() => onMove(-1, 0)} ariaLabel="Move left">
          ←
        </Button>
        <Button onClick={() => onMove(1, 0)} ariaLabel="Move right">
          →
        </Button>
        <Button onClick={() => onMove(0, -1)} ariaLabel="Move up">
          ↑
        </Button>
        <Button onClick={() => onMove(0, 1)} ariaLabel="Move down">
          ↓
        </Button>
        <Button onClick={() => onResize(-1, 0)} ariaLabel="Narrower">
          Narrower
        </Button>
        <Button onClick={() => onResize(1, 0)} ariaLabel="Wider">
          Wider
        </Button>
        <Button onClick={() => onResize(0, -1)} ariaLabel="Shorter">
          Shorter
        </Button>
        <Button onClick={() => onResize(0, 1)} ariaLabel="Taller">
          Taller
        </Button>
        <Button variant="danger" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </div>
  )
}

function describe(block: Block, controls: Control[], t: (key: string) => string): string {
  if (block.type === 'incidents') return t('blocks.incidents')
  if (block.type === 'text') return block.body.slice(0, 40) || 'Text'
  if (block.type === 'image') return block.alt || 'Image'
  return controls.find((c) => c.id === block.controlId)?.name ?? 'Component'
}

/** `crypto.randomUUID` is in every browser this app already requires. */
function newId(): string {
  return crypto.randomUUID()
}

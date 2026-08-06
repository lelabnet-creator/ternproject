import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { adminApi, ApiError, type Control } from '../../lib/adminApi'
import { api } from '../../lib/api'
import { Banner, Button, Card, EmptyState } from '../../components/ui'

/**
 * Arranging the public page: its density, and the order of its components.
 *
 * Deliberately an admin screen rather than an affordance on the public page. A
 * status page is read by people who do not share a session; letting a visitor
 * rearrange it would either be lost on reload or, worse, change what the next
 * visitor sees.
 *
 * Dragging is offered, but it is never the only way. There is no hover on a
 * phone and no drag with a keyboard, so every move is also a button — and the
 * buttons are what the keyboard path is tested against.
 */

export type PageLayout = 'list' | 'grid' | 'compact'

const DENSITIES: { id: PageLayout; label: string; hint: string }[] = [
  { id: 'list', label: 'List', hint: 'One component per row. The most readable on a phone.' },
  { id: 'grid', label: 'Grid', hint: 'Cards side by side. Good for a wall display.' },
  { id: 'compact', label: 'Compact', hint: 'Tight rows for a long list of components.' },
]

export function LayoutScreen({ slug, canWrite }: { slug: string; canWrite: boolean }) {
  const queryClient = useQueryClient()

  const controls = useQuery({
    queryKey: ['controls', slug],
    queryFn: () => adminApi.controls(slug),
  })
  const summary = useQuery({ queryKey: ['summary', slug], queryFn: () => api.summary(slug) })

  const [order, setOrder] = useState<Control[] | null>(null)
  const [density, setDensity] = useState<PageLayout | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // The server is the source of truth until the first edit; after that the
  // local draft is, or a background refetch would undo a move mid-edit.
  useEffect(() => {
    if (controls.data && order === null) {
      setOrder([...controls.data].sort((a, b) => a.position - b.position))
    }
  }, [controls.data, order])

  useEffect(() => {
    if (summary.data && density === null) setDensity(summary.data.tenant.layout)
  }, [summary.data, density])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // A few pixels of travel before a drag starts, so a tap on a card is a
      // tap and not an accidental one-pixel reorder.
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const save = useMutation({
    mutationFn: () =>
      adminApi.updateLayout(slug, {
        layout: density ?? 'list',
        order: (order ?? []).map((control) => ({ controlId: control.id })),
      }),
    onSuccess: async () => {
      setError(null)
      setSaved(true)
      await queryClient.invalidateQueries({ queryKey: ['controls', slug] })
      await queryClient.invalidateQueries({ queryKey: ['summary', slug] })
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  })

  const dirty = useMemo(() => {
    if (!controls.data || !order || !summary.data || !density) return false
    const original = [...controls.data].sort((a, b) => a.position - b.position)
    return (
      density !== summary.data.tenant.layout ||
      original.some((control, index) => control.id !== order[index]?.id)
    )
  }, [controls.data, order, summary.data, density])

  if (controls.isPending || summary.isPending) return <p>Loading the page layout…</p>
  if (controls.isError) return <Banner tone="down">Could not load the components.</Banner>
  if (!order || !density) return null

  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length) return
    setOrder(arrayMove(order, from, to))
    setSaved(false)
  }

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    move(
      order.findIndex((c) => c.id === active.id),
      order.findIndex((c) => c.id === over.id),
    )
  }

  return (
    <section style={{ paddingTop: 'var(--space-6)', display: 'grid', gap: 'var(--space-5)' }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 'var(--text-xl)' }}>Page layout</h1>
        <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--color-fg-subtle)' }}>
          How <code>/s/{slug}</code> is arranged for everyone who reads it.
        </p>
      </div>

      {error && <Banner tone="down">{error}</Banner>}
      {saved && !dirty && <Banner tone="operational">Saved. The public page now matches.</Banner>}

      {/* ── Density ─────────────────────────────────────────────────────── */}
      <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
        <legend style={{ fontSize: 'var(--text-base)', fontWeight: 600, padding: 0 }}>
          Density
        </legend>
        <div
          role="radiogroup"
          aria-label="Page density"
          style={{
            display: 'grid',
            gap: 'var(--space-3)',
            gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))',
            marginTop: 'var(--space-3)',
          }}
        >
          {DENSITIES.map((option) => {
            const selected = option.id === density
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!canWrite}
                onClick={() => {
                  setDensity(option.id)
                  setSaved(false)
                }}
                style={{
                  textAlign: 'left',
                  display: 'block',
                  width: '100%',
                  minHeight: 44,
                  padding: 'var(--space-3)',
                  background: selected ? 'var(--color-surface-raised)' : 'var(--color-surface)',
                  border: `1px solid ${selected ? 'var(--color-accent)' : 'var(--color-border)'}`,
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--color-fg)',
                  fontFamily: 'inherit',
                  cursor: canWrite ? 'pointer' : 'not-allowed',
                }}
              >
                <DensityGlyph layout={option.id} />
                <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{option.label}</div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}>
                  {option.hint}
                </div>
              </button>
            )
          })}
        </div>
      </fieldset>

      {/* ── Preview ─────────────────────────────────────────────────────── */}
      <LayoutPreview slug={slug} density={density} order={order} />

      {/* ── Order ───────────────────────────────────────────────────────── */}
      <div>
        <h2 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-base)' }}>Order</h2>
        <p
          style={{
            margin: '0 0 var(--space-3)',
            fontSize: 'var(--text-sm)',
            color: 'var(--color-fg-subtle)',
          }}
        >
          Drag a component, or use the arrows — both do the same thing, and the arrows work without
          a mouse.
        </p>

        {order.length === 0 ? (
          <EmptyState
            title="Nothing to arrange yet"
            hint="Create a control and it will appear here."
          />
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={order.map((c) => c.id)} strategy={verticalListSortingStrategy}>
              <ol
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  display: 'grid',
                  gap: 'var(--space-2)',
                }}
              >
                {order.map((control, index) => (
                  <SortableRow
                    key={control.id}
                    control={control}
                    index={index}
                    total={order.length}
                    canWrite={canWrite}
                    onMove={move}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {canWrite && (
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
          <Button
            variant="primary"
            busy={save.isPending}
            disabled={!dirty}
            onClick={() => save.mutate()}
          >
            Save layout
          </Button>
          {dirty && (
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)' }}>
              Unsaved changes
            </span>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * The public page as this arrangement will produce it.
 *
 * An iframe of the real page rather than a drawing of it: a mock-up is a second
 * implementation of the layout, and the moment it drifts it starts lying about
 * the thing it exists to predict. The cost is that it shows what is *saved*, so
 * it is labelled that way and refreshes when a save lands.
 *
 * Two widths, because the density choice is precisely the thing that behaves
 * differently on a phone — `grid` resolves to one column there, and an operator
 * choosing it for a wall display should see that rather than discover it.
 */
function LayoutPreview({
  slug,
  density,
  order,
}: {
  slug: string
  density: PageLayout
  order: Control[]
}) {
  const [width, setWidth] = useState<'desktop' | 'phone'>('desktop')
  const [nonce, setNonce] = useState(0)

  // Reload when the saved arrangement could have changed. `order` and `density`
  // are the draft, so this fires on save — and on an edit, which is honest:
  // the frame then visibly differs from the list above it.
  useEffect(() => {
    setNonce((n) => n + 1)
  }, [density, order])

  return (
    <section>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
          marginBottom: 'var(--space-2)',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 'var(--text-base)' }}>Preview</h2>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          {(
            [
              ['desktop', 'Desktop'],
              ['phone', 'Phone'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={width === id}
              onClick={() => setWidth(id)}
              style={{
                minHeight: 44,
                padding: '0 var(--space-3)',
                borderRadius: 'var(--radius-sm)',
                border: `1px solid ${width === id ? 'var(--color-accent)' : 'var(--color-border)'}`,
                background: width === id ? 'var(--color-accent-soft)' : 'transparent',
                color: width === id ? 'var(--color-accent-ink)' : 'var(--color-fg-muted)',
                fontFamily: 'inherit',
                fontSize: 'var(--text-sm)',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <p
        className="measure"
        style={{
          margin: '0 0 var(--space-3)',
          fontSize: 'var(--text-sm)',
          color: 'var(--color-fg-subtle)',
        }}
      >
        The real page, not a drawing of it — so it cannot drift from what visitors get. It shows the{' '}
        <strong>saved</strong> arrangement; save to see a change here.
      </p>

      <div
        style={{
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          overflow: 'hidden',
          background: 'var(--color-surface)',
          maxWidth: width === 'phone' ? 420 : undefined,
        }}
      >
        <iframe
          key={nonce}
          title="Public page preview"
          src={`/s/${slug}?preview=1`}
          /*
           * Deliberately not sandboxed, and the reasoning is worth keeping.
           * `allow-same-origin` alone blocks scripts, which leaves a blank
           * frame — this is a React page. Adding `allow-scripts` beside it
           * restores the page and, for same-origin content, removes the
           * isolation again: the frame can reach its parent either way. A
           * sandbox here would be theatre, so there is none. What is framed is
           * our own page, on our own origin, with no user input in it.
           */
          style={{
            display: 'block',
            width: width === 'phone' ? 390 : '100%',
            height: 520,
            border: 0,
          }}
        />
      </div>
    </section>
  )
}

function SortableRow({
  control,
  index,
  total,
  canWrite,
  onMove,
}: {
  control: Control
  index: number
  total: number
  canWrite: boolean
  onMove: (from: number, to: number) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: control.id,
    disabled: !canWrite,
  })

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // Lifted above its neighbours while dragging, so the row being moved is
        // never the one hidden behind another.
        zIndex: isDragging ? 1 : undefined,
        position: 'relative',
      }}
    >
      <Card>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            flexWrap: 'wrap',
          }}
        >
          {/* The handle is a button so it is reachable by keyboard: dnd-kit's
              keyboard sensor starts a drag on space and moves with the arrows.
              The explicit arrow buttons below remain the simpler path. */}
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${control.name}`}
            disabled={!canWrite}
            style={{
              minWidth: 44,
              minHeight: 44,
              background: 'transparent',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--color-fg-subtle)',
              cursor: canWrite ? 'grab' : 'not-allowed',
              fontFamily: 'inherit',
            }}
          >
            ⠿
          </button>

          <div style={{ minWidth: 0, flex: 1 }}>
            <strong>{control.name}</strong>
            <div
              className="tabular"
              style={{ fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}
            >
              {control.key}
              {!control.isPublic && ' · internal, hidden from the public page'}
            </div>
          </div>

          {canWrite && (
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <Button
                ariaLabel={`Move ${control.name} up`}
                disabled={index === 0}
                onClick={() => onMove(index, index - 1)}
              >
                ↑
              </Button>
              <Button
                ariaLabel={`Move ${control.name} down`}
                disabled={index === total - 1}
                onClick={() => onMove(index, index + 1)}
              >
                ↓
              </Button>
            </div>
          )}
        </div>
      </Card>
    </li>
  )
}

/** A miniature of the arrangement, so the choice is made on a shape, not a word. */
function DensityGlyph({ layout }: { layout: PageLayout }) {
  const bar = (width: string, height: number) => (
    <span
      style={{
        display: 'block',
        width,
        height,
        borderRadius: 2,
        background: 'var(--color-border-strong)',
      }}
    />
  )

  return (
    <div
      aria-hidden="true"
      style={{
        display: layout === 'grid' ? 'grid' : 'flex',
        gridTemplateColumns: layout === 'grid' ? '1fr 1fr' : undefined,
        flexDirection: 'column',
        gap: layout === 'compact' ? 3 : 6,
        marginBottom: 'var(--space-3)',
        height: 44,
      }}
    >
      {bar('100%', layout === 'compact' ? 5 : 10)}
      {bar('100%', layout === 'compact' ? 5 : 10)}
      {bar('100%', layout === 'compact' ? 5 : 10)}
      {layout === 'compact' && bar('100%', 5)}
    </div>
  )
}

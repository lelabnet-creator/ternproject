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
import { Banner, Button, Card, CodeBlock, EmptyState, Field, Textarea } from '../../components/ui'
import { Tabs } from '../../components/Tabs'

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

export type PageLayout = 'list' | 'grid' | 'compact' | 'custom'

const DENSITIES: { id: PageLayout; label: string; hint: string }[] = [
  { id: 'list', label: 'List', hint: 'One component per row. The most readable on a phone.' },
  { id: 'grid', label: 'Grid', hint: 'Cards side by side. Good for a wall display.' },
  { id: 'compact', label: 'Compact', hint: 'Tight rows for a long list of components.' },
  {
    id: 'custom',
    label: 'Custom',
    hint: 'You write the page. The three densities stop applying.',
  },
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
  const [view, setView] = useState('order')
  const [custom, setCustom] = useState<{ html: string; css: string; js: string } | null>(null)

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

  // Only served while the layout is `custom`, so an operator switching to it
  // starts from an empty document rather than from whatever the last one was.
  useEffect(() => {
    if (summary.data && custom === null) {
      setCustom(summary.data.tenant.custom ?? { html: '', css: '', js: '' })
    }
  }, [summary.data, custom])

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
        // Sent whatever the mode: an operator who tried `custom`, went back to
        // `list` and returned should find their document where they left it.
        ...(custom && {
          customHtml: custom.html,
          customCss: custom.css,
          customJs: custom.js,
        }),
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

      {/* Two views of one decision, so neither is scrolled past to reach the
          other: arrange on one tab, see the result on the next. */}
      <Tabs
        label="Arrangement"
        active={view}
        onChange={setView}
        tabs={[
          { id: 'order', label: 'Order' },
          ...(density === 'custom' ? [{ id: 'document', label: 'Document' }] : []),
          { id: 'preview', label: 'Preview' },
        ]}
      >
        {view === 'document' && custom && (
          <CustomDocumentEditor value={custom} onChange={setCustom} />
        )}
        {view === 'preview' && <LayoutPreview slug={slug} density={density} order={order} />}
        {view === 'order' && (
          <div>
            <p
              style={{
                margin: '0 0 var(--space-3)',
                fontSize: 'var(--text-sm)',
                color: 'var(--color-fg-subtle)',
              }}
            >
              Drag a component, or use the arrows — both do the same thing, and the arrows work
              without a mouse.
            </p>

            {order.length === 0 ? (
              <EmptyState
                title="Nothing to arrange yet"
                hint="Create a control and it will appear here."
              />
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={onDragEnd}
              >
                <SortableContext
                  items={order.map((c) => c.id)}
                  strategy={verticalListSortingStrategy}
                >
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
        )}
      </Tabs>

      {canWrite && (
        <div className="form-actions">
          {dirty && (
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)' }}>
              Unsaved changes
            </span>
          )}
          <Button
            variant="primary"
            busy={save.isPending}
            disabled={!dirty}
            onClick={() => save.mutate()}
          >
            Save layout
          </Button>
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

  // The draft travels in the URL, so the frame shows the arrangement being
  // edited rather than the one last saved. A preview that ignored the choice
  // being made previewed nothing.
  const src = `/s/${slug}?preview=1&layout=${density}&order=${order.map((c) => c.id).join(',')}`

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
        The real page, not a drawing of it — so it cannot drift from what visitors get. It follows
        the choices above before they are saved; visitors see the saved one.
      </p>

      <div
        style={
          width === 'phone'
            ? {
                // A handset shell, so the phone case reads as a phone rather
                // than as a narrow browser. Drawn rather than imaged: an image
                // of a device would need updating every time hardware changes,
                // and would not follow the theme.
                width: 'fit-content',
                // The shell is 390 plus its bezel — wider than the screen of
                // the very device it draws. Capped here rather than shrunk
                // below, so on a desktop it stays exactly 390 and on a phone
                // it previews at whatever width there is instead of pushing
                // the admin sideways.
                maxWidth: '100%',
                boxSizing: 'border-box',
                padding: 12,
                borderRadius: 44,
                background: 'var(--color-fg)',
                boxShadow: 'var(--shadow-card)',
                position: 'relative',
              }
            : {
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                overflow: 'hidden',
                background: 'var(--color-surface)',
              }
        }
      >
        {width === 'phone' && (
          // The island, purely so the top of the frame is not a blank bar.
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: 22,
              left: '50%',
              transform: 'translateX(-50%)',
              width: 86,
              height: 22,
              borderRadius: 999,
              background: 'var(--color-fg)',
              zIndex: 1,
            }}
          />
        )}
        <iframe
          // Keyed by the draft: changing the density or the order remounts the
          // frame, which is the whole point of it being here.
          key={src}
          title="Public page preview"
          src={src}
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
            width: width === 'phone' ? 'min(390px, 100%)' : '100%',
            height: width === 'phone' ? 700 : 520,
            border: 0,
            // The screen's own radius, inside the shell's.
            borderRadius: width === 'phone' ? 32 : 0,
            background: 'var(--color-bg)',
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
/**
 * Three editors for one document.
 *
 * Plain textareas rather than a code editor: pulling in CodeMirror for three
 * fields is a megabyte of dependency for syntax colouring, and the thing an
 * operator writes here is usually pasted from somewhere that already had one.
 *
 * The note above them is not decoration. Somebody arriving at a box marked
 * "JavaScript" on a public status page deserves to be told, in the place they
 * are typing, exactly how far it reaches.
 */
function CustomDocumentEditor({
  value,
  onChange,
}: {
  value: { html: string; css: string; js: string }
  onChange: (next: { html: string; css: string; js: string }) => void
}) {
  const set = (key: 'html' | 'css' | 'js') => (next: string) => onChange({ ...value, [key]: next })

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <Banner tone="maintenance">
        This document renders in a sandboxed frame with no access to the page around it: no cookies,
        no session, no network. It is handed the status data through <code>tern.onUpdate(fn)</code>{' '}
        and cannot fetch anything, which is what makes running your script here safe rather than
        reckless. It arranges pixels; it cannot reach anything else.
      </Banner>

      <Field
        label="HTML"
        hint="The body of the document. Give the elements your script will fill ids or classes."
      >
        <Textarea
          value={value.html}
          rows={12}
          spellCheck={false}
          placeholder={'<div class="wall">\n  <div id="components"></div>\n</div>'}
          onChange={(e) => set('html')(e.target.value)}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}
        />
      </Field>

      <Field label="CSS" hint="Applies inside the frame only. Nothing here can affect the admin.">
        <Textarea
          value={value.css}
          rows={12}
          spellCheck={false}
          placeholder={'.wall { display: grid; grid-template-columns: repeat(4, 1fr); }'}
          onChange={(e) => set('css')(e.target.value)}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}
        />
      </Field>

      <Field
        label="JavaScript"
        hint="Runs on every refresh of the data. tern.data holds the latest summary."
      >
        <Textarea
          value={value.js}
          rows={12}
          spellCheck={false}
          placeholder={
            'tern.onUpdate(function (data) {\n' +
            "  document.getElementById('components').textContent =\n" +
            "    data.components.map(function (c) { return c.name + ': ' + c.status }).join('\\n')\n" +
            '})'
          }
          onChange={(e) => set('js')(e.target.value)}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}
        />
      </Field>

      <details>
        <summary style={{ cursor: 'pointer', fontSize: 'var(--text-sm)', fontWeight: 600 }}>
          What the document is given
        </summary>
        <CodeBlock label="tern.data">
          {`{
  overall:      { status, affectedCount },
  groups:       [{ id, parentId, name, position, status }],
  components:   [{ id, key, name, description, groupId, status,
                   latencyMs, value, valueUnit, valueLabel, lastCheckAt }],
  incidents:    [{ id, title, severity, status, startedAt,
                   latestUpdate: { status, body, createdAt } | null, impacts }],
  maintenances: [{ id, title, body, status,
                   scheduledStart, scheduledEnd, controlIds }],
  generatedAt:  string
}`}
        </CodeBlock>
      </details>
    </div>
  )
}

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

import { useEffect, useMemo, useRef, useState } from 'react'
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
import { defaultBlocks, parseBlocks, type Block } from '@tern/shared/blocks'
import { starterStylesheet } from '@tern/shared/custom-style'
import { adminApi, ApiError, type Control } from '../../lib/adminApi'
import { BlockCanvas } from '../../features/layout-builder/BlockCanvas'
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
    hint: 'You arrange the whole page — header, ring, components. The densities stop applying.',
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
  const [css, setCss] = useState<string | null>(null)
  const [design, setDesign] = useState<Block[] | null>(null)

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
  // starts from an empty stylesheet rather than from whatever the last one was.
  useEffect(() => {
    if (summary.data && css === null) setCss(summary.data.tenant.custom?.css ?? '')
  }, [summary.data, css])

  // Parsed block by block rather than trusted: the column is JSON, and a page
  // arranged by another version should degrade to the blocks this build can
  // read rather than crash the screen that would let someone fix it.
  useEffect(() => {
    if (summary.data && design === null) setDesign(parseBlocks(summary.data.tenant.customBlocks))
  }, [summary.data, design])

  /*
   * An empty canvas is where this mode used to leave everybody.
   *
   * `custom` is the whole page now, so nothing placed means nothing drawn —
   * and the way forward from a blank grid was to rebuild, block by block, the
   * page you already had. Nobody does that to find out whether the mode is
   * worth using. So arriving here with nothing arranged fills the draft with
   * the default page expressed as blocks: your page, now movable.
   *
   * Once, guarded by a ref rather than by the emptiness itself: an operator who
   * deliberately clears the canvas must not have it written back under their
   * hands on the next render. Nothing is saved until they save.
   */
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current || design === null || density !== 'custom') return
    seeded.current = true
    if (design.length > 0) return
    setDesign(defaultBlocks())
  }, [design, density])

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
        // `list` and returned should find their page where they left it.
        ...(css !== null && { customCss: css }),
        ...(design && { customBlocks: design }),
      }),
    onSuccess: async () => {
      setError(null)
      setSaved(true)
      await queryClient.invalidateQueries({ queryKey: ['controls', slug] })
      await queryClient.invalidateQueries({ queryKey: ['summary', slug] })
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  })

  /*
   * Everything this screen can change, not just the two it used to watch.
   *
   * The density and the order were the whole of it once. Then the canvas and
   * the stylesheet arrived and were left out, so moving a block or writing a
   * rule left "Save layout" disabled — the one screen where the work is done by
   * dragging was the one that would not admit anything had happened. Compared
   * against what the server served rather than against a snapshot, so undoing
   * an edit by hand goes back to clean.
   */
  const dirty = useMemo(() => {
    if (!controls.data || !order || !summary.data || !density) return false
    const tenant = summary.data.tenant
    const original = [...controls.data].sort((a, b) => a.position - b.position)
    const storedBlocks = parseBlocks(tenant.customBlocks)
    return (
      density !== tenant.layout ||
      original.some((control, index) => control.id !== order[index]?.id) ||
      (css !== null && css !== (tenant.custom?.css ?? '')) ||
      (design !== null && JSON.stringify(design) !== JSON.stringify(storedBlocks))
    )
  }, [controls.data, order, summary.data, density, css, design])

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
                  // Design and Style only exist under `custom`. Leaving it while
                  // one of them is open left the strip with nothing selected and
                  // an empty panel under it — the tab had gone, the state
                  // pointing at it had not.
                  if (option.id !== 'custom' && (view === 'design' || view === 'style')) {
                    setView('order')
                  }
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
          ...(density === 'custom'
            ? [
                { id: 'design', label: 'Design' },
                { id: 'style', label: 'Style' },
              ]
            : []),
          { id: 'preview', label: 'Preview' },
        ]}
      >
        {view === 'design' && design && (
          <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
            <p
              className="measure"
              style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)' }}
            >
              This is the whole page, not a panel in it: the header, the status ring, the subscribe
              box and your components are all blocks here, on a twelve-column grid. Design decides
              what is on the page and where; Style decides what it looks like.
            </p>
            <BlockCanvas blocks={design} controls={controls.data ?? []} onChange={setDesign} />
          </div>
        )}
        {view === 'style' && css !== null && (
          <CustomStyleEditor
            value={css}
            pageName={summary.data?.tenant.name ?? 'Status'}
            onChange={setCss}
          />
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
            /*
             * The desktop preview takes the height it can get.
             *
             * It was a fixed 520px, which on a laptop showed three components
             * of a twelve-component page and on a large display left half the
             * screen empty — the one view whose job is showing the arrangement,
             * showing the least of it. Floored so a short window still gets a
             * usable frame, capped so it does not outgrow the page around it.
             * The phone keeps its own height: that number is the device.
             */
            height: width === 'phone' ? 700 : 'max(26rem, min(78vh, 60rem))',
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

/**
 * One editor, for the page's own stylesheet.
 *
 * This was three boxes — HTML, CSS and a script — rendered in a sandboxed frame
 * embedded in TERN's page. Two things were wrong with that, and they compounded:
 * a frame confined enough to be safe could not reach the component widgets, so
 * it redrew the charts approximately; and being a frame, it was a rectangle
 * *inside* the page rather than the page, which is exactly the complaint that
 * `custom` only ever changed a sub-part of it.
 *
 * The Design tab answers the arrangement half properly. What was left of the
 * document was the styling, and styling does not need a sandbox to be styling.
 * So: one stylesheet, applied to the real page, addressing the real elements.
 *
 * A plain textarea rather than a code editor: pulling in CodeMirror for one
 * field is a megabyte of dependency for syntax colouring, and what an operator
 * writes here is usually pasted from somewhere that already had one.
 */
function CustomStyleEditor({
  value,
  pageName,
  onChange,
}: {
  value: string
  pageName: string
  onChange: (next: string) => void
}) {
  const empty = value.trim() === ''

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <Banner tone="maintenance">
        This stylesheet applies to your public page and nowhere else — not to this admin, and not to
        anybody else&rsquo;s page. It styles what the Design tab placed; it cannot add or remove
        anything. Your incidents, the theme controls and the TERN credit stay visible whatever this
        says.
      </Banner>

      {/* The way back to something that works — for whoever cleared the box, or
          styled themselves into a page that no longer reads. It is the same
          text the demo runs, so what it produces is already known. Nothing is
          written until Save, here as everywhere on this screen. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
        }}
      >
        <Button onClick={() => onChange(starterStylesheet(pageName))}>
          {empty ? 'Start from the example' : 'Replace with the example'}
        </Button>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}>
          The stylesheet the demo runs — a palette, a width and a card shadow, commented. Overwrites
          the field.
        </span>
      </div>

      <Field
        label="CSS"
        hint="Applied to the public page, after ours. Target the blocks by what they are, not by our markup."
      >
        <Textarea
          value={value}
          rows={20}
          spellCheck={false}
          placeholder={'[data-tern="page"] { --color-accent: #2f6feb; }'}
          onChange={(e) => onChange(e.target.value)}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}
        />
      </Field>

      <details>
        <summary style={{ cursor: 'pointer', fontSize: 'var(--text-sm)', fontWeight: 600 }}>
          What you can select
        </summary>
        <CodeBlock label="Selectors">
          {`[data-tern="page"]         the page itself — set --color-accent,
                          --radius-md, max-width here
[data-tern="header"]       your logo and the page name
[data-tern="pulse"]        the status ring
[data-tern="subscribe"]    the subscribe box
[data-tern="incidents"]    incidents and maintenance notes
[data-tern="components"]   the component cards
[data-tern="control"]      a single placed component
[data-tern="text"]         a heading or paragraph block
[data-tern="image"]        an image block
[data-tern="arrangement"]  the twelve-column grid itself

.page-note                 one incident or maintenance note
.page-group                one group of components`}
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

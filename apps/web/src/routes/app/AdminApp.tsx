import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminApi, ApiError, type Control } from '../../lib/adminApi'
import { Banner, Button, Card, CodeBlock, EmptyState, Field, Input } from '../../components/ui'
import { TernWordmark } from '../../components/brand/TernMark'
import { ThemePicker } from '../../components/ThemePicker'
import { accentById, applyAccent } from '../../lib/accents'
import { ScriptTabs } from '../../features/control-editor/ScriptTabs'
import { PreviewStep } from '../../features/control-editor/PreviewStep'
import * as Icons from 'lucide-react'
import { DEFAULT_WIDGET, resolveOptions, widgetById } from '../../charts/registry'
import type { CheckStatusValue } from '@tern/shared/status'
import { api } from '../../lib/api'
import { LayoutScreen } from './LayoutScreen'
import { FleetScreen } from './FleetScreen'
import { OptionsScreen } from './OptionsScreen'
import { PlatformScreen } from './PlatformScreen'

/**
 * The admin surface.
 *
 * A rail on a wide screen, a row of tabs on a narrow one — one navigation, two
 * shapes. Below 1024px the rail would eat a third of the width; above it, a
 * horizontal tab strip wastes the height it sits in and pushes the work down
 * the page.
 *
 * The content is no longer capped at 64rem. That cap made every screen a column
 * down the middle of a 1440px display with two empty margins, and the screens
 * that suffer most from it — the fleet, the layout editor, the capacity table —
 * are exactly the ones with something to put there. Long prose still gets a
 * measure, per screen, where a full-width paragraph would be unreadable.
 *
 * An outage is sometimes handled from a phone on a train, so nothing here
 * depends on the wide case working.
 */
export function AdminApp({ slug }: { slug: string }) {
  const me = useQuery({ queryKey: ['me'], queryFn: adminApi.me, retry: false })
  const [section, setSection] = useSection(slug)

  // The tenant's accent, applied to its admin as well as its page: an operator
  // switching between two tenants should see which one they are in.
  const summary = useQuery({
    queryKey: ['summary', slug],
    queryFn: () => api.summary(slug),
    retry: false,
  })
  const accentId = (summary.data?.tenant.branding as Record<string, unknown> | undefined)?.accent
  useEffect(() => {
    applyAccent(accentById(typeof accentId === 'string' ? accentId : undefined))
  }, [accentId])

  if (me.isPending) return <Centered>Loading…</Centered>
  if (me.isError) return <LoginScreen onSignedIn={() => void me.refetch()} />

  const membership = me.data.memberships.find((m) => m.slug === slug)
  if (!membership) {
    return (
      <Centered>
        <Banner tone="down">You are signed in, but not a member of “{slug}”.</Banner>
      </Centered>
    )
  }

  const canWrite = membership.role === 'admin'

  return (
    <div className="admin-shell">
      <aside className="admin-rail">
        <div className="admin-brand">
          <TernWordmark size={24} />
          <p className="admin-tenant">
            {membership.name}
            <span>{membership.role}</span>
          </p>
        </div>

        <AdminNav
          slug={slug}
          section={section}
          onNavigate={setSection}
          isSystem={membership.isSystem === true}
        />

        <div className="admin-rail-foot" style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <ThemePicker />
          <Button
            onClick={() => {
              void adminApi.logout().then(() => window.location.reload())
            }}
          >
            Sign out
          </Button>
        </div>
      </aside>

      <main className="admin-main">
        {section === 'layout' ? (
          <LayoutScreen slug={slug} canWrite={canWrite} />
        ) : section === 'agents' ? (
          <FleetScreen slug={slug} canWrite={canWrite} />
        ) : section === 'options' ? (
          <OptionsScreen slug={slug} canWrite={canWrite} />
        ) : section === 'platform' ? (
          <PlatformScreen />
        ) : (
          <ControlsScreen slug={slug} canWrite={canWrite} />
        )}
      </main>
    </div>
  )
}

// ── Navigation ──────────────────────────────────────────────────────────────

const SECTIONS = [
  { id: 'controls', label: 'Controls' },
  { id: 'layout', label: 'Page layout' },
  { id: 'agents', label: 'Agents' },
  { id: 'options', label: 'Options' },
  { id: 'platform', label: 'Platform' },
] as const

type Section = (typeof SECTIONS)[number]['id']

/**
 * Two sections, and the URL says which one.
 *
 * A router library would be more machinery than this needs, but the address bar
 * still has to be right: /app/acme/layout must be linkable, reloadable, and the
 * browser's back button must work. That is `pushState` plus `popstate`, not a
 * piece of component state pretending to be a route.
 */
function sectionFromPath(pathname: string, slug: string): Section {
  const rest = pathname.replace(`/app/${slug}`, '').replace(/^\//, '')
  return SECTIONS.find((s) => s.id === rest)?.id ?? 'controls'
}

function useSection(slug: string): [Section, (next: Section) => void] {
  const read = (): Section => sectionFromPath(window.location.pathname, slug)

  const [section, setSection] = useState<Section>(read)

  useEffect(() => {
    // Re-read the path on popstate rather than closing over `read`, so the
    // listener has no stale slug and the effect needs no dependency on it.
    const onPop = () => setSection(sectionFromPath(window.location.pathname, slug))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [slug])

  const navigate = (next: Section) => {
    window.history.pushState({}, '', next === 'controls' ? `/app/${slug}` : `/app/${slug}/${next}`)
    setSection(next)
  }

  return [section, navigate]
}

function AdminNav({
  slug,
  section,
  onNavigate,
  isSystem,
}: {
  slug: string
  section: Section
  onNavigate: (next: Section) => void
  /** Only the instance's own tenant supervises the instance. */
  isSystem: boolean
}) {
  return (
    <nav aria-label="Sections" className="admin-nav">
      {SECTIONS.filter((entry) => entry.id !== 'platform' || isSystem).map((entry) => {
        const current = entry.id === section
        return (
          <a
            key={entry.id}
            href={entry.id === 'controls' ? `/app/${slug}` : `/app/${slug}/${entry.id}`}
            // A real link, so it can be opened in a new tab and read by anything
            // that harvests links — the click handler only avoids the reload.
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey) return
              event.preventDefault()
              onNavigate(entry.id)
            }}
            aria-current={current ? 'page' : undefined}
            className={current ? 'admin-nav-item is-current' : 'admin-nav-item'}
          >
            {entry.label}
          </a>
        )
      })}
    </nav>
  )
}

// ── Controls ────────────────────────────────────────────────────────────────

function ControlsScreen({ slug, canWrite }: { slug: string; canWrite: boolean }) {
  const queryClient = useQueryClient()
  const controls = useQuery({
    queryKey: ['controls', slug],
    queryFn: () => adminApi.controls(slug),
  })
  const [editing, setEditing] = useState<Control | 'new' | null>(null)

  if (controls.isPending) return <Centered>Loading controls…</Centered>
  if (controls.isError) return <Banner tone="down">Could not load controls.</Banner>

  if (editing) {
    return (
      <ControlEditor
        slug={slug}
        control={editing === 'new' ? null : editing}
        onDone={() => {
          setEditing(null)
          void queryClient.invalidateQueries({ queryKey: ['controls', slug] })
        }}
      />
    )
  }

  return (
    <section style={{ paddingTop: 'var(--space-6)' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 'var(--space-4)',
          gap: 'var(--space-3)',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 'var(--text-xl)' }}>Controls</h1>
        {canWrite && (
          <Button variant="primary" onClick={() => setEditing('new')}>
            New control
          </Button>
        )}
      </div>

      {controls.data.length === 0 ? (
        <EmptyState
          title="No controls yet"
          hint="A control is one thing you monitor. Create one and TERN will hand you a script that pushes to it."
          action={
            canWrite ? (
              <Button variant="primary" onClick={() => setEditing('new')}>
                Create the first control
              </Button>
            ) : undefined
          }
        />
      ) : (
        /*
         * A grid rather than a stack. Twenty controls in a single column on a
         * 1440px display is one line of text per screen-inch and two empty
         * thirds; a card can carry what the row could not — the widget, the
         * probe kind, whether it is public — without any of them becoming a
         * column that has to be maintained.
         */
        <div className="card-grid">
          {controls.data.map((control) => (
            <ControlCard
              key={control.id}
              control={control}
              canWrite={canWrite}
              onEdit={() => setEditing(control)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function ControlCard({
  control,
  canWrite,
  onEdit,
}: {
  control: Control
  canWrite: boolean
  onEdit: () => void
}) {
  const widget = widgetById(control.widget)

  return (
    <Card>
      <div
        style={{
          display: 'grid',
          gap: 'var(--space-2)',
          height: '100%',
          // The footer bleeds to the card's edge, so the card owns its padding
          // rather than the content inside it.
          overflow: 'hidden',
          borderRadius: 'var(--radius-md)',
        }}
      >
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
          <strong style={{ flex: 1, minWidth: 0 }}>{control.name}</strong>
          {/* State as a word, never as a colour alone — and only when it is not
              the default, so the eye lands on the exceptions. */}
          {!control.isPublic && <Tag>internal</Tag>}
          {!control.enabled && <Tag tone="down">disabled</Tag>}
          {canWrite && <Button onClick={onEdit}>Edit</Button>}
        </div>

        <code
          className="tabular"
          style={{ fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}
        >
          {control.key}
        </code>

        {control.description && (
          <p
            style={{
              margin: 0,
              fontSize: 'var(--text-sm)',
              color: 'var(--color-fg-muted)',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {control.description}
          </p>
        )}

        {/* A tinted strip rather than more white: the specs live here, each
            with an icon, so a card can be read by shape before it is read by
            word. The icons are tinted with the accent rather than given hues of
            their own — a second categorical palette beside the status one is
            how a coloured chip starts being mistaken for a state. */}
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-3)',
            flexWrap: 'wrap',
            alignItems: 'center',
            fontSize: 'var(--text-xs)',
            color: 'var(--color-fg-muted)',
            marginTop: 'auto',
            marginInline: 'calc(-1 * var(--space-4))',
            marginBottom: 'calc(-1 * var(--space-4))',
            padding: 'var(--space-3) var(--space-4)',
            background: 'var(--color-surface-raised)',
            borderTop: '1px solid var(--color-border)',
          }}
        >
          <Spec
            icon={control.kind === 'push' ? 'ArrowUpFromLine' : 'Radar'}
            label={control.kind === 'push' ? 'pushed' : `${control.kind} probe`}
          />
          <Spec icon={widget.icon} label={widget.label} />
        </div>
      </div>
    </Card>
  )
}

/** One fact about a control: an icon, and the word it stands for. */
function Spec({ icon, label }: { icon: string; label: string }) {
  const Icon = (Icons as unknown as Record<string, React.ComponentType<{ size?: number }>>)[icon]

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 22,
          height: 22,
          borderRadius: 'var(--radius-sm)',
          background: 'var(--color-accent-soft)',
          color: 'var(--color-accent-ink)',
          flexShrink: 0,
        }}
      >
        {/* Never the icon alone — the word beside it is what a screen reader
            and a colourblind reader both get. */}
        {Icon ? <Icon size={13} /> : null}
      </span>
      {label}
    </span>
  )
}

function Tag({ children, tone }: { children: React.ReactNode; tone?: 'down' }) {
  return (
    <span
      style={{
        flexShrink: 0,
        padding: '0 var(--space-2)',
        borderRadius: 'var(--radius-full)',
        border: `1px solid ${tone === 'down' ? 'var(--status-down)' : 'var(--color-border-strong)'}`,
        color: tone === 'down' ? 'var(--status-down)' : 'var(--color-fg-muted)',
        fontSize: 'var(--text-xs)',
        fontWeight: 600,
      }}
    >
      {children}
    </span>
  )
}

// ── Editor ──────────────────────────────────────────────────────────────────

const STEPS = ['Definition', 'Preview', 'Simulate', 'Script'] as const

function ControlEditor({
  slug,
  control,
  onDone,
}: {
  slug: string
  control: Control | null
  onDone: () => void
}) {
  // The tenant's retention mode decides which widgets can be fed at all. Read
  // from the public summary, which admins can see and which is already cached.
  const summary = useQuery({ queryKey: ['summary', slug], queryFn: () => api.summary(slug) })
  const retentionMode = summary.data?.tenant.retentionMode ?? 'historical'

  const [step, setStep] = useState(0)
  const [form, setForm] = useState({
    key: control?.key ?? '',
    name: control?.name ?? '',
    description: control?.description ?? '',
    degradedThresholdMs: control?.degradedThresholdMs ?? 500,
    downThresholdMs: control?.downThresholdMs ?? 3000,
    isPublic: control?.isPublic ?? true,
  })
  // The whole control, not just its id: the preview needs its key for a stable
  // sample seed, its unit to decide which widgets apply, and its current widget
  // so the gallery opens on the existing choice.
  const [savedControl, setSavedControl] = useState<Control | null>(control)
  const saved = savedControl
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        key: form.key.trim(),
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        degradedThresholdMs: form.degradedThresholdMs,
        downThresholdMs: form.downThresholdMs,
        isPublic: form.isPublic,
      }
      if (savedControl) {
        await adminApi.updateControl(slug, savedControl.id, body)
        return { ...savedControl, ...body, description: body.description ?? null }
      }
      const created = await adminApi.createControl(slug, body)
      // Compose the control locally rather than refetching: the API returned
      // the id, and everything else is what was just submitted.
      return {
        ...created,
        ...body,
        description: body.description ?? null,
        groupId: null,
        kind: 'push',
        enabled: true,
        expectedIntervalS: null,
        valueUnit: null,
        valueLabel: null,
        slaTarget: null,
        widget: DEFAULT_WIDGET,
        widgetOptions: {},
        position: 0,
      } satisfies Control
    },
    onSuccess: (result) => {
      setSavedControl(result)
      setError(null)
      setStep(1)
    },
    // The API's message is the useful one — "the degraded threshold must be
    // below the down threshold" beats a generic failure.
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  })

  return (
    <section style={{ paddingTop: 'var(--space-6)', display: 'grid', gap: 'var(--space-4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 'var(--text-xl)' }}>
          {control ? control.name : 'New control'}
        </h1>
        <Button onClick={onDone}>Back</Button>
      </div>

      {/* A step indicator, and steps past the first stay locked until the
          control exists — the later ones all need its id. */}
      <ol
        style={{
          display: 'flex',
          gap: 'var(--space-2)',
          listStyle: 'none',
          padding: 0,
          margin: 0,
          flexWrap: 'wrap',
        }}
      >
        {STEPS.map((label, index) => {
          const reachable = index === 0 || Boolean(saved)
          return (
            <li key={label}>
              <button
                onClick={() => reachable && setStep(index)}
                disabled={!reachable}
                aria-current={index === step ? 'step' : undefined}
                style={{
                  background: index === step ? 'var(--color-surface-raised)' : 'transparent',
                  border: `1px solid ${index === step ? 'var(--color-border-strong)' : 'var(--color-border)'}`,
                  color: reachable ? 'var(--color-fg)' : 'var(--color-fg-subtle)',
                  borderRadius: 'var(--radius-full)',
                  padding: '0 var(--space-3)',
                  minHeight: 36,
                  fontSize: 'var(--text-sm)',
                  fontFamily: 'inherit',
                  cursor: reachable ? 'pointer' : 'not-allowed',
                }}
              >
                {index + 1}. {label}
              </button>
            </li>
          )
        })}
      </ol>

      {error && <Banner tone="down">{error}</Banner>}

      {step === 0 && (
        <Card>
          <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
            <Field
              label="Key"
              hint="Lowercase letters, digits, dot, dash or underscore. Scripts and alerts push against this, so renaming the display name never breaks ingestion."
            >
              <Input
                value={form.key}
                onChange={(e) => setForm({ ...form, key: e.target.value })}
                placeholder="api-gateway"
                disabled={Boolean(saved)}
              />
            </Field>

            <Field label="Name">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="API gateway"
              />
            </Field>

            <Field label="Description">
              <Input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </Field>

            <div style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: '1fr 1fr' }}>
              <Field label="Degraded above (ms)">
                <Input
                  type="number"
                  value={form.degradedThresholdMs}
                  onChange={(e) =>
                    setForm({ ...form, degradedThresholdMs: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="Down above (ms)">
                <Input
                  type="number"
                  value={form.downThresholdMs}
                  onChange={(e) => setForm({ ...form, downThresholdMs: Number(e.target.value) })}
                />
              </Field>
            </div>

            <Field label="Visibility" hint="Internal controls never appear on the public page.">
              <select
                value={form.isPublic ? 'public' : 'internal'}
                onChange={(e) => setForm({ ...form, isPublic: e.target.value === 'public' })}
                style={{
                  background: 'var(--color-bg)',
                  color: 'var(--color-fg)',
                  border: '1px solid var(--color-border-strong)',
                  borderRadius: 'var(--radius-sm)',
                  padding: 'var(--space-2) var(--space-3)',
                  fontSize: 'var(--text-base)',
                  fontFamily: 'inherit',
                  minHeight: 44,
                }}
              >
                <option value="public">Public</option>
                <option value="internal">Internal</option>
              </select>
            </Field>

            <div>
              <Button
                variant="primary"
                busy={save.isPending}
                disabled={!form.key.trim() || !form.name.trim()}
                onClick={() => save.mutate()}
              >
                {saved ? 'Save changes' : 'Create and continue'}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {step === 1 && savedControl && (
        <PreviewStep
          slug={slug}
          control={savedControl}
          retentionMode={retentionMode}
          onSaved={(widget, widgetOptions) =>
            setSavedControl({ ...savedControl, widget, widgetOptions })
          }
        />
      )}
      {step === 2 && saved && <SimulateStep slug={slug} control={saved} />}
      {step === 3 && saved && <ScriptTabs slug={slug} controlId={saved.id} />}
    </section>
  )
}

function SimulateStep({ slug, control }: { slug: string; control: Control }) {
  const queryClient = useQueryClient()
  const [days, setDays] = useState(30)
  const [uptime, setUptime] = useState(0.995)
  const [result, setResult] = useState<string | null>(null)

  const controlId = control.id

  // The point of the step: seeing the widget with data in it. Read back from
  // the server rather than drawn from the generator's return value, so what is
  // shown is what was actually stored — including the shape the aggregation
  // gives it.
  const series = useQuery({
    queryKey: ['series', slug, controlId, days],
    queryFn: () => adminApi.series(slug, controlId, days),
  })

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['uptime', slug] })
    await queryClient.invalidateQueries({ queryKey: ['series', slug, controlId] })
  }

  const simulate = useMutation({
    mutationFn: () => adminApi.simulate(slug, controlId, { days, targetUptime: uptime }),
    onSuccess: (r) => {
      setResult(`${r.inserted} points generated.`)
      void refresh()
    },
  })

  const purge = useMutation({
    mutationFn: () => adminApi.purgeSimulation(slug, controlId),
    onSuccess: (r) => {
      setResult(`${r.deleted} simulation points removed.`)
      void refresh()
    },
  })

  return (
    <Card>
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <Banner tone="maintenance">
          {/* Said plainly, because the alternative is someone quietly wondering
              whether their demo is inflating a published number. */}
          Simulation data is marked separately and never counts towards published uptime. Remove it
          in one click when you are done.
        </Banner>

        <div style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: '1fr 1fr' }}>
          <Field label="Days">
            <Input
              type="number"
              min={1}
              max={90}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            />
          </Field>
          <Field label="Target uptime" hint="0.9 to 1">
            <Input
              type="number"
              step="0.001"
              min={0.5}
              max={1}
              value={uptime}
              onChange={(e) => setUptime(Number(e.target.value))}
            />
          </Field>
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <Button variant="primary" busy={simulate.isPending} onClick={() => simulate.mutate()}>
            Generate
          </Button>
          <Button variant="danger" busy={purge.isPending} onClick={() => purge.mutate()}>
            Remove simulation data
          </Button>
        </div>

        {result && <Banner tone="operational">{result}</Banner>}

        {/* ── The widget, on this control's actual data ─────────────────── */}
        <div>
          <h3 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-sm)' }}>
            {widgetById(control.widget).label}
            {series.data?.synthetic && (
              <span
                style={{
                  marginLeft: 'var(--space-2)',
                  fontSize: 'var(--text-xs)',
                  fontWeight: 600,
                  color: 'var(--status-maintenance)',
                }}
              >
                simulated data
              </span>
            )}
          </h3>

          {series.isPending ? (
            <p style={{ color: 'var(--color-fg-subtle)', margin: 0 }}>Loading the series…</p>
          ) : series.data && series.data.points.length > 0 ? (
            <SimulatedWidget control={control} points={series.data.points} />
          ) : (
            <p style={{ color: 'var(--color-fg-subtle)', margin: 0 }}>
              Nothing recorded yet. Generate a simulation and the widget will draw it.
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}

/**
 * The control's chosen widget, fed the series the server just returned.
 *
 * Rendered through the registry rather than a fixed chart, so this step answers
 * the question it is actually asked: not "is there data" but "does the widget I
 * picked look right with data in it".
 */
function SimulatedWidget({
  control,
  points,
}: {
  control: Control
  points: {
    ts: string
    status: string
    latencyMs: number | null
    value: number | null
    metrics?: Record<string, number>
  }[]
}) {
  const widget = widgetById(control.widget)
  const options = resolveOptions(widget, control.widgetOptions)

  const series = points.map((point) => ({
    ts: new Date(point.ts),
    status: point.status as CheckStatusValue,
    latencyMs: point.latencyMs,
    value: point.value,
    metrics: point.metrics,
    message: null,
  }))

  return (
    <widget.Component
      label={control.name}
      locale="en"
      timeZone="UTC"
      options={options}
      series={series}
      unit={control.valueUnit}
      valueLabel={control.valueLabel}
      warnAt={Number(options.warnAt ?? 0) || null}
      limitAt={Number(options.limitAt ?? 0) || null}
    />
  )
}

// ── Sign in ─────────────────────────────────────────────────────────────────

function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [needsMfa, setNeedsMfa] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const signIn = useMutation({
    mutationFn: async () => {
      if (needsMfa) {
        await adminApi.verifyMfa(code)
        return { mfaRequired: false }
      }
      return adminApi.login(email, password)
    },
    onSuccess: (result) => {
      setError(null)
      if (result.mfaRequired) setNeedsMfa(true)
      else onSignedIn()
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  })

  return (
    <Centered>
      <Card style={{ width: 'min(28rem, 100%)' }}>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            signIn.mutate()
          }}
          style={{ display: 'grid', gap: 'var(--space-4)' }}
        >
          <TernWordmark size={28} />

          {error && <Banner tone="down">{error}</Banner>}

          {needsMfa ? (
            <Field label="Authentication code" hint="From your authenticator app.">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
              />
            </Field>
          ) : (
            <>
              <Field label="Email">
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  autoFocus
                />
              </Field>
              <Field label="Password">
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </Field>
            </>
          )}

          <Button type="submit" variant="primary" busy={signIn.isPending}>
            {needsMfa ? 'Verify' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </Centered>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: '80dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-4)',
        padding: 'var(--space-4)',
      }}
    >
      {children}
    </div>
  )
}

export { CodeBlock }

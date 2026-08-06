import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminApi, ApiError, type Control } from '../../lib/adminApi'
import { Banner, Button, Card, CodeBlock, EmptyState, Field, Input } from '../../components/ui'
import { TernWordmark } from '../../components/brand/TernMark'
import { ScriptTabs } from '../../features/control-editor/ScriptTabs'
import { PreviewStep } from '../../features/control-editor/PreviewStep'
import { DEFAULT_WIDGET } from '../../charts/registry'
import { api } from '../../lib/api'
import { LayoutScreen } from './LayoutScreen'

/**
 * The admin surface.
 *
 * One column, one primary action per screen, tables that become cards on a
 * phone. An outage is sometimes handled from a phone on a train, so nothing
 * here depends on a wide viewport.
 */
export function AdminApp({ slug }: { slug: string }) {
  const me = useQuery({ queryKey: ['me'], queryFn: adminApi.me, retry: false })
  const [section, setSection] = useSection(slug)

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

  return (
    <div style={{ maxWidth: '64rem', margin: '0 auto', padding: 'var(--space-6) var(--space-4)' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-4)',
          flexWrap: 'wrap',
          paddingBottom: 'var(--space-4)',
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <div>
          <TernWordmark size={24} />
          <p
            style={{
              margin: 'var(--space-1) 0 0',
              fontSize: 'var(--text-sm)',
              color: 'var(--color-fg-subtle)',
            }}
          >
            {membership.name} · {membership.role}
          </p>
        </div>
        <Button
          onClick={() => {
            void adminApi.logout().then(() => window.location.reload())
          }}
        >
          Sign out
        </Button>
      </header>

      <AdminNav slug={slug} section={section} onNavigate={setSection} />

      {section === 'layout' ? (
        <LayoutScreen slug={slug} canWrite={membership.role === 'admin'} />
      ) : (
        <ControlsScreen slug={slug} canWrite={membership.role === 'admin'} />
      )}
    </div>
  )
}

// ── Navigation ──────────────────────────────────────────────────────────────

const SECTIONS = [
  { id: 'controls', label: 'Controls' },
  { id: 'layout', label: 'Page layout' },
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
function useSection(slug: string): [Section, (next: Section) => void] {
  const read = (): Section =>
    window.location.pathname.startsWith(`/app/${slug}/layout`) ? 'layout' : 'controls'

  const [section, setSection] = useState<Section>(read)

  useEffect(() => {
    // Re-read the path on popstate rather than closing over `read`, so the
    // listener has no stale slug and the effect needs no dependency on it.
    const onPop = () =>
      setSection(window.location.pathname.startsWith(`/app/${slug}/layout`) ? 'layout' : 'controls')
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
}: {
  slug: string
  section: Section
  onNavigate: (next: Section) => void
}) {
  return (
    <nav
      aria-label="Sections"
      style={{
        display: 'flex',
        gap: 'var(--space-2)',
        paddingTop: 'var(--space-4)',
        flexWrap: 'wrap',
      }}
    >
      {SECTIONS.map((entry) => {
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
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              minHeight: 44,
              padding: '0 var(--space-4)',
              borderRadius: 'var(--radius-sm)',
              border: `1px solid ${current ? 'var(--color-accent)' : 'var(--color-border)'}`,
              background: current ? 'var(--color-surface-raised)' : 'transparent',
              color: 'var(--color-fg)',
              textDecoration: 'none',
              fontSize: 'var(--text-sm)',
              fontWeight: 600,
            }}
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
        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          {controls.data.map((control) => (
            <Card key={control.id}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 'var(--space-3)',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <strong>{control.name}</strong>
                  <div
                    className="tabular"
                    style={{ fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}
                  >
                    {control.key} · {control.kind}
                    {!control.isPublic && ' · internal'}
                    {!control.enabled && ' · disabled'}
                  </div>
                </div>
                {/* A visible button, not an action hidden behind hover — there
                    is no hover on a phone. */}
                {canWrite && <Button onClick={() => setEditing(control)}>Edit</Button>}
              </div>
            </Card>
          ))}
        </div>
      )}
    </section>
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
      {step === 2 && saved && <SimulateStep slug={slug} controlId={saved.id} />}
      {step === 3 && saved && <ScriptTabs slug={slug} controlId={saved.id} />}
    </section>
  )
}

function SimulateStep({ slug, controlId }: { slug: string; controlId: string }) {
  const queryClient = useQueryClient()
  const [days, setDays] = useState(30)
  const [uptime, setUptime] = useState(0.995)
  const [result, setResult] = useState<string | null>(null)

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['uptime', slug] })

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
      </div>
    </Card>
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

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { adminApi, ApiError } from '../../lib/adminApi'
import { Banner, Button, Card, CodeBlock, Field, Input } from '../../components/ui'
import { TernWordmark } from '../../components/brand/TernMark'
import { ACCENTS, SEPARATION_FLOOR, accentById, applyAccent } from '../../lib/accents'
import { Choice } from '../../routes/app/OptionsScreen'
import { SiteFooter } from '../../components/SiteFooter'

/**
 * What an admin sees the first time they open a tenant nobody has configured.
 *
 * It exists because the alternative is a screen of empty tables and a rail of
 * six sections, none of which says which one to open first. The wizard asks the
 * four questions that have no sensible default — what this page is called, who
 * may read it, what it looks like, and what it measures — and then gets out of
 * the way for good.
 *
 * Every step writes through the endpoints the Options screen already uses. It
 * is a path through the product, not a second way to configure it, so nothing
 * here can drift from what the settings screens do.
 *
 * It can be left at any point. A wizard that holds an operator hostage until
 * they have answered everything is one they will click through without reading,
 * and the tenant is usable after step one.
 */

const STEPS = ['Identity', 'Appearance', 'First control', 'Done'] as const

export function SetupWizard({
  slug,
  tenantName,
  onFinished,
}: {
  slug: string
  tenantName: string
  onFinished: () => void
}) {
  const queryClient = useQueryClient()
  const [step, setStep] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const [name, setName] = useState(tenantName)
  const [visibility, setVisibility] = useState<'public' | 'private'>('private')
  const [accent, setAccent] = useState(ACCENTS[0]!.id)
  const [timezone, setTimezone] = useState(
    // The browser already knows, and asking someone to type "Europe/Paris" when
    // their machine could have said it is a question with a known answer.
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  )
  const [locale, setLocale] = useState(navigator.language.slice(0, 2) || 'en')

  const [controlKey, setControlKey] = useState('')
  const [controlName, setControlName] = useState('')
  const [created, setCreated] = useState<{ id: string; key: string } | null>(null)

  const saveIdentity = useMutation({
    mutationFn: () => adminApi.updateSettings(slug, { name: name.trim(), visibility }),
    onSuccess: () => setStep(1),
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  })

  const saveAppearance = useMutation({
    mutationFn: () =>
      adminApi.updateSettings(slug, {
        accent,
        defaultLocale: locale,
        defaultTimezone: timezone,
      }),
    onSuccess: () => setStep(2),
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  })

  const createControl = useMutation({
    mutationFn: () =>
      adminApi.createControl(slug, {
        key: controlKey.trim(),
        name: controlName.trim() || controlKey.trim(),
      }),
    onSuccess: (control) => {
      setCreated(control)
      setStep(3)
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  })

  /**
   * Marks the tenant configured.
   *
   * Called by "finish" and by "skip" alike — the wizard's job is to be offered
   * once, and someone who declined it has answered the question it was asking.
   */
  const finish = useMutation({
    mutationFn: () => adminApi.updateSettings(slug, { setupCompleted: true }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['summary', slug] })
      await queryClient.invalidateQueries({ queryKey: ['settings', slug] })
      await queryClient.invalidateQueries({ queryKey: ['controls', slug] })
      onFinished()
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  })

  const busy =
    saveIdentity.isPending ||
    saveAppearance.isPending ||
    createControl.isPending ||
    finish.isPending

  return (
    <main className="landing">
      <div className="landing-image" role="img" aria-label="A tern over the sea" />

      <div className="landing-panel">
        <Card style={{ width: 'min(34rem, 100%)' }}>
          <div style={{ textAlign: 'center', marginBottom: 'var(--space-4)' }}>
            <TernWordmark size={34} />
            <h1
              style={{
                margin: 'var(--space-3) 0 0',
                fontSize: 'var(--text-xl)',
                color: 'var(--color-fg)',
              }}
            >
              Set up {tenantName}
            </h1>
          </div>

          <Steps current={step} />

          <div style={{ display: 'grid', gap: 'var(--space-4)', marginTop: 'var(--space-5)' }}>
            {error && <Banner tone="down">{error}</Banner>}

            {step === 0 && (
              <>
                <Explain>
                  Two things nobody can choose for you: what this page is called, and who is allowed
                  to read it.
                </Explain>

                <Field label="Name" hint="Shown at the top of the public page.">
                  <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                </Field>

                <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  <Choice
                    selected={visibility === 'private'}
                    label="Private"
                    hint="Members only. Everyone else gets a 404, not a 403."
                    onSelect={() => setVisibility('private')}
                  />
                  <Choice
                    selected={visibility === 'public'}
                    label="Public"
                    hint="Anyone with the link can read it."
                    onSelect={() => setVisibility('public')}
                  />
                </div>

                {/* Private is the default here, and stays selected unless it is
                    changed on purpose. A page that goes public because somebody
                    clicked through a wizard is the one mistake this screen must
                    not make on their behalf. */}
                <Actions>
                  <Button onClick={() => finish.mutate()} busy={finish.isPending}>
                    Skip setup
                  </Button>
                  <Button
                    variant="primary"
                    busy={saveIdentity.isPending}
                    disabled={name.trim() === '' || busy}
                    onClick={() => {
                      setError(null)
                      saveIdentity.mutate()
                    }}
                  >
                    Continue
                  </Button>
                </Actions>
              </>
            )}

            {step === 1 && (
              <>
                <Explain>
                  The accent colours buttons and links. The short list is arithmetic rather than
                  taste — every colour here is far enough from the status palette that a button
                  cannot be misread as a service state.
                </Explain>

                <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  {ACCENTS.filter((option) => option.separation >= SEPARATION_FLOOR).map(
                    (option) => (
                      <Choice
                        key={option.id}
                        selected={accent === option.id}
                        label={option.label}
                        hint={`Clear of every status colour (ΔE ${option.separation})`}
                        onSelect={() => {
                          setAccent(option.id)
                          // Applied at once: a colour you have to save to see is
                          // one you cannot compare.
                          applyAccent(accentById(option.id))
                        }}
                      />
                    ),
                  )}
                </div>

                <div className="facts">
                  <Field label="Language" hint="For a reader whose browser says nothing useful.">
                    <Input value={locale} onChange={(e) => setLocale(e.target.value)} />
                  </Field>
                  <Field label="Time zone" hint="Taken from this machine. An IANA name.">
                    <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
                  </Field>
                </div>

                <Actions>
                  <Button onClick={() => setStep(0)}>Back</Button>
                  <Button
                    variant="primary"
                    busy={saveAppearance.isPending}
                    disabled={busy}
                    onClick={() => {
                      setError(null)
                      saveAppearance.mutate()
                    }}
                  >
                    Continue
                  </Button>
                </Actions>
              </>
            )}

            {step === 2 && (
              <>
                <Explain>
                  A control is one thing you monitor. Create one now and the next step hands you the
                  command that pushes to it — the shortest path from an empty page to a page with
                  something on it.
                </Explain>

                <Field
                  label="Key"
                  hint="How your scripts address it. Lowercase, no spaces — api, db-eu-west."
                >
                  <Input
                    value={controlKey}
                    onChange={(e) =>
                      setControlKey(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))
                    }
                    placeholder="api"
                    autoFocus
                  />
                </Field>

                <Field label="Name" hint="What a reader sees. Defaults to the key.">
                  <Input
                    value={controlName}
                    onChange={(e) => setControlName(e.target.value)}
                    placeholder="Public API"
                  />
                </Field>

                <Actions>
                  <Button onClick={() => setStep(3)}>Not now</Button>
                  <Button
                    variant="primary"
                    busy={createControl.isPending}
                    disabled={controlKey.trim() === '' || busy}
                    onClick={() => {
                      setError(null)
                      createControl.mutate()
                    }}
                  >
                    Create it
                  </Button>
                </Actions>
              </>
            )}

            {step === 3 && (
              <>
                <Banner tone="operational">{tenantName} is ready.</Banner>

                {created ? (
                  <>
                    <Explain>
                      Push a measurement to <code>{created.key}</code> and it appears on the page.
                      The Controls screen carries the same snippet for every language it supports.
                    </Explain>
                    <CodeBlock>{pushExample(slug, created.key)}</CodeBlock>
                  </>
                ) : (
                  <Explain>
                    No controls yet — the Controls screen is where you add the first one, and it
                    hands you a script that pushes to it.
                  </Explain>
                )}

                <Explain>
                  {visibility === 'public' ? (
                    <>
                      The page is live at <code>/s/{slug}</code>.
                    </>
                  ) : (
                    <>
                      The page is private: <code>/s/{slug}</code> answers 404 to anyone who is not a
                      member. Options → General is where that changes.
                    </>
                  )}
                </Explain>

                <Actions>
                  <Button
                    variant="primary"
                    busy={finish.isPending}
                    disabled={busy}
                    onClick={() => {
                      setError(null)
                      finish.mutate()
                    }}
                  >
                    Open the admin
                  </Button>
                </Actions>
              </>
            )}
          </div>
        </Card>

        <SiteFooter compact />
      </div>
    </main>
  )
}

/** The push call, with the tenant and control already filled in. */
function pushExample(slug: string, key: string): string {
  return `curl -X POST ${window.location.origin}/api/v1/${slug}/ingest \\
  -H 'authorization: Bearer <your-api-key>' \\
  -H 'content-type: application/json' \\
  -d '{"key":"${key}","status":"operational","latencyMs":42}'`
}

/**
 * Where you are, and how much is left.
 *
 * Numbered and named, not a bare progress bar: "step 2 of 4" answers how far,
 * and the words answer what is coming — which is the question that decides
 * whether someone abandons a form.
 */
function Steps({ current }: { current: number }) {
  return (
    <ol
      style={{
        display: 'flex',
        listStyle: 'none',
        margin: 0,
        padding: 0,
        gap: 'var(--space-2)',
        flexWrap: 'wrap',
        justifyContent: 'center',
      }}
    >
      {STEPS.map((label, index) => {
        const done = index < current
        const here = index === current
        return (
          <li
            key={label}
            aria-current={here ? 'step' : undefined}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              padding: '0 var(--space-2)',
              minHeight: 28,
              borderRadius: 'var(--radius-full)',
              border: `1px solid ${here ? 'var(--color-accent)' : 'var(--color-border)'}`,
              background: here ? 'var(--color-accent-soft)' : 'transparent',
              color: here ? 'var(--color-accent-ink)' : 'var(--color-fg-subtle)',
              fontSize: 'var(--text-xs)',
              fontWeight: 600,
            }}
          >
            {done ? <Check size={12} aria-hidden="true" /> : `${index + 1}.`}
            {label}
          </li>
        )
      })}
    </ol>
  )
}

function Explain({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="measure"
      style={{
        margin: 0,
        fontSize: 'var(--text-sm)',
        color: 'var(--color-fg-subtle)',
        lineHeight: 1.6,
      }}
    >
      {children}
    </p>
  )
}

function Actions({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        gap: 'var(--space-2)',
        flexWrap: 'wrap',
        marginTop: 'var(--space-2)',
      }}
    >
      {children}
    </div>
  )
}

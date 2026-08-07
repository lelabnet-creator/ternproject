import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminApi, ApiError, type TenantSettingsPatch } from '../../lib/adminApi'
import { Tabs } from '../../components/Tabs'
import { ACCENTS, SEPARATION_FLOOR, accentById, applyAccent } from '../../lib/accents'
import { Banner, Button, Card, Field, Input } from '../../components/ui'
import { NotificationsPanels } from '../../features/settings/NotificationsPanels'
import { CapacityPanel } from '../../features/settings/CapacityPanel'
import { DangerPanel } from '../../features/settings/DangerPanel'
import { PasskeysPanel } from '../../features/settings/PasskeysPanel'

/**
 * Everything about a tenant that is a setting rather than a decision.
 *
 * Three tabs, not three screens in the rail: these are visited rarely and
 * together, and a navigation that grows one entry per settings group is a
 * navigation nobody scans any more.
 */
export function OptionsScreen({ slug, canWrite }: { slug: string; canWrite: boolean }) {
  const [tab, setTab] = useState('general')

  return (
    <section style={{ paddingTop: 'var(--space-6)', display: 'grid', gap: 'var(--space-4)' }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 'var(--text-xl)' }}>Options</h1>
        <p
          className="measure"
          style={{ margin: 'var(--space-1) 0 0', color: 'var(--color-fg-subtle)' }}
        >
          How this tenant behaves, who can see it, and where its mail goes.
        </p>
      </div>

      <Tabs
        label="Settings"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'general', label: 'General' },
          { id: 'account', label: 'Account' },
          { id: 'notifications', label: 'Notifications' },
          { id: 'advanced', label: 'Advanced' },
          { id: 'danger', label: 'Danger' },
        ]}
      >
        {tab === 'general' && <GeneralPanel slug={slug} canWrite={canWrite} />}
        {/* The one tab here that is about the reader rather than the page. It
            takes no `slug`, and that is the point: these passkeys follow the
            person across every tenant they administer. */}
        {tab === 'account' && <PasskeysPanel />}
        {tab === 'notifications' && <NotificationsPanels slug={slug} canWrite={canWrite} />}
        {tab === 'advanced' && <CapacityPanel slug={slug} canWrite={canWrite} />}
        {tab === 'danger' && <DangerPanel slug={slug} canWrite={canWrite} />}
      </Tabs>
    </section>
  )
}

function GeneralPanel({ slug, canWrite }: { slug: string; canWrite: boolean }) {
  const queryClient = useQueryClient()
  const settings = useQuery({
    queryKey: ['settings', slug],
    queryFn: () => adminApi.settings(slug),
  })

  const [draft, setDraft] = useState<TenantSettingsPatch>({})
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setDraft({})
    setSaved(false)
    // The stored accent wins on load, so an unsaved trial does not survive a
    // navigation and quietly become the tenant's colour.
    if (settings.data) applyAccent(accentById(settings.data.accent))
  }, [settings.data])

  const save = useMutation({
    mutationFn: () => adminApi.updateSettings(slug, draft),
    onSuccess: async () => {
      setError(null)
      setSaved(true)
      await queryClient.invalidateQueries({ queryKey: ['settings', slug] })
      await queryClient.invalidateQueries({ queryKey: ['summary', slug] })
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  })

  if (settings.isPending) return <p>Loading…</p>
  if (settings.isError || !settings.data)
    return <Banner tone="down">Could not load settings.</Banner>

  const value = { ...settings.data, ...draft }
  const dirty = Object.keys(draft).length > 0
  const set = <K extends keyof TenantSettingsPatch>(key: K, next: TenantSettingsPatch[K]) => {
    setDraft((prev) => ({ ...prev, [key]: next }))
    setSaved(false)
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      {error && <Banner tone="down">{error}</Banner>}
      {saved && !dirty && <Banner tone="operational">Saved.</Banner>}

      <Card>
        <h2 style={{ margin: '0 0 var(--space-3)', fontSize: 'var(--text-base)' }}>Identity</h2>
        <div className="facts">
          <Field label="Name" hint="Shown at the top of the public page.">
            <Input
              value={value.name}
              disabled={!canWrite}
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>
          <Field
            label="Logo URL"
            hint="Shown in this tenant's admin. Leave blank for the TERN wordmark."
          >
            <Input
              type="url"
              value={value.logoUrl ?? ''}
              disabled={!canWrite}
              placeholder="https://example.com/logo.svg"
              onChange={(e) => set('logoUrl', e.target.value || null)}
            />
          </Field>
          <Field label="Address" hint="The slug is fixed once a page has been shared.">
            <Input value={`/s/${value.slug}`} readOnly />
          </Field>
        </div>
      </Card>

      <Card>
        <h2 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-base)' }}>Accent</h2>
        <p
          className="measure"
          style={{
            margin: '0 0 var(--space-3)',
            fontSize: 'var(--text-sm)',
            color: 'var(--color-fg-subtle)',
          }}
        >
          A short list, and the reason is arithmetic rather than taste: the status palette already
          occupies green, amber, orange, crimson, blue and grey, so an accent near any of them would
          start being read as a state. Teal, steel blue, indigo, amber and pink were all measured
          and all failed. The number is each one&rsquo;s distance from the nearest status colour;
          anything under {SEPARATION_FLOOR} is marked, and names which status it could be mistaken
          for. Below that, a primary button can read as a service state — which on a status page is
          the one confusion worth avoiding.
        </p>

        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          {ACCENTS.map((accent) => {
            const selected = value.accent === accent.id
            return (
              <button
                key={accent.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!canWrite}
                onClick={() => {
                  set('accent', accent.id)
                  // Applied at once: an accent you have to save to see is one
                  // you cannot compare.
                  applyAccent(accent)
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  minHeight: 44,
                  padding: '0 var(--space-3)',
                  borderRadius: 'var(--radius-md)',
                  border: `1px solid ${selected ? accent.light : 'var(--color-border)'}`,
                  background: selected ? 'var(--color-surface-raised)' : 'var(--color-surface)',
                  color: 'var(--color-fg)',
                  fontFamily: 'inherit',
                  fontSize: 'var(--text-sm)',
                  fontWeight: 600,
                  cursor: canWrite ? 'pointer' : 'not-allowed',
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    background: accent.light,
                    boxShadow: `inset 0 0 0 3px var(--color-surface), 0 0 0 1px ${accent.light}`,
                  }}
                />
                {accent.label}
                <span
                  className="tabular"
                  style={{
                    fontSize: 'var(--text-xs)',
                    color:
                      accent.separation < SEPARATION_FLOOR
                        ? 'var(--status-degraded)'
                        : 'var(--color-fg-subtle)',
                  }}
                  title={
                    accent.separation < SEPARATION_FLOOR
                      ? `Close to the ${accent.nearest} status colour — it may be misread as a state`
                      : 'Clear of every status colour'
                  }
                >
                  ΔE {accent.separation}
                  {accent.nearest && ` · near ${accent.nearest}`}
                </span>
              </button>
            )
          })}
        </div>
      </Card>

      <Card>
        <h2 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-base)' }}>Presentation</h2>
        <p
          className="measure"
          style={{
            margin: '0 0 var(--space-3)',
            fontSize: 'var(--text-sm)',
            color: 'var(--color-fg-subtle)',
          }}
        >
          Defaults for a visitor whose browser says nothing useful. A reader&rsquo;s own locale and
          time zone win when they are known.
        </p>
        <div className="facts">
          <Field label="Locale" hint="en, fr, …">
            <Input
              value={value.defaultLocale}
              disabled={!canWrite}
              onChange={(e) => set('defaultLocale', e.target.value)}
            />
          </Field>
          <Field label="Time zone" hint="An IANA name, e.g. Europe/Paris.">
            <Input
              value={value.defaultTimezone}
              disabled={!canWrite}
              onChange={(e) => set('defaultTimezone', e.target.value)}
            />
          </Field>
        </div>
      </Card>

      <Card>
        <h2 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-base)' }}>
          Subscriber disclaimer
        </h2>
        <p
          className="measure"
          style={{
            margin: '0 0 var(--space-3)',
            fontSize: 'var(--text-sm)',
            color: 'var(--color-fg-subtle)',
          }}
        >
          Shown on the subscribe form and in the confirmation mail — where a data-protection notice
          has to be to count as one.
        </p>
        <textarea
          value={value.subscriberDisclaimer ?? ''}
          disabled={!canWrite}
          rows={3}
          onChange={(e) => set('subscriberDisclaimer', e.target.value || null)}
          style={{
            width: '100%',
            background: 'var(--color-bg)',
            color: 'var(--color-fg)',
            border: '1px solid var(--color-border-strong)',
            borderRadius: 'var(--radius-sm)',
            padding: 'var(--space-2) var(--space-3)',
            fontSize: 'var(--text-base)',
            fontFamily: 'inherit',
          }}
        />
      </Card>

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
            Save changes
          </Button>
        </div>
      )}
    </div>
  )
}

export function Choice({
  selected,
  disabled,
  label,
  hint,
  onSelect,
}: {
  selected: boolean
  disabled?: boolean
  label: string
  hint: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      style={{
        flex: '1 1 14rem',
        textAlign: 'left',
        minHeight: 44,
        padding: 'var(--space-3)',
        borderRadius: 'var(--radius-md)',
        border: `1px solid ${selected ? 'var(--color-accent)' : 'var(--color-border)'}`,
        background: selected ? 'var(--color-accent-soft)' : 'var(--color-surface)',
        color: 'var(--color-fg)',
        fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span style={{ display: 'block', fontWeight: 600, fontSize: 'var(--text-sm)' }}>{label}</span>
      <span
        style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}
      >
        {hint}
      </span>
    </button>
  )
}

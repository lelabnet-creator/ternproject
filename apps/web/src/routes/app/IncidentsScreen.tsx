import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  adminApi,
  ApiError,
  type Control,
  type Incident,
  type IncidentImpact,
  type IncidentSeverity,
  type IncidentStatus,
} from '../../lib/adminApi'
import {
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Select,
  Textarea,
  Toggle,
} from '../../components/ui'
import type { IncidentImpactValue } from '@tern/shared/status'

/**
 * Declaring and running an incident.
 *
 * The API has had this since the first day and nothing could reach it without a
 * `curl`, which made the central act of a status page the one thing the product
 * could not do.
 *
 * The shape follows how an incident is actually run rather than what the table
 * looks like: you open it before you know the cause, you add updates as you
 * learn, and the postmortem is written afterwards — calmly, and published on its
 * own schedule. There is no "resolve" button separate from posting an update,
 * because resolving without saying anything is what the API's shape already
 * refuses, and a screen that offered it would only produce a 400.
 */
export function IncidentsScreen({ slug, canWrite }: { slug: string; canWrite: boolean }) {
  const [view, setView] = useState<'list' | 'new' | { openId: string }>('list')

  const incidents = useQuery({
    queryKey: ['incidents', slug],
    queryFn: () => adminApi.incidents(slug),
  })

  // Loaded here rather than in each child: both the declaration form and the
  // update form name controls, and one request serves them and the Controls
  // screen alike.
  const controls = useQuery({
    queryKey: ['controls', slug],
    queryFn: () => adminApi.controls(slug),
  })

  if (view === 'new') {
    return (
      <DeclareIncident
        slug={slug}
        controls={controls.data ?? []}
        onDone={() => {
          setView('list')
          void incidents.refetch()
        }}
      />
    )
  }

  if (typeof view === 'object') {
    const incident = incidents.data?.find((i) => i.id === view.openId)
    if (incident) {
      return (
        <IncidentDetail
          slug={slug}
          incident={incident}
          controls={controls.data ?? []}
          canWrite={canWrite}
          onBack={() => setView('list')}
        />
      )
    }
    // The list was refetched and this one is gone — fall through rather than
    // hold a dead screen.
  }

  if (incidents.isPending) return <Centered>Loading incidents…</Centered>
  if (incidents.isError) return <Banner tone="down">Could not load incidents.</Banner>

  // Unresolved first, and within each group newest first. An operator opening
  // this screen during an outage is looking for the thing that is still
  // happening, not for the archive.
  const open = incidents.data.filter((i) => i.status !== 'resolved')
  const closed = incidents.data.filter((i) => i.status === 'resolved')

  return (
    <section style={{ paddingTop: 'var(--space-6)', display: 'grid', gap: 'var(--space-4)' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'start',
          gap: 'var(--space-3)',
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 'var(--text-xl)' }}>Incidents</h1>
          <p
            className="measure"
            style={{ margin: 'var(--space-1) 0 0', color: 'var(--color-fg-subtle)' }}
          >
            What is wrong, what you know so far, and what you learned afterwards.
          </p>
        </div>
        {canWrite && (
          <Button variant="primary" onClick={() => setView('new')}>
            Declare an incident
          </Button>
        )}
      </div>

      {incidents.data.length === 0 ? (
        <EmptyState
          title="No incidents"
          hint="Nothing has been declared on this page. When something breaks, declaring it here notifies subscribers and marks the affected components."
          action={
            canWrite ? (
              <Button variant="primary" onClick={() => setView('new')}>
                Declare the first one
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {open.length > 0 && (
            <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
              <h2 style={{ margin: 0, fontSize: 'var(--text-base)' }}>
                Ongoing <span className="tabular">({open.length})</span>
              </h2>
              {open.map((incident) => (
                <IncidentRow
                  key={incident.id}
                  incident={incident}
                  controls={controls.data ?? []}
                  onOpen={() => setView({ openId: incident.id })}
                />
              ))}
            </div>
          )}

          {closed.length > 0 && (
            <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
              <h2 style={{ margin: 0, fontSize: 'var(--text-base)' }}>Resolved</h2>
              {closed.map((incident) => (
                <IncidentRow
                  key={incident.id}
                  incident={incident}
                  controls={controls.data ?? []}
                  onOpen={() => setView({ openId: incident.id })}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}

// ── The list ────────────────────────────────────────────────────────────────

function IncidentRow({
  incident,
  controls,
  onOpen,
}: {
  incident: Incident
  controls: Control[]
  onOpen: () => void
}) {
  const latest = incident.updates[incident.updates.length - 1]
  const affected = incident.impacts
    .map((i) => controls.find((c) => c.id === i.controlId)?.name)
    .filter((name): name is string => Boolean(name))

  return (
    <Card>
      <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-2)',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <strong style={{ flex: 1, minWidth: '12rem' }}>{incident.title}</strong>
          <SeverityTag severity={incident.severity} />
          <StatusTag status={incident.status} />
          <Button onClick={onOpen}>Open</Button>
        </div>

        <p
          className="tabular"
          style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}
        >
          Started {new Date(incident.startedAt).toLocaleString()}
          {incident.resolvedAt && (
            <> · lasted {duration(incident.startedAt, incident.resolvedAt)}</>
          )}
          {' · '}
          {incident.updates.length} update{incident.updates.length === 1 ? '' : 's'}
          {incident.hasPostmortem && <> · postmortem published</>}
        </p>

        {affected.length > 0 && (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-fg-muted)' }}>
            Affecting {affected.join(', ')}
          </p>
        )}

        {latest && (
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
            {latest.body}
          </p>
        )}
      </div>
    </Card>
  )
}

// ── Declaring one ───────────────────────────────────────────────────────────

function DeclareIncident({
  slug,
  controls,
  onDone,
}: {
  slug: string
  controls: Control[]
  onDone: () => void
}) {
  const [title, setTitle] = useState('')
  const [severity, setSeverity] = useState<IncidentSeverity>('minor')
  const [body, setBody] = useState('')
  const [impacts, setImpacts] = useState<IncidentImpact[]>([])
  const [isPublic, setIsPublic] = useState(true)
  const [notify, setNotify] = useState(true)
  const [errors, setErrors] = useState<{ title?: string; body?: string }>({})

  const open = useMutation({
    mutationFn: () =>
      adminApi.openIncident(slug, {
        title: title.trim(),
        severity,
        body: body.trim(),
        impacts,
        isPublic,
        notify,
      }),
    onSuccess: onDone,
  })

  /*
   * The button stays enabled and says what is missing when pressed, rather than
   * greying out until the form is perfect. A disabled button gives no reason,
   * and the reason is the whole point.
   */
  const submit = () => {
    const next: typeof errors = {}
    if (title.trim() === '') next.title = 'Give the incident a title.'
    if (body.trim() === '') next.body = 'Say what is known so far, even if that is very little.'
    setErrors(next)
    if (Object.keys(next).length === 0) open.mutate()
  }

  return (
    <section style={{ paddingTop: 'var(--space-6)', display: 'grid', gap: 'var(--space-4)' }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 'var(--text-xl)' }}>Declare an incident</h1>
        <p
          className="measure"
          style={{ margin: 'var(--space-1) 0 0', color: 'var(--color-fg-subtle)' }}
        >
          It opens as <em>investigating</em>. You are not expected to know the cause yet — say what
          you see, and add what you learn as updates.
        </p>
      </div>

      {open.isError && (
        <Banner tone="down">
          {open.error instanceof ApiError ? open.error.message : 'Could not open the incident.'}
        </Banner>
      )}

      <Card>
        <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
          <Field
            label="Title"
            hint="What a reader of the page sees first — “Checkout is failing”, not “incident 4”."
            error={errors.title}
          >
            <Input
              value={title}
              placeholder="Checkout is failing for some customers"
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>

          <Field label="Severity" hint="How much of the service this takes with it.">
            <Select
              value={severity}
              onChange={(e) => setSeverity(e.target.value as IncidentSeverity)}
            >
              {SEVERITIES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} — {s.hint}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="First update"
            hint="Markdown. This is the text subscribers receive and the page shows."
            error={errors.body}
          >
            <Textarea
              value={body}
              rows={5}
              placeholder="We are seeing elevated error rates on checkout and are investigating."
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>

          <ImpactPicker controls={controls} value={impacts} onChange={setImpacts} />

          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            <Toggle
              checked={isPublic}
              onChange={setIsPublic}
              label="Show on the public page"
              hint="Off keeps it to the admin — useful while you confirm something is real."
            />
            <Toggle
              checked={notify}
              onChange={setNotify}
              label="Notify subscribers"
              hint={
                isPublic
                  ? 'Sends to everyone subscribed to the affected components.'
                  : 'Nothing is sent while the incident is not public.'
              }
            />
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Button variant="primary" onClick={submit}>
              {open.isPending ? 'Opening…' : 'Open the incident'}
            </Button>
            <Button onClick={onDone}>Cancel</Button>
          </div>
        </div>
      </Card>
    </section>
  )
}

// ── Running one ─────────────────────────────────────────────────────────────

function IncidentDetail({
  slug,
  incident,
  controls,
  canWrite,
  onBack,
}: {
  slug: string
  incident: Incident
  controls: Control[]
  canWrite: boolean
  onBack: () => void
}) {
  const queryClient = useQueryClient()
  const resolved = incident.status === 'resolved'

  return (
    <section style={{ paddingTop: 'var(--space-6)', display: 'grid', gap: 'var(--space-4)' }}>
      <div>
        <Button onClick={onBack}>← All incidents</Button>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 'var(--space-2)',
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 'var(--text-xl)', flex: 1, minWidth: '12rem' }}>
          {incident.title}
        </h1>
        <SeverityTag severity={incident.severity} />
        <StatusTag status={incident.status} />
      </div>

      <p
        className="tabular"
        style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)' }}
      >
        Started {new Date(incident.startedAt).toLocaleString()}
        {incident.resolvedAt && (
          <>
            {' · '}resolved {new Date(incident.resolvedAt).toLocaleString()} after{' '}
            {duration(incident.startedAt, incident.resolvedAt)}
          </>
        )}
      </p>

      <Timeline incident={incident} />

      {canWrite && !resolved && (
        <PostUpdate
          slug={slug}
          incident={incident}
          controls={controls}
          onDone={() => void queryClient.invalidateQueries({ queryKey: ['incidents', slug] })}
        />
      )}

      {resolved && (
        <Postmortem
          slug={slug}
          incident={incident}
          canWrite={canWrite}
          onDone={() => void queryClient.invalidateQueries({ queryKey: ['incidents', slug] })}
        />
      )}
    </section>
  )
}

function Timeline({ incident }: { incident: Incident }) {
  // Newest at the top: during an incident the last thing said is the thing
  // everyone is looking for.
  const updates = [...incident.updates].reverse()

  return (
    <Card>
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <h2 style={{ margin: 0, fontSize: 'var(--text-base)' }}>Timeline</h2>
        {updates.map((update) => (
          <div
            key={update.id}
            style={{
              display: 'grid',
              gap: 'var(--space-1)',
              borderLeft: '2px solid var(--color-border-strong)',
              paddingLeft: 'var(--space-3)',
            }}
          >
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <StatusTag status={update.status} />
              <span
                className="tabular"
                style={{ fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}
              >
                {new Date(update.createdAt).toLocaleString()}
              </span>
            </div>
            <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{update.body}</p>
          </div>
        ))}
      </div>
    </Card>
  )
}

function PostUpdate({
  slug,
  incident,
  controls,
  onDone,
}: {
  slug: string
  incident: Incident
  controls: Control[]
  onDone: () => void
}) {
  const [status, setStatus] = useState<IncidentStatus>(incident.status)
  const [body, setBody] = useState('')
  const [notify, setNotify] = useState(true)
  const [reviseImpacts, setReviseImpacts] = useState(false)
  const [impacts, setImpacts] = useState<IncidentImpact[]>(incident.impacts)
  const [error, setError] = useState<string | undefined>()

  const post = useMutation({
    mutationFn: () =>
      adminApi.addIncidentUpdate(slug, incident.id, {
        status,
        body: body.trim(),
        notify,
        impacts: reviseImpacts ? impacts : undefined,
      }),
    onSuccess: () => {
      setBody('')
      setReviseImpacts(false)
      onDone()
    },
  })

  const submit = () => {
    if (body.trim() === '') {
      setError('An update with no text tells a subscriber nothing.')
      return
    }
    setError(undefined)
    post.mutate()
  }

  const resolving = status === 'resolved'

  return (
    <Card>
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <h2 style={{ margin: 0, fontSize: 'var(--text-base)' }}>Post an update</h2>

        {post.isError && (
          <Banner tone="down">
            {post.error instanceof ApiError ? post.error.message : 'Could not post the update.'}
          </Banner>
        )}

        <Field label="Status" hint="Where the investigation stands as of this update.">
          <Select value={status} onChange={(e) => setStatus(e.target.value as IncidentStatus)}>
            {STATUSES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} — {s.hint}
              </option>
            ))}
          </Select>
        </Field>

        {resolving && (
          <Banner tone="operational">
            Resolving clears the declared impact, so the affected components go back to showing what
            they are actually measuring. The page stays red otherwise.
          </Banner>
        )}

        <Field label="Update" hint="Markdown." error={error}>
          <Textarea
            value={body}
            rows={4}
            placeholder="We have identified a bad deploy and are rolling it back."
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>

        {!resolving && (
          <>
            <Toggle
              checked={reviseImpacts}
              onChange={setReviseImpacts}
              label="Revise the affected components"
              hint="The blast radius is often wider or narrower than it first looked."
            />
            {reviseImpacts && (
              <ImpactPicker controls={controls} value={impacts} onChange={setImpacts} />
            )}
          </>
        )}

        <Toggle
          checked={notify}
          onChange={setNotify}
          label="Notify subscribers"
          hint="Off for a correction not worth a second mail."
        />

        <div>
          <Button variant="primary" onClick={submit}>
            {post.isPending ? 'Posting…' : resolving ? 'Resolve the incident' : 'Post the update'}
          </Button>
        </div>
      </div>
    </Card>
  )
}

function Postmortem({
  slug,
  incident,
  canWrite,
  onDone,
}: {
  slug: string
  incident: Incident
  canWrite: boolean
  onDone: () => void
}) {
  const detail = useQuery({
    queryKey: ['incident', slug, incident.id],
    queryFn: () => adminApi.incident(slug, incident.id),
  })

  const [body, setBody] = useState<string | null>(null)
  const [error, setError] = useState<string | undefined>()

  const save = useMutation({
    mutationFn: (publish: boolean) =>
      adminApi.savePostmortem(slug, incident.id, { body: (body ?? '').trim(), publish }),
    onSuccess: () => {
      void detail.refetch()
      onDone()
    },
  })

  if (detail.isPending) return <Card>Loading the postmortem…</Card>

  // The API returns the body only once published; a draft is deliberately not
  // readable back. Seeding the editor from whatever it did return keeps a
  // published postmortem editable without pretending a draft survived.
  const value = body ?? detail.data?.postmortemBody ?? ''
  const published = Boolean(detail.data?.postmortemPublishedAt)

  const submit = (publish: boolean) => {
    if (value.trim() === '') {
      setError('There is nothing to save yet.')
      return
    }
    setError(undefined)
    save.mutate(publish)
  }

  return (
    <Card>
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 'var(--text-base)' }}>Postmortem</h2>
          <p
            className="measure"
            style={{
              margin: 'var(--space-1) 0 0',
              fontSize: 'var(--text-sm)',
              color: 'var(--color-fg-subtle)',
            }}
          >
            {published
              ? `Published ${new Date(detail.data!.postmortemPublishedAt!).toLocaleString()}. It appears on the public history page.`
              : 'Written afterwards and published when it is ready. Nothing is shown publicly until you publish it.'}
          </p>
        </div>

        {save.isError && (
          <Banner tone="down">
            {save.error instanceof ApiError ? save.error.message : 'Could not save the postmortem.'}
          </Banner>
        )}

        {!canWrite ? (
          published ? (
            <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{detail.data?.postmortemBody}</p>
          ) : (
            <p style={{ margin: 0, color: 'var(--color-fg-subtle)' }}>Not published yet.</p>
          )
        ) : (
          <>
            {!published && (
              // Said before they type it, not after they lose it.
              <Banner tone="degraded">
                A saved draft cannot be read back — the API hands out the text only once it is
                published. Keep your own copy until you publish.
              </Banner>
            )}

            <Field
              label="Postmortem"
              hint="Markdown. What broke, why, and what changes."
              error={error}
            >
              <Textarea
                value={value}
                rows={12}
                placeholder="## What happened&#10;&#10;## Why&#10;&#10;## What we are changing"
                onChange={(e) => setBody(e.target.value)}
              />
            </Field>

            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <Button variant="primary" onClick={() => submit(true)}>
                {published ? 'Update the published postmortem' : 'Publish'}
              </Button>
              {!published && <Button onClick={() => submit(false)}>Save as a draft</Button>}
            </div>
          </>
        )}
      </div>
    </Card>
  )
}

// ── Impacts ─────────────────────────────────────────────────────────────────

/**
 * Which components this incident is taking down, and how far.
 *
 * A checkbox and a level per control rather than a multi-select: the level is
 * the part that matters on the page, and a multi-select hides it behind a
 * second interaction.
 */
function ImpactPicker({
  controls,
  value,
  onChange,
}: {
  controls: Control[]
  value: IncidentImpact[]
  onChange: (next: IncidentImpact[]) => void
}) {
  if (controls.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)' }}>
        No controls to attach yet.
      </p>
    )
  }

  const set = (controlId: string, impact: IncidentImpactValue | null) => {
    const without = value.filter((i) => i.controlId !== controlId)
    onChange(impact === null ? without : [...without, { controlId, impact }])
  }

  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 'var(--space-2)' }}>
      <legend style={{ fontSize: 'var(--text-sm)', fontWeight: 600, padding: 0 }}>
        Affected components
      </legend>
      <p
        style={{
          margin: 0,
          fontSize: 'var(--text-xs)',
          color: 'var(--color-fg-subtle)',
        }}
      >
        Each one you attach is marked on the public page for as long as the incident is open.
      </p>

      {controls.map((control) => {
        const current = value.find((i) => i.controlId === control.id)
        return (
          <div
            key={control.id}
            style={{
              display: 'flex',
              gap: 'var(--space-3)',
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <label
              style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flex: 1 }}
            >
              <input
                type="checkbox"
                checked={Boolean(current)}
                onChange={(e) => set(control.id, e.target.checked ? 'degraded' : null)}
              />
              <span>{control.name}</span>
            </label>
            {current && (
              <Select
                value={current.impact}
                aria-label={`Impact on ${control.name}`}
                onChange={(e) => set(control.id, e.target.value as IncidentImpactValue)}
                style={{ width: 'auto', minWidth: '12rem' }}
              >
                {IMPACTS.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.label}
                  </option>
                ))}
              </Select>
            )}
          </div>
        )
      })}
    </fieldset>
  )
}

// ── Small pieces ────────────────────────────────────────────────────────────

const SEVERITIES = [
  { id: 'minor', label: 'Minor', hint: 'inconvenient, not blocking' },
  { id: 'major', label: 'Major', hint: 'a real part of the service is unusable' },
  { id: 'critical', label: 'Critical', hint: 'the service is down' },
] as const satisfies readonly { id: IncidentSeverity; label: string; hint: string }[]

const STATUSES = [
  { id: 'investigating', label: 'Investigating', hint: 'we see it, we do not know why' },
  { id: 'identified', label: 'Identified', hint: 'we know the cause' },
  { id: 'monitoring', label: 'Monitoring', hint: 'a fix is out, we are watching' },
  { id: 'resolved', label: 'Resolved', hint: 'it is over' },
] as const satisfies readonly { id: IncidentStatus; label: string; hint: string }[]

const IMPACTS = [
  { id: 'degraded', label: 'Degraded — slower or flaky' },
  { id: 'partial', label: 'Partial outage — some of it is down' },
  { id: 'major', label: 'Major outage — all of it is down' },
] as const satisfies readonly { id: IncidentImpactValue; label: string }[]

/** State as a word first — the colour is a second channel, never the only one. */
function StatusTag({ status }: { status: IncidentStatus }) {
  const tone = status === 'resolved' ? 'var(--status-operational)' : 'var(--status-degraded)'
  return <Pill colour={tone}>{STATUSES.find((s) => s.id === status)?.label ?? status}</Pill>
}

function SeverityTag({ severity }: { severity: IncidentSeverity }) {
  const tone =
    severity === 'critical'
      ? 'var(--status-down)'
      : severity === 'major'
        ? 'var(--status-degraded)'
        : 'var(--color-border-strong)'
  return <Pill colour={tone}>{SEVERITIES.find((s) => s.id === severity)?.label ?? severity}</Pill>
}

function Pill({ children, colour }: { children: React.ReactNode; colour: string }) {
  return (
    <span
      style={{
        flexShrink: 0,
        padding: '0 var(--space-2)',
        borderRadius: 'var(--radius-full)',
        border: `1px solid ${colour}`,
        color: 'var(--color-fg-muted)',
        fontSize: 'var(--text-xs)',
        fontWeight: 600,
      }}
    >
      {children}
    </span>
  )
}

function duration(from: string, to: string): string {
  const ms = new Date(to).getTime() - new Date(from).getTime()
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
  const days = Math.floor(hours / 24)
  return `${days} d ${hours % 24} h`
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '40vh' }}>
      <p style={{ color: 'var(--color-fg-subtle)' }}>{children}</p>
    </div>
  )
}

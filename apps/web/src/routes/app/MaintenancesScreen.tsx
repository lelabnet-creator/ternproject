import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  adminApi,
  ApiError,
  type Control,
  type Maintenance,
  type MaintenanceStatus,
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

/**
 * Planned work, announced in advance.
 *
 * Everything downstream of this screen already worked — reminders, automatic
 * transitions, the public rendering, alert suppression. Nothing could create a
 * window, so the reminder half had never had anything to remind anyone about.
 *
 * What a window still accepts narrows as it advances, and the form says so by
 * disabling the fields rather than by letting the API refuse them: an operator
 * pushing the end of an overrunning window at 03:00 should not have to discover
 * the rule from a 409.
 */
export function MaintenancesScreen({ slug, canWrite }: { slug: string; canWrite: boolean }) {
  const [view, setView] = useState<'list' | 'new' | { openId: string }>('list')

  const maintenances = useQuery({
    queryKey: ['maintenances', slug],
    queryFn: () => adminApi.maintenances(slug),
  })
  const controls = useQuery({
    queryKey: ['controls', slug],
    queryFn: () => adminApi.controls(slug),
  })

  if (view === 'new') {
    return (
      <MaintenanceForm
        slug={slug}
        controls={controls.data ?? []}
        onDone={() => {
          setView('list')
          void maintenances.refetch()
        }}
      />
    )
  }

  if (typeof view === 'object') {
    const maintenance = maintenances.data?.find((m) => m.id === view.openId)
    if (maintenance) {
      return (
        <MaintenanceDetail
          slug={slug}
          maintenance={maintenance}
          controls={controls.data ?? []}
          canWrite={canWrite}
          onBack={() => setView('list')}
        />
      )
    }
  }

  if (maintenances.isPending) return <Centered>Loading maintenance windows…</Centered>
  if (maintenances.isError) return <Banner tone="down">Could not load maintenance windows.</Banner>

  const running = maintenances.data.filter((m) => m.status === 'in_progress')
  const upcoming = maintenances.data.filter((m) => m.status === 'scheduled')
  const past = maintenances.data.filter((m) => m.status === 'completed' || m.status === 'cancelled')

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
          <h1 style={{ margin: 0, fontSize: 'var(--text-xl)' }}>Maintenance</h1>
          <p
            className="measure"
            style={{ margin: 'var(--space-1) 0 0', color: 'var(--color-fg-subtle)' }}
          >
            Work you know about in advance. Subscribers are reminded before it opens, and alerting
            can stay quiet while it runs.
          </p>
        </div>
        {canWrite && (
          <Button variant="primary" onClick={() => setView('new')}>
            Schedule a window
          </Button>
        )}
      </div>

      {maintenances.data.length === 0 ? (
        <EmptyState
          title="Nothing planned"
          hint="A maintenance window announces work before it happens, reminds subscribers as it approaches, and stops the affected controls from being reported as an outage while it runs."
          action={
            canWrite ? (
              <Button variant="primary" onClick={() => setView('new')}>
                Schedule the first one
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Group
            title="In progress"
            rows={running}
            controls={controls.data ?? []}
            onOpen={setView}
          />
          <Group title="Upcoming" rows={upcoming} controls={controls.data ?? []} onOpen={setView} />
          <Group title="Past" rows={past} controls={controls.data ?? []} onOpen={setView} />
        </>
      )}
    </section>
  )
}

function Group({
  title,
  rows,
  controls,
  onOpen,
}: {
  title: string
  rows: Maintenance[]
  controls: Control[]
  onOpen: (view: { openId: string }) => void
}) {
  if (rows.length === 0) return null
  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <h2 style={{ margin: 0, fontSize: 'var(--text-base)' }}>
        {title} <span className="tabular">({rows.length})</span>
      </h2>
      {rows.map((row) => (
        <MaintenanceRow
          key={row.id}
          maintenance={row}
          controls={controls}
          onOpen={() => onOpen({ openId: row.id })}
        />
      ))}
    </div>
  )
}

function MaintenanceRow({
  maintenance,
  controls,
  onOpen,
}: {
  maintenance: Maintenance
  controls: Control[]
  onOpen: () => void
}) {
  const affected = maintenance.controlIds
    .map((id) => controls.find((c) => c.id === id)?.name)
    .filter((name): name is string => Boolean(name))

  return (
    <Card>
      <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
        <div
          style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}
        >
          <strong style={{ flex: 1, minWidth: '12rem' }}>{maintenance.title}</strong>
          <StatusTag status={maintenance.status} />
          {!maintenance.isPublic && <Pill colour="var(--color-border-strong)">internal</Pill>}
          <Button onClick={onOpen}>Open</Button>
        </div>

        <p
          className="tabular"
          style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}
        >
          {new Date(maintenance.scheduledStart).toLocaleString()} →{' '}
          {new Date(maintenance.scheduledEnd).toLocaleString()}
          {maintenance.status === 'scheduled' && maintenance.remindersBeforeMin.length > 0 && (
            <>
              {' · '}reminders {maintenance.remindersBeforeMin.map(markLabel).join(', ')} before
              {maintenance.remindersSentAt.length > 0 && (
                <> ({maintenance.remindersSentAt.length} sent)</>
              )}
            </>
          )}
        </p>

        {/* A window whose controls were all deleted still exists — the work
            happened — but it now suppresses nothing and marks nothing on the
            page. Said plainly rather than left to be discovered. */}
        {affected.length === 0 ? (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)' }}>
            No components attached — nothing is marked on the page, and nothing is silenced.
          </p>
        ) : (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-fg-muted)' }}>
            {affected.join(', ')}
            {maintenance.suppressAlerts ? ' — alerting silenced' : ''}
          </p>
        )}
      </div>
    </Card>
  )
}

// ── The form, for creating and for editing ──────────────────────────────────

function MaintenanceForm({
  slug,
  controls,
  existing,
  onDone,
}: {
  slug: string
  controls: Control[]
  existing?: Maintenance
  onDone: () => void
}) {
  const editing = existing !== undefined
  const status = existing?.status ?? 'scheduled'

  // Which fields the API will still accept. Mirrored from the route rather than
  // guessed: a scheduled window is fully editable, a running one has its
  // schedule frozen because reminders already went out against it, and a
  // finished one is a record.
  const canEditSchedule = status === 'scheduled'
  const canEditBehaviour = status === 'scheduled' || status === 'in_progress'

  const [title, setTitle] = useState(existing?.title ?? '')
  const [body, setBody] = useState(existing?.body ?? '')
  const [start, setStart] = useState(toLocalInput(existing?.scheduledStart ?? defaultStart()))
  const [end, setEnd] = useState(toLocalInput(existing?.scheduledEnd ?? defaultEnd()))
  const [controlIds, setControlIds] = useState<string[]>(existing?.controlIds ?? [])
  const [reminders, setReminders] = useState<number[]>(existing?.remindersBeforeMin ?? [1440, 60])
  const [autoTransition, setAutoTransition] = useState(existing?.autoTransition ?? true)
  const [suppressAlerts, setSuppressAlerts] = useState(existing?.suppressAlerts ?? true)
  const [isPublic, setIsPublic] = useState(existing?.isPublic ?? true)
  const [notify, setNotify] = useState(true)
  const [errors, setErrors] = useState<{ title?: string; end?: string }>({})

  const save = useMutation({
    // Only the frozen-field rules decide what a PATCH carries: sending a field
    // the window no longer accepts earns a 409, and sending it unchanged is
    // still sending it.
    mutationFn: async () => {
      if (existing) {
        await adminApi.updateMaintenance(slug, existing.id, {
          title: title.trim(),
          body: body.trim() || null,
          ...(canEditSchedule && {
            scheduledStart: fromLocalInput(start),
            remindersBeforeMin: reminders,
          }),
          ...(canEditBehaviour && {
            scheduledEnd: fromLocalInput(end),
            controlIds,
            autoTransition,
            suppressAlerts,
            isPublic,
          }),
        })
        return
      }

      await adminApi.scheduleMaintenance(slug, {
        title: title.trim(),
        body: body.trim() || undefined,
        scheduledStart: fromLocalInput(start),
        scheduledEnd: fromLocalInput(end),
        controlIds,
        autoTransition,
        suppressAlerts,
        isPublic,
        remindersBeforeMin: reminders,
        notify,
      })
    },
    onSuccess: onDone,
  })

  const submit = () => {
    const next: typeof errors = {}
    if (title.trim() === '') next.title = 'Give the window a title.'
    if (new Date(end).getTime() <= new Date(start).getTime()) {
      next.end = 'The window has to end after it starts.'
    }
    setErrors(next)
    if (Object.keys(next).length === 0) save.mutate()
  }

  return (
    <section style={{ paddingTop: 'var(--space-6)', display: 'grid', gap: 'var(--space-4)' }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 'var(--text-xl)' }}>
          {editing ? 'Edit the window' : 'Schedule maintenance'}
        </h1>
        {editing && !canEditSchedule && (
          <p
            className="measure"
            style={{ margin: 'var(--space-1) 0 0', color: 'var(--color-fg-subtle)' }}
          >
            {status === 'in_progress'
              ? 'This window has opened, so its start and its reminders are history. The end can still move.'
              : 'This window is over. Only the wording can still be corrected.'}
          </p>
        )}
      </div>

      {save.isError && (
        <Banner tone="down">
          {save.error instanceof ApiError ? save.error.message : 'Could not save the window.'}
        </Banner>
      )}

      <Card>
        <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
          <Field
            label="Title"
            hint="What the page and the reminder mail announce."
            error={errors.title}
          >
            <Input
              value={title}
              placeholder="Database upgrade"
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>

          <Field label="Details" hint="Optional. Markdown — what is changing, and what to expect.">
            <Textarea
              value={body}
              rows={4}
              placeholder="The API will be read-only for about twenty minutes."
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>

          <div
            style={{
              display: 'grid',
              gap: 'var(--space-3)',
              gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))',
            }}
          >
            <Field
              label="Starts"
              hint={canEditSchedule ? 'Your local time.' : 'Frozen — the window has opened.'}
            >
              <Input
                type="datetime-local"
                value={start}
                disabled={!canEditSchedule}
                onChange={(e) => setStart(e.target.value)}
              />
            </Field>
            <Field
              label="Ends"
              hint={
                canEditBehaviour ? 'Push it if the work runs long.' : 'Frozen — the window is over.'
              }
              error={errors.end}
            >
              <Input
                type="datetime-local"
                value={end}
                disabled={!canEditBehaviour}
                onChange={(e) => setEnd(e.target.value)}
              />
            </Field>
          </div>

          <ReminderPicker
            value={reminders}
            disabled={!canEditSchedule}
            sent={existing?.remindersSentAt ?? []}
            onChange={setReminders}
          />

          <ControlPicker
            controls={controls}
            value={controlIds}
            disabled={!canEditBehaviour}
            onChange={setControlIds}
          />

          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            <Toggle
              checked={autoTransition}
              disabled={!canEditBehaviour}
              onChange={setAutoTransition}
              label="Open and close it automatically"
              hint="Off means you move it by hand — a window still saying “scheduled” an hour after it began is worse than none."
            />
            <Toggle
              checked={suppressAlerts}
              disabled={!canEditBehaviour}
              onChange={setSuppressAlerts}
              label="Silence alerting for the attached components"
              hint="A control that is expected to go quiet should not be reported as lost contact."
            />
            <Toggle
              checked={isPublic}
              disabled={!canEditBehaviour}
              onChange={setIsPublic}
              label="Show on the public page"
              hint="Off keeps it to the admin, and sends nothing to subscribers."
            />
            {!editing && (
              <Toggle
                checked={notify}
                onChange={setNotify}
                label="Announce it now"
                hint={
                  isPublic
                    ? 'Otherwise the first subscribers hear of it is the earliest reminder.'
                    : 'Nothing is sent while the window is not public.'
                }
              />
            )}
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Button variant="primary" onClick={submit}>
              {save.isPending ? 'Saving…' : editing ? 'Save' : 'Schedule it'}
            </Button>
            <Button onClick={onDone}>Cancel</Button>
          </div>
        </div>
      </Card>
    </section>
  )
}

// ── Running one ─────────────────────────────────────────────────────────────

function MaintenanceDetail({
  slug,
  maintenance,
  controls,
  canWrite,
  onBack,
}: {
  slug: string
  maintenance: Maintenance
  controls: Control[]
  canWrite: boolean
  onBack: () => void
}) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['maintenances', slug] })

  if (editing) {
    return (
      <MaintenanceForm
        slug={slug}
        controls={controls}
        existing={maintenance}
        onDone={() => {
          setEditing(false)
          refresh()
        }}
      />
    )
  }

  const over = maintenance.status === 'completed' || maintenance.status === 'cancelled'

  return (
    <section style={{ paddingTop: 'var(--space-6)', display: 'grid', gap: 'var(--space-4)' }}>
      <div>
        <Button onClick={onBack}>← All windows</Button>
      </div>

      <div
        style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}
      >
        <h1 style={{ margin: 0, fontSize: 'var(--text-xl)', flex: 1, minWidth: '12rem' }}>
          {maintenance.title}
        </h1>
        <StatusTag status={maintenance.status} />
        {canWrite && <Button onClick={() => setEditing(true)}>Edit</Button>}
      </div>

      <p
        className="tabular"
        style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)' }}
      >
        Planned {new Date(maintenance.scheduledStart).toLocaleString()} →{' '}
        {new Date(maintenance.scheduledEnd).toLocaleString()}
        {maintenance.actualStart && (
          <> · opened {new Date(maintenance.actualStart).toLocaleString()}</>
        )}
        {maintenance.actualEnd && <> · closed {new Date(maintenance.actualEnd).toLocaleString()}</>}
      </p>

      {maintenance.body && (
        <Card>
          <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{maintenance.body}</p>
        </Card>
      )}

      {maintenance.updates.length > 0 && (
        <Card>
          <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
            <h2 style={{ margin: 0, fontSize: 'var(--text-base)' }}>Timeline</h2>
            {[...maintenance.updates].reverse().map((update) => (
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
      )}

      {canWrite && !over && (
        <>
          <PostUpdate slug={slug} maintenance={maintenance} onDone={refresh} />
          <CancelWindow
            slug={slug}
            maintenance={maintenance}
            onDone={() => {
              refresh()
              onBack()
            }}
          />
        </>
      )}
    </section>
  )
}

function PostUpdate({
  slug,
  maintenance,
  onDone,
}: {
  slug: string
  maintenance: Maintenance
  onDone: () => void
}) {
  const [status, setStatus] = useState<MaintenanceStatus>(maintenance.status)
  const [body, setBody] = useState('')
  const [notify, setNotify] = useState(true)
  const [error, setError] = useState<string | undefined>()

  const post = useMutation({
    mutationFn: () =>
      adminApi.addMaintenanceUpdate(slug, maintenance.id, { status, body: body.trim(), notify }),
    onSuccess: () => {
      setBody('')
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

  return (
    <Card>
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 'var(--text-base)' }}>Post an update</h2>
          <p
            className="measure"
            style={{
              margin: 'var(--space-1) 0 0',
              fontSize: 'var(--text-sm)',
              color: 'var(--color-fg-subtle)',
            }}
          >
            {maintenance.autoTransition
              ? 'The window opens and closes on its own. This is for saying something in between, or for moving it early.'
              : 'Auto-transition is off, so this is how the window moves.'}
          </p>
        </div>

        {post.isError && (
          <Banner tone="down">
            {post.error instanceof ApiError ? post.error.message : 'Could not post the update.'}
          </Banner>
        )}

        <Field label="Status" hint="Where the work stands as of this update.">
          <Select value={status} onChange={(e) => setStatus(e.target.value as MaintenanceStatus)}>
            {STATUSES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} — {s.hint}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Update" hint="Markdown." error={error}>
          <Textarea
            value={body}
            rows={4}
            placeholder="The upgrade is done; we are watching replication catch up."
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>

        <Toggle
          checked={notify}
          onChange={setNotify}
          label="Notify subscribers"
          hint="Off for a correction not worth a second mail."
        />

        <div>
          <Button variant="primary" onClick={submit}>
            {post.isPending ? 'Posting…' : 'Post the update'}
          </Button>
        </div>
      </div>
    </Card>
  )
}

function CancelWindow({
  slug,
  maintenance,
  onDone,
}: {
  slug: string
  maintenance: Maintenance
  onDone: () => void
}) {
  const [confirming, setConfirming] = useState(false)

  // Matches what the API will do, so the button can say which it is. A window
  // nobody was told about is a draft; anything else has been announced and is
  // cancelled out loud rather than made to disappear.
  const announced =
    maintenance.status !== 'scheduled' ||
    maintenance.remindersSentAt.length > 0 ||
    maintenance.actualStart !== null

  const cancel = useMutation({
    mutationFn: () => adminApi.cancelMaintenance(slug, maintenance.id),
    onSuccess: onDone,
  })

  return (
    <Card>
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <h2 style={{ margin: 0, fontSize: 'var(--text-base)' }}>
          {announced ? 'Cancel this window' : 'Delete this window'}
        </h2>
        <p
          className="measure"
          style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)' }}
        >
          {announced
            ? 'Subscribers were told this was coming, so it is cancelled and announced rather than removed — a window that vanishes leaves people expecting work that never happens.'
            : 'Nothing has been announced yet, so this one is removed outright.'}
        </p>

        {cancel.isError && (
          <Banner tone="down">
            {cancel.error instanceof ApiError ? cancel.error.message : 'Could not cancel it.'}
          </Banner>
        )}

        {confirming ? (
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Button variant="danger" onClick={() => cancel.mutate()}>
              {cancel.isPending ? 'Working…' : announced ? 'Yes, cancel it' : 'Yes, delete it'}
            </Button>
            <Button onClick={() => setConfirming(false)}>Keep it</Button>
          </div>
        ) : (
          <div>
            <Button onClick={() => setConfirming(true)}>
              {announced ? 'Cancel the window' : 'Delete the window'}
            </Button>
          </div>
        )}
      </div>
    </Card>
  )
}

// ── Pickers ─────────────────────────────────────────────────────────────────

function ControlPicker({
  controls,
  value,
  disabled,
  onChange,
}: {
  controls: Control[]
  value: string[]
  disabled?: boolean
  onChange: (next: string[]) => void
}) {
  if (controls.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)' }}>
        No controls to attach yet.
      </p>
    )
  }

  return (
    <fieldset
      disabled={disabled}
      style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 'var(--space-2)' }}
    >
      <legend style={{ fontSize: 'var(--text-sm)', fontWeight: 600, padding: 0 }}>
        Affected components
      </legend>
      <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}>
        Marked as under maintenance on the page for the length of the window.
      </p>
      {controls.map((control) => (
        <label
          key={control.id}
          style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}
        >
          <input
            type="checkbox"
            checked={value.includes(control.id)}
            onChange={(e) =>
              onChange(
                e.target.checked ? [...value, control.id] : value.filter((id) => id !== control.id),
              )
            }
          />
          <span>{control.name}</span>
        </label>
      ))}
    </fieldset>
  )
}

/** The marks at which subscribers are reminded, as offsets before the window. */
const MARKS = [10_080, 1440, 240, 60, 15] as const

function ReminderPicker({
  value,
  sent,
  disabled,
  onChange,
}: {
  value: number[]
  sent: number[]
  disabled?: boolean
  onChange: (next: number[]) => void
}) {
  return (
    <fieldset
      disabled={disabled}
      style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 'var(--space-2)' }}
    >
      <legend style={{ fontSize: 'var(--text-sm)', fontWeight: 600, padding: 0 }}>Reminders</legend>
      <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}>
        Sent to subscribers of the attached components. Postponing the window re-arms any reminder
        it has outrun.
      </p>
      <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        {MARKS.map((mark) => (
          <label
            key={mark}
            style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}
          >
            <input
              type="checkbox"
              checked={value.includes(mark)}
              onChange={(e) =>
                onChange(e.target.checked ? [...value, mark] : value.filter((m) => m !== mark))
              }
            />
            <span style={{ fontSize: 'var(--text-sm)' }}>
              {markLabel(mark)}
              {sent.includes(mark) && (
                <span style={{ color: 'var(--color-fg-subtle)' }}> · sent</span>
              )}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

// ── Small pieces ────────────────────────────────────────────────────────────

const STATUSES = [
  { id: 'scheduled', label: 'Scheduled', hint: 'announced, not started' },
  { id: 'in_progress', label: 'In progress', hint: 'the work is happening' },
  { id: 'completed', label: 'Completed', hint: 'it is done' },
  { id: 'cancelled', label: 'Cancelled', hint: 'it will not happen' },
] as const satisfies readonly { id: MaintenanceStatus; label: string; hint: string }[]

function StatusTag({ status }: { status: MaintenanceStatus }) {
  const colour =
    status === 'in_progress'
      ? 'var(--status-maintenance)'
      : status === 'completed'
        ? 'var(--status-operational)'
        : status === 'cancelled'
          ? 'var(--status-unknown)'
          : 'var(--color-border-strong)'
  return <Pill colour={colour}>{STATUSES.find((s) => s.id === status)?.label ?? status}</Pill>
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

function markLabel(minutes: number): string {
  if (minutes >= 1440) return `${minutes / 1440} d`
  if (minutes >= 60) return `${minutes / 60} h`
  return `${minutes} min`
}

/**
 * `datetime-local` speaks wall-clock time with no zone, so both directions go
 * through the browser's own zone rather than through `toISOString`, which would
 * shift every window by the UTC offset.
 */
function toLocalInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromLocalInput(value: string): string {
  return new Date(value).toISOString()
}

/** Tomorrow, on the hour — the shape of nearly every window anyone schedules. */
function defaultStart(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setMinutes(0, 0, 0)
  return d.toISOString()
}

function defaultEnd(): string {
  const d = new Date(defaultStart())
  d.setHours(d.getHours() + 1)
  return d.toISOString()
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '40vh' }}>
      <p style={{ color: 'var(--color-fg-subtle)' }}>{children}</p>
    </div>
  )
}

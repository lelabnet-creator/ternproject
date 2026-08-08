import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminApi, ApiError } from '../../lib/adminApi'
import { Tabs } from '../../components/Tabs'
import { Banner, Button, Card, EmptyState, Field, Input } from '../../components/ui'
import { MonitoringPanel } from '../../features/settings/MonitoringPanel'

/**
 * What has happened here, and where else it should be written down.
 *
 * The audit trail was written from the first day with no way to read it, which
 * makes it a record nobody consults until an incident — and then it is a SQL
 * query typed under pressure.
 */
export function LogsScreen({ slug, canWrite }: { slug: string; canWrite: boolean }) {
  const [tab, setTab] = useState('trail')

  return (
    <section style={{ paddingTop: 'var(--space-6)', display: 'grid', gap: 'var(--space-4)' }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 'var(--text-xl)' }}>Logs</h1>
        <p
          className="measure"
          style={{ margin: 'var(--space-1) 0 0', color: 'var(--color-fg-subtle)' }}
        >
          Every change worth explaining afterwards: who did it, to what, and from where.
        </p>
      </div>

      <Tabs
        label="Logs"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'trail', label: 'Audit trail' },
          { id: 'forward', label: 'Forwarding' },
          { id: 'monitoring', label: 'Monitoring' },
        ]}
      >
        {tab === 'trail' && <TrailPanel slug={slug} />}
        {tab === 'forward' && <ForwardPanel slug={slug} canWrite={canWrite} />}
        {/* The one tab here reporting the present rather than the past — and the
            reason the screen's own description says "worth explaining
            afterwards" rather than speaking for all three. */}
        {tab === 'monitoring' && <MonitoringPanel slug={slug} />}
      </Tabs>
    </section>
  )
}

function TrailPanel({ slug }: { slug: string }) {
  /*
   * Opened already narrowed, when something sent the reader here.
   *
   * A control's row links to this screen with `?q=<control id>`, because the
   * audit's `target` column holds that id — so the trail arrives filtered to
   * one control rather than to the whole tenant, which is the difference
   * between an answer and a haystack.
   *
   * Read once, as the initial value, and then owned by the field: the reader
   * came here to look around, and a URL that kept re-imposing itself on every
   * keystroke would fight them for their own search box. Clearing the field
   * leaves the address behind — reloading really does restore the filter,
   * which is what makes the link worth sharing.
   */
  const [query, setQuery] = useState(
    () => new URLSearchParams(window.location.search).get('q') ?? '',
  )
  const [action, setAction] = useState('')

  const logs = useQuery({
    queryKey: ['logs', slug, query, action],
    queryFn: () => adminApi.logs(slug, { q: query || undefined, action: action || undefined }),
    // Filtering happens on the server here, unlike the controls list: an audit
    // trail is unbounded, and the page holds at most a few hundred of it.
    refetchInterval: 60_000,
  })

  if (logs.isPending) return <p>Reading the trail…</p>
  if (logs.isError || !logs.data) return <Banner tone="down">Could not read the trail.</Banner>

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <div className="facts">
        <Field label="Search" hint="Matches the action, the target and the actor.">
          <Input
            type="search"
            value={query}
            placeholder="agent, revoked, settings…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </Field>
        <Field label="Action" hint="Only the actions this tenant has recorded.">
          <select value={action} onChange={(e) => setAction(e.target.value)} style={selectStyle}>
            <option value="">Any</option>
            {logs.data.actions.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {logs.data.entries.length === 0 ? (
        <EmptyState
          title={query || action ? 'Nothing matches' : 'Nothing recorded yet'}
          hint={
            query || action
              ? 'Try a shorter search, or clear the action filter.'
              : 'Sign-ins, pairings, revocations and configuration changes appear here as they happen.'
          }
          action={
            query || action ? (
              <Button
                onClick={() => {
                  setQuery('')
                  setAction('')
                }}
              >
                Clear the filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Card>
          <div style={{ overflowX: 'auto' }}>
            <table className="tabular" style={table}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--color-fg-subtle)' }}>
                  <th style={cell}>When</th>
                  <th style={cell}>Action</th>
                  <th style={cell}>Who</th>
                  <th style={cell}>What</th>
                  <th style={cell}>From</th>
                </tr>
              </thead>
              <tbody>
                {logs.data.entries.map((entry) => (
                  <tr key={entry.id} style={{ borderTop: '1px solid var(--color-border)' }}>
                    <td style={{ ...cell, whiteSpace: 'nowrap' }}>
                      {new Date(entry.ts).toLocaleString()}
                    </td>
                    <td style={cell}>
                      <code style={{ fontSize: 'var(--text-xs)' }}>{entry.action}</code>
                    </td>
                    <td style={cell}>{entry.actor}</td>
                    <td style={{ ...cell, color: 'var(--color-fg-muted)' }}>
                      {entry.target ?? '—'}
                      {Object.keys(entry.meta).length > 0 && (
                        <span
                          style={{
                            display: 'block',
                            fontSize: 'var(--text-xs)',
                            color: 'var(--color-fg-subtle)',
                          }}
                        >
                          {JSON.stringify(entry.meta)}
                        </span>
                      )}
                    </td>
                    <td style={{ ...cell, color: 'var(--color-fg-subtle)' }}>{entry.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p
            className="measure"
            style={{
              margin: 'var(--space-3) 0 0',
              fontSize: 'var(--text-xs)',
              color: 'var(--color-fg-subtle)',
            }}
          >
            The most recent {logs.data.entries.length}. Narrow the search to reach further back —
            and note that entries are never edited or deleted from here, which is what makes them
            worth reading.
          </p>
        </Card>
      )}
    </div>
  )
}

const FACILITIES = [
  [16, 'local0'],
  [17, 'local1'],
  [18, 'local2'],
  [19, 'local3'],
  [20, 'local4'],
  [21, 'local5'],
  [22, 'local6'],
  [23, 'local7'],
] as const

function ForwardPanel({ slug, canWrite }: { slug: string; canWrite: boolean }) {
  const queryClient = useQueryClient()
  const settings = useQuery({
    queryKey: ['settings', slug],
    queryFn: () => adminApi.settings(slug),
  })

  const [on, setOn] = useState(false)
  const [form, setForm] = useState({
    host: '',
    port: 514,
    protocol: 'udp' as 'udp' | 'tcp',
    facility: 16,
    format: 'rfc5424' as 'rfc5424' | 'json',
    appName: 'tern',
  })
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const syslog = settings.data?.syslog
    setOn(Boolean(syslog))
    if (syslog) setForm(syslog)
  }, [settings.data])

  const save = useMutation({
    mutationFn: (syslog: null | typeof form) => adminApi.updateSettings(slug, { syslog }),
    onSuccess: async () => {
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['settings', slug] })
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  })

  const test = useMutation({
    mutationFn: () => adminApi.testSyslog(slug),
    onSuccess: (r) => setResult({ ok: r.sent, detail: r.detail }),
    onError: (err) =>
      setResult({ ok: false, detail: err instanceof ApiError ? err.message : String(err) }),
  })

  if (settings.isPending) return <p>Loading…</p>
  if (settings.isError) return <Banner tone="down">Could not read the settings.</Banner>

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      {error && <Banner tone="down">{error}</Banner>}

      <Card>
        <h2 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-base)' }}>
          Mirror to a syslog collector
        </h2>
        <p
          className="measure"
          style={{
            margin: '0 0 var(--space-3)',
            fontSize: 'var(--text-sm)',
            color: 'var(--color-fg-subtle)',
          }}
        >
          {/* The word that matters is "mirror". */}
          Every audit entry is also sent to your collector. <strong>Mirrored, not moved</strong> —
          the local trail stays whatever happens to the far end, because a record that only exists
          on a host you cannot reach during an incident is not a record you have. A collector that
          is down is never allowed to fail the action that produced the entry.
        </p>

        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <input
            type="checkbox"
            checked={on}
            disabled={!canWrite}
            onChange={(e) => {
              setOn(e.target.checked)
              if (!e.target.checked) save.mutate(null)
            }}
            style={{ width: 20, height: 20 }}
          />
          <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>Forward audit entries</span>
        </label>

        {on && (
          <div style={{ marginTop: 'var(--space-4)', display: 'grid', gap: 'var(--space-3)' }}>
            <div className="facts">
              <Field label="Host">
                <Input
                  value={form.host}
                  disabled={!canWrite}
                  placeholder="logs.example.com"
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                />
              </Field>
              <Field label="Port" hint="514 by convention.">
                <Input
                  type="number"
                  value={form.port}
                  disabled={!canWrite}
                  onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
                />
              </Field>
              <Field label="Transport" hint="UDP cannot confirm delivery; TCP can.">
                <select
                  value={form.protocol}
                  disabled={!canWrite}
                  onChange={(e) => setForm({ ...form, protocol: e.target.value as 'udp' | 'tcp' })}
                  style={selectStyle}
                >
                  <option value="udp">UDP</option>
                  <option value="tcp">TCP</option>
                </select>
              </Field>
              <Field label="Facility" hint="Application logs belong in local0–local7.">
                <select
                  value={form.facility}
                  disabled={!canWrite}
                  onChange={(e) => setForm({ ...form, facility: Number(e.target.value) })}
                  style={selectStyle}
                >
                  {FACILITIES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Format" hint="RFC 5424 parses without a custom rule.">
                <select
                  value={form.format}
                  disabled={!canWrite}
                  onChange={(e) =>
                    setForm({ ...form, format: e.target.value as 'rfc5424' | 'json' })
                  }
                  style={selectStyle}
                >
                  <option value="rfc5424">RFC 5424</option>
                  <option value="json">JSON payload</option>
                </select>
              </Field>
              <Field label="App name" hint="The tag your collector will file this under.">
                <Input
                  value={form.appName}
                  disabled={!canWrite}
                  onChange={(e) => setForm({ ...form, appName: e.target.value })}
                />
              </Field>
            </div>

            {canWrite && (
              <div className="form-actions">
                <Button
                  busy={test.isPending}
                  disabled={!settings.data?.syslog}
                  onClick={() => test.mutate()}
                >
                  Send a test line
                </Button>
                <Button
                  variant="primary"
                  busy={save.isPending}
                  disabled={!form.host}
                  onClick={() => save.mutate(form)}
                >
                  Save collector
                </Button>
              </div>
            )}

            {result && <Banner tone={result.ok ? 'operational' : 'down'}>{result.detail}</Banner>}
          </div>
        )}
      </Card>
    </div>
  )
}

const table: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 'var(--text-sm)',
  minWidth: '44rem',
}

const cell: React.CSSProperties = {
  padding: 'var(--space-2) var(--space-3) var(--space-2) 0',
  verticalAlign: 'top',
  fontWeight: 'inherit',
}

const selectStyle: React.CSSProperties = {
  background: 'var(--color-bg)',
  color: 'var(--color-fg)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 'var(--radius-sm)',
  padding: 'var(--space-2) var(--space-3)',
  fontSize: 'var(--text-base)',
  fontFamily: 'inherit',
  minHeight: 44,
  width: '100%',
}

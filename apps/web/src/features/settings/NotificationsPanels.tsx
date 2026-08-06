import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminApi, ApiError } from '../../lib/adminApi'
import { Tabs } from '../../components/Tabs'
import { Banner, Button, Card, CodeBlock, EmptyState, Field, Input } from '../../components/ui'

/**
 * Mail and webhooks — alternatives, not a sequence.
 *
 * They were stacked, which read as a checklist to work through. Most tenants
 * use one of the two. Tabs say "one of these"; stacking says "all of these".
 */
export function NotificationsPanels({ slug, canWrite }: { slug: string; canWrite: boolean }) {
  const [tab, setTab] = useState('email')
  const hooks = useQuery({ queryKey: ['webhooks', slug], queryFn: () => adminApi.webhooks(slug) })

  return (
    <Tabs
      label="Notification channels"
      active={tab}
      onChange={setTab}
      tabs={[
        { id: 'email', label: 'Email' },
        {
          id: 'outbound',
          label: 'Outbound webhooks',
          badge: hooks.data?.length ? String(hooks.data.length) : undefined,
        },
        { id: 'inbound', label: 'Inbound webhooks' },
      ]}
    >
      {tab === 'email' && <EmailPanel slug={slug} canWrite={canWrite} />}
      {tab === 'outbound' && <OutboundPanel slug={slug} canWrite={canWrite} />}
      {tab === 'inbound' && <InboundPanel slug={slug} />}
    </Tabs>
  )
}

// ── Email ───────────────────────────────────────────────────────────────────

function EmailPanel({ slug, canWrite }: { slug: string; canWrite: boolean }) {
  const queryClient = useQueryClient()
  const settings = useQuery({
    queryKey: ['settings', slug],
    queryFn: () => adminApi.settings(slug),
  })

  const [override, setOverride] = useState(false)
  const [form, setForm] = useState({
    host: '',
    port: 587,
    secure: true,
    user: '',
    password: '',
    from: '',
  })
  const [to, setTo] = useState('')
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const smtp = settings.data?.smtp
    setOverride(Boolean(smtp))
    if (smtp) {
      setForm({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        user: smtp.user ?? '',
        // Never prefilled — there is nothing to prefill it with. Left blank it
        // keeps whatever is stored.
        password: '',
        from: smtp.from,
      })
    }
  }, [settings.data])

  const save = useMutation({
    mutationFn: (smtp: null | typeof form) =>
      adminApi.updateSettings(slug, {
        smtp: smtp
          ? {
              host: smtp.host,
              port: Number(smtp.port),
              secure: smtp.secure,
              user: smtp.user || undefined,
              password: smtp.password || undefined,
              from: smtp.from,
            }
          : null,
      }),
    onSuccess: async () => {
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['settings', slug] })
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  })

  const test = useMutation({
    mutationFn: () => adminApi.testMail(slug, to),
    onSuccess: (r) => setResult({ ok: r.sent, detail: r.detail }),
    onError: (err) =>
      setResult({ ok: false, detail: err instanceof ApiError ? err.message : String(err) }),
  })

  if (settings.isPending) return <p>Loading…</p>
  if (settings.isError || !settings.data)
    return <Banner tone="down">Could not read the settings.</Banner>

  const instance = settings.data.instanceSmtp

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      {error && <Banner tone="down">{error}</Banner>}

      <Card>
        <h2 style={{ margin: '0 0 var(--space-3)', fontSize: 'var(--text-base)' }}>Sender</h2>

        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <SenderChoice
            selected={!override}
            disabled={!canWrite}
            label="Use the instance's mail"
            hint={`${instance.host}:${instance.port} as ${instance.from}`}
            onSelect={() => {
              setOverride(false)
              save.mutate(null)
            }}
          />
          <SenderChoice
            selected={override}
            disabled={!canWrite}
            label="Send as this tenant"
            hint="Your own server, your own domain, your own deliverability."
            onSelect={() => setOverride(true)}
          />
        </div>

        {override && (
          <div style={{ marginTop: 'var(--space-4)', display: 'grid', gap: 'var(--space-3)' }}>
            <div className="facts">
              <Field label="Host">
                <Input
                  value={form.host}
                  disabled={!canWrite}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                />
              </Field>
              <Field label="Port" hint="587 with STARTTLS, 465 implicit.">
                <Input
                  type="number"
                  value={form.port}
                  disabled={!canWrite}
                  onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
                />
              </Field>
              <Field label="Username" hint="Blank for an unauthenticated relay.">
                <Input
                  value={form.user}
                  disabled={!canWrite}
                  onChange={(e) => setForm({ ...form, user: e.target.value })}
                />
              </Field>
              <Field
                label="Password"
                hint={
                  settings.data.smtp?.hasPassword
                    ? 'One is stored. Leave blank to keep it.'
                    : 'Stored encrypted; never shown again.'
                }
              >
                <Input
                  type="password"
                  value={form.password}
                  disabled={!canWrite}
                  autoComplete="new-password"
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
              </Field>
            </div>

            <Field label="From" hint="TERN Status &lt;status@example.com&gt;">
              <Input
                value={form.from}
                disabled={!canWrite}
                onChange={(e) => setForm({ ...form, from: e.target.value })}
              />
            </Field>

            <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <input
                type="checkbox"
                checked={form.secure}
                disabled={!canWrite}
                onChange={(e) => setForm({ ...form, secure: e.target.checked })}
                style={{ width: 20, height: 20 }}
              />
              <span style={{ fontSize: 'var(--text-sm)' }}>
                Implicit TLS (port 465). Leave off for STARTTLS on 587.
              </span>
            </label>

            {canWrite && (
              <div>
                <Button
                  variant="primary"
                  busy={save.isPending}
                  disabled={!form.host || !form.from}
                  onClick={() => save.mutate(form)}
                >
                  Save sender
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card>
        <h2 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-base)' }}>
          Prove it works
        </h2>
        <p
          className="measure"
          style={{
            margin: '0 0 var(--space-3)',
            fontSize: 'var(--text-sm)',
            color: 'var(--color-fg-subtle)',
          }}
        >
          &ldquo;Configured&rdquo; and &ldquo;working&rdquo; are different claims, and only one is
          worth anything during an incident. The test goes through whichever sender is selected
          above.
        </p>
        <div style={{ display: 'grid', gap: 'var(--space-3)', maxWidth: '28rem' }}>
          <Field label="Send a test to">
            <Input
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="you@example.com"
            />
          </Field>
          <div>
            <Button
              variant="primary"
              busy={test.isPending}
              disabled={!to.includes('@')}
              onClick={() => test.mutate()}
            >
              Send test
            </Button>
          </div>
        </div>
        {result && (
          <div style={{ marginTop: 'var(--space-3)' }}>
            <Banner tone={result.ok ? 'operational' : 'down'}>{result.detail}</Banner>
          </div>
        )}
      </Card>
    </div>
  )
}

function SenderChoice({
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
        flex: '1 1 16rem',
        textAlign: 'left',
        minHeight: 44,
        padding: 'var(--space-3)',
        borderRadius: 'var(--radius-md)',
        border: `1px solid ${selected ? 'var(--color-accent)' : 'var(--color-border)'}`,
        background: selected ? 'var(--color-accent-soft)' : 'var(--color-surface)',
        color: 'var(--color-fg)',
        fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <span style={{ display: 'block', fontWeight: 600, fontSize: 'var(--text-sm)' }}>{label}</span>
      <span
        className="tabular"
        style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}
      >
        {hint}
      </span>
    </button>
  )
}

// ── Outbound ────────────────────────────────────────────────────────────────

const OUTBOUND_EXAMPLE = `{
  "type": "incident.updated",
  "tenant": "acme",
  "occurredAt": "2026-08-06T09:41:12.004Z",
  "incident": {
    "id": "6f1c…",
    "title": "Elevated error rate on the API",
    "severity": "major",
    "status": "identified",
    "startedAt": "2026-08-06T09:12:00.000Z",
    "resolvedAt": null,
    "url": "https://status.example.com/s/acme",
    "impacts": [{ "controlKey": "api-gateway", "impact": "partial" }]
  },
  "update": {
    "body": "We have identified a bad deploy and are rolling back.",
    "postedAt": "2026-08-06T09:41:12.004Z"
  }
}`

function OutboundPanel({ slug, canWrite }: { slug: string; canWrite: boolean }) {
  const queryClient = useQueryClient()
  const hooks = useQuery({ queryKey: ['webhooks', slug], queryFn: () => adminApi.webhooks(slug) })

  const [url, setUrl] = useState('')
  const [created, setCreated] = useState<{ secret: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tested, setTested] = useState<Record<string, { ok: boolean; detail: string }>>({})

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['webhooks', slug] })

  const add = useMutation({
    mutationFn: () => adminApi.addWebhook(slug, url),
    onSuccess: async (r) => {
      setCreated({ secret: r.secret })
      setUrl('')
      setError(null)
      await invalidate()
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  })

  const test = useMutation({
    mutationFn: (id: string) => adminApi.testWebhook(slug, id).then((r) => ({ id, ...r })),
    onSuccess: (r) => setTested((prev) => ({ ...prev, [r.id]: { ok: r.sent, detail: r.detail } })),
  })

  const remove = useMutation({
    mutationFn: (id: string) => adminApi.removeWebhook(slug, id),
    onSuccess: () => invalidate(),
  })

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      {error && <Banner tone="down">{error}</Banner>}
      {created && (
        <div>
          <Banner tone="degraded">Copy this signing secret now — it is not shown again.</Banner>
          <CodeBlock label="signing secret">{created.secret}</CodeBlock>
        </div>
      )}

      <Card>
        <h2 style={{ margin: '0 0 var(--space-3)', fontSize: 'var(--text-base)' }}>Endpoints</h2>

        {hooks.isPending ? (
          <p>Loading…</p>
        ) : hooks.data && hooks.data.length > 0 ? (
          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            {hooks.data.map((hook) => (
              <div
                key={hook.id}
                style={{
                  display: 'flex',
                  gap: 'var(--space-3)',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  padding: 'var(--space-2) 0',
                  borderTop: '1px solid var(--color-border)',
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <code style={{ fontSize: 'var(--text-sm)', wordBreak: 'break-all' }}>
                    {hook.url}
                  </code>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}>
                    {hook.hasSecret ? 'signed' : 'unsigned'}
                    {tested[hook.id] && ` · ${tested[hook.id]!.detail}`}
                  </div>
                </div>
                {canWrite && (
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <Button busy={test.isPending} onClick={() => test.mutate(hook.id)}>
                      Test
                    </Button>
                    <Button variant="danger" onClick={() => remove.mutate(hook.id)}>
                      Remove
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No webhooks yet"
            hint="Add one to have incident updates delivered to Slack, a bridge, or your own service."
          />
        )}

        {canWrite && (
          <div style={{ display: 'grid', gap: 'var(--space-3)', marginTop: 'var(--space-4)' }}>
            <Field
              label="Endpoint URL"
              hint="Must be reachable from this server, and not on its own network."
            >
              <Input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://hooks.example.com/tern"
              />
            </Field>
            <div>
              <Button
                variant="primary"
                busy={add.isPending}
                disabled={!url.startsWith('http')}
                onClick={() => add.mutate()}
              >
                Add webhook
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* The part that was missing: what actually arrives at that URL. */}
      <Card>
        <h2 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-base)' }}>
          What we send you
        </h2>
        <p
          className="measure"
          style={{
            margin: '0 0 var(--space-3)',
            fontSize: 'var(--text-sm)',
            color: 'var(--color-fg-subtle)',
          }}
        >
          One POST per incident or maintenance update. Two headers carry the signature; verify them
          before trusting the body.
        </p>

        <dl className="tabular" style={headerList}>
          <dt style={headerName}>X-Tern-Timestamp</dt>
          <dd style={headerDetail}>
            Unix seconds. Reject anything more than a few minutes old — that is what stops a
            captured payload being replayed.
          </dd>
          <dt style={headerName}>X-Tern-Signature</dt>
          <dd style={headerDetail}>
            <code>sha256=…</code>, an HMAC over <code>&lt;timestamp&gt;.&lt;raw body&gt;</code> with
            your signing secret. Signing the body alone would leave it replayable for ever.
          </dd>
          <dt style={headerName}>Content-Type</dt>
          <dd style={headerDetail}>
            <code>application/json</code>. Compare the signature against the <em>raw</em> bytes, not
            against re-serialised JSON.
          </dd>
        </dl>

        <div style={{ marginTop: 'var(--space-3)' }}>
          <CodeBlock label="POST your endpoint">{OUTBOUND_EXAMPLE}</CodeBlock>
        </div>

        <p
          className="measure"
          style={{
            margin: 'var(--space-3) 0 0',
            fontSize: 'var(--text-xs)',
            color: 'var(--color-fg-subtle)',
          }}
        >
          <code>type</code> is one of <code>incident.opened</code>, <code>incident.updated</code>,{' '}
          <code>incident.resolved</code>, <code>maintenance.scheduled</code>,{' '}
          <code>maintenance.started</code>, <code>maintenance.completed</code>, or <code>test</code>
          . Answer 2xx to acknowledge; anything else is retried.
        </p>
      </Card>
    </div>
  )
}

// ── Inbound ─────────────────────────────────────────────────────────────────

const INBOUND_EXAMPLE = `{
  "controlKey": "api-gateway",
  "status": "down",
  "latencyMs": 4200,
  "message": "5xx rate above 10% for 3 minutes",
  "metrics": { "errorRate": 0.14 },
  "ts": "2026-08-06T09:12:00Z"
}`

function InboundPanel({ slug }: { slug: string }) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <Card>
        <h2 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-base)' }}>
          What you can send us
        </h2>
        <p
          className="measure"
          style={{
            margin: '0 0 var(--space-3)',
            fontSize: 'var(--text-sm)',
            color: 'var(--color-fg-subtle)',
          }}
        >
          A receiver turns an alert from a system you already run into a measurement here. Each has
          its own URL carrying an opaque token — the token <em>is</em> the credential, so a receiver
          URL is as sensitive as a key.
        </p>

        <CodeBlock label={`POST /api/v1/receivers/<id>/<token>`}>{INBOUND_EXAMPLE}</CodeBlock>

        <p
          className="measure"
          style={{
            margin: 'var(--space-3) 0 0',
            fontSize: 'var(--text-sm)',
            color: 'var(--color-fg-muted)',
          }}
        >
          That is the <strong>generic</strong> shape. A receiver created for a named source parses
          that source&rsquo;s own payload instead, so nothing has to be reshaped on the way out of
          it.
        </p>

        <div style={{ overflowX: 'auto', marginTop: 'var(--space-3)' }}>
          <table style={table}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--color-fg-subtle)' }}>
                <th style={cell}>Source</th>
                <th style={cell}>What it reads</th>
              </tr>
            </thead>
            <tbody>
              {[
                [
                  'alertmanager',
                  'Prometheus Alertmanager v4 — `alerts[]`, with `status` and `labels`',
                ],
                ['grafana', 'Grafana unified alerting — `alerts[]` and `state`'],
                ['uptimerobot', 'UptimeRobot — `alertType`, `monitorFriendlyName`'],
                ['zabbix', 'Zabbix webhook media type — subject and severity'],
                ['pagerduty', 'PagerDuty v3 — `event.event_type` and `event.data`'],
                ['healthchecks', 'Healthchecks.io — check name and `status`'],
                ['generic', 'The shape above, unchanged'],
              ].map(([id, what]) => (
                <tr key={id} style={{ borderTop: '1px solid var(--color-border)' }}>
                  <td style={cell}>
                    <code>{id}</code>
                  </td>
                  <td style={{ ...cell, color: 'var(--color-fg-muted)' }}>{what}</td>
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
          A receiver maps the source&rsquo;s own identifier onto a control key. An unmapped
          identifier is reported back by name rather than guessed at — silently inventing a control
          from an alert label is how a status page grows components nobody meant to publish.
          Receivers are created through the API today; managing them here is not built yet.
        </p>
      </Card>

      <Card>
        <h2 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-base)' }}>
          Or push directly
        </h2>
        <p
          className="measure"
          style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)' }}
        >
          If you control the sender, an API key and <code>POST /api/v1/ingest</code> is simpler than
          a receiver — and the editor generates that call for you in ten languages. Open a
          control&rsquo;s <em>Script</em> step, or its <em>Preview</em> step for the exact fields
          each widget reads. See <code>/app/{slug}</code>.
        </p>
      </Card>
    </div>
  )
}

const headerList: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  gap: 'var(--space-2) var(--space-4)',
  margin: 0,
  fontSize: 'var(--text-sm)',
}

const headerName: React.CSSProperties = {
  fontWeight: 600,
  whiteSpace: 'nowrap',
}

const headerDetail: React.CSSProperties = {
  margin: 0,
  color: 'var(--color-fg-muted)',
}

const table: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 'var(--text-sm)',
  minWidth: '30rem',
}

const cell: React.CSSProperties = {
  padding: 'var(--space-2) var(--space-3) var(--space-2) 0',
  verticalAlign: 'top',
  fontWeight: 'inherit',
}

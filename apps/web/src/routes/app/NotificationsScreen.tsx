import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminApi, ApiError } from '../../lib/adminApi'
import { Banner, Button, Card, CodeBlock, EmptyState, Field, Input } from '../../components/ui'

/**
 * Where notifications go, and proof that they get there.
 *
 * The two halves are deliberately asymmetric. Mail is one connection per
 * deployment and is shown read-only — a form that pretended to change SMTP would
 * either lie or let one tenant break mail for every other. Webhooks are per
 * tenant and self-service, because a wrong URL harms only the tenant that typed
 * it.
 *
 * Both offer a test, because "configured" and "working" are different claims and
 * only one of them is worth anything during an incident.
 */
export function NotificationsScreen({ slug, canWrite }: { slug: string; canWrite: boolean }) {
  return (
    <section style={{ paddingTop: 'var(--space-6)', display: 'grid', gap: 'var(--space-5)' }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 'var(--text-xl)' }}>Notifications</h1>
        <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--color-fg-subtle)' }}>
          How incident and maintenance updates leave TERN.
        </p>
      </div>

      <MailPanel slug={slug} canWrite={canWrite} />
      <WebhookPanel slug={slug} canWrite={canWrite} />
    </section>
  )
}

function MailPanel({ slug, canWrite }: { slug: string; canWrite: boolean }) {
  const mail = useQuery({ queryKey: ['mail', slug], queryFn: () => adminApi.mailSettings(slug) })
  const [to, setTo] = useState('')
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null)

  const test = useMutation({
    mutationFn: () => adminApi.testMail(slug, to),
    onSuccess: (r) => setResult({ ok: r.sent, detail: r.detail }),
    onError: (err) =>
      setResult({ ok: false, detail: err instanceof ApiError ? err.message : String(err) }),
  })

  return (
    <Card>
      <h2 style={{ margin: '0 0 var(--space-3)', fontSize: 'var(--text-base)' }}>Email</h2>

      {mail.isPending ? (
        <p style={{ color: 'var(--color-fg-subtle)', margin: 0 }}>Reading the settings…</p>
      ) : mail.isError || !mail.data ? (
        <Banner tone="down">Could not read the mail settings.</Banner>
      ) : (
        <>
          <dl
            className="tabular"
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: 'var(--space-2) var(--space-4)',
              margin: '0 0 var(--space-3)',
              fontSize: 'var(--text-sm)',
            }}
          >
            <dt style={{ color: 'var(--color-fg-subtle)' }}>Server</dt>
            <dd style={{ margin: 0 }}>
              {mail.data.host}:{mail.data.port} {mail.data.secure ? '(TLS)' : '(no TLS)'}
            </dd>
            <dt style={{ color: 'var(--color-fg-subtle)' }}>From</dt>
            <dd style={{ margin: 0 }}>{mail.data.from}</dd>
            <dt style={{ color: 'var(--color-fg-subtle)' }}>Credentials</dt>
            <dd style={{ margin: 0 }}>{mail.data.authenticated ? 'configured' : 'none'}</dd>
          </dl>

          <p
            style={{
              margin: '0 0 var(--space-3)',
              fontSize: 'var(--text-xs)',
              color: 'var(--color-fg-subtle)',
            }}
          >
            {/* Said plainly, so nobody hunts for an edit button that should not
                exist. */}
            Set in the environment (<code>SMTP_HOST</code>, <code>SMTP_PORT</code>,{' '}
            <code>SMTP_SECURE</code>, <code>MAIL_FROM</code>) and shared by every tenant on this
            instance — so it is not editable here.
          </p>

          {canWrite && (
            <div style={{ display: 'grid', gap: 'var(--space-3)', maxWidth: '28rem' }}>
              <Field
                label="Send a test to"
                hint="Proves the settings work, not just that they parse."
              >
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
          )}

          {result && (
            <div style={{ marginTop: 'var(--space-3)' }}>
              <Banner tone={result.ok ? 'operational' : 'down'}>{result.detail}</Banner>
            </div>
          )}
        </>
      )}
    </Card>
  )
}

function WebhookPanel({ slug, canWrite }: { slug: string; canWrite: boolean }) {
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
    <Card>
      <h2 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-base)' }}>
        Outbound webhooks
      </h2>
      <p
        style={{
          margin: '0 0 var(--space-3)',
          fontSize: 'var(--text-sm)',
          color: 'var(--color-fg-subtle)',
        }}
      >
        Every incident and maintenance update is POSTed to these, signed with a shared secret over{' '}
        <code>&lt;timestamp&gt;.&lt;body&gt;</code> so a captured payload cannot be replayed.
      </p>

      {error && <Banner tone="down">{error}</Banner>}

      {created && (
        <div style={{ marginBottom: 'var(--space-3)' }}>
          <Banner tone="degraded">
            {/* Shown once, like every other secret here. */}
            Copy this signing secret now — it is not shown again.
          </Banner>
          <CodeBlock label="X-Tern-Signature secret">{created.secret}</CodeBlock>
        </div>
      )}

      {hooks.isPending ? (
        <p style={{ color: 'var(--color-fg-subtle)', margin: 0 }}>Loading…</p>
      ) : hooks.data && hooks.data.length > 0 ? (
        <div style={{ display: 'grid', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
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
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <EmptyState
            title="No webhooks yet"
            hint="Add one to have incident updates delivered to Slack, a bridge, or your own service."
          />
        </div>
      )}

      {canWrite && (
        <div style={{ display: 'grid', gap: 'var(--space-3)', maxWidth: '38rem' }}>
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
  )
}

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminApi, ApiError, type Agent } from '../../lib/adminApi'
import { AgentGalaxy, freshnessOf } from '../../charts/AgentGalaxy'
import { Banner, Button, Card, CodeBlock, EmptyState, Field, Input } from '../../components/ui'

/**
 * The fleet.
 *
 * Two views of the same list, deliberately: a picture for "is anything wrong out
 * there", and a table for everything the picture cannot say — versions,
 * architectures, exact timestamps, and the controls that change them. The
 * picture is never the only way to reach an agent, because a diagram is not
 * something a screen reader or a keyboard can work through.
 */
export function FleetScreen({ slug, canWrite }: { slug: string; canWrite: boolean }) {
  const agents = useQuery({
    queryKey: ['agents', slug],
    queryFn: () => adminApi.agents(slug),
    // A fleet screen left open should not go stale: the whole point is seeing
    // an agent go quiet.
    refetchInterval: 30_000,
  })

  const [selected, setSelected] = useState<string | null>(null)
  const [pairing, setPairing] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [confirmBulk, setConfirmBulk] = useState<'revoke' | 'delete' | null>(null)

  const queryClient = useQueryClient()
  const bulk = useMutation({
    mutationFn: (action: 'revoke' | 'delete') => adminApi.bulkAgents(slug, [...picked], action),
    onSuccess: async () => {
      setPicked(new Set())
      setConfirmBulk(null)
      await queryClient.invalidateQueries({ queryKey: ['agents', slug] })
    },
  })

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  if (agents.isPending) return <p style={{ paddingTop: 'var(--space-6)' }}>Loading the fleet…</p>
  if (agents.isError) return <Banner tone="down">Could not load the agents.</Banner>

  const live = agents.data.filter((a) => a.status !== 'revoked')
  const now = Date.now()
  const quiet = live.filter((a) => freshnessOf(a, now) !== 'fresh')

  return (
    <section style={{ paddingTop: 'var(--space-6)', display: 'grid', gap: 'var(--space-5)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 'var(--text-xl)' }}>Agents</h1>
          <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--color-fg-subtle)' }}>
            {live.length} active
            {agents.data.length > live.length && `, ${agents.data.length - live.length} revoked`}
            {quiet.length > 0 && ` · ${quiet.length} not reporting`}
          </p>
        </div>
        {/* Adding an agent starts here, where the fleet is — not buried in a
            control's Script step, which is where it used to be the only way. */}
        {canWrite && (
          <Button variant="primary" onClick={() => setPairing((v) => !v)}>
            {pairing ? 'Cancel' : 'Add an agent'}
          </Button>
        )}
      </div>

      {pairing && <PairPanel slug={slug} onDone={() => setPairing(false)} />}

      {/* A bar rather than a per-row menu: the whole point of selecting several
          is to act on them once. */}
      {canWrite && picked.size > 0 && (
        <Card>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
              flexWrap: 'wrap',
            }}
          >
            <strong style={{ flex: 1, minWidth: 0 }}>{picked.size} selected</strong>
            <Button onClick={() => setPicked(new Set())}>Clear</Button>
            <Button onClick={() => setConfirmBulk('revoke')}>Revoke</Button>
            <Button variant="danger" onClick={() => setConfirmBulk('delete')}>
              Delete
            </Button>
          </div>

          {confirmBulk && (
            <div style={{ marginTop: 'var(--space-3)' }}>
              <Banner tone="down">
                {/* The two verbs are not the same act, and the difference is
                    what someone needs to know before pressing either. */}
                {confirmBulk === 'revoke'
                  ? `Revoke ${picked.size} agent(s)? Their keys stop working immediately; the records stay, so the fleet still shows they existed.`
                  : `Delete ${picked.size} agent(s)? Their keys are revoked and the records are removed. The audit log keeps which ones — nothing else will.`}
              </Banner>
              <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                <Button
                  variant="danger"
                  busy={bulk.isPending}
                  onClick={() => bulk.mutate(confirmBulk)}
                >
                  {confirmBulk === 'revoke' ? 'Revoke them' : 'Delete them'}
                </Button>
                <Button onClick={() => setConfirmBulk(null)}>Keep them</Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {agents.data.length === 0 ? (
        <EmptyState
          title="No agents yet"
          hint="Press “Add an agent” above for a pairing code. Pairing hands the agent its probes, so there is nothing to copy onto the host and nothing to keep in step by hand."
        />
      ) : (
        <div className="split">
          <div className="split-aside">
            <Card>
              <AgentGalaxy
                agents={agents.data}
                now={now}
                size={320}
                selectedId={selected}
                onSelect={setSelected}
              />
            </Card>
          </div>

          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            {agents.data.map((agent) => (
              <AgentRow
                key={agent.id}
                slug={slug}
                agent={agent}
                canWrite={canWrite}
                selected={agent.id === selected}
                onSelect={() => setSelected(agent.id)}
                picked={picked.has(agent.id)}
                onPick={() => toggle(agent.id)}
                now={now}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

/**
 * A PIN, and the command it goes in.
 *
 * Minted on the button rather than delivered with the page: a pairing code is a
 * short-lived credential, and one arriving with every page view would sit in a
 * cache and in the back button, unused and valid.
 */
function PairPanel({ slug, onDone }: { slug: string; onDone: () => void }) {
  const pair = useMutation({ mutationFn: () => adminApi.createPairingCode(slug) })
  // This instance's own address: the installer is served by the same origin the
  // browser is already talking to.
  const origin = window.location.origin

  return (
    <Card>
      <h2 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-base)' }}>Add an agent</h2>

      {pair.data ? (
        <>
          <p
            className="measure"
            style={{
              margin: '0 0 var(--space-3)',
              fontSize: 'var(--text-sm)',
              color: 'var(--color-fg-subtle)',
            }}
          >
            Run this on the machine to monitor. It fetches the agent from this instance, installs
            it, and pairs — the agent receives its key <em>and</em> the probes it is meant to run,
            so there is no config to copy across.
          </p>

          <CodeBlock label="Linux or macOS">
            {`curl -fsSL ${origin}/install.sh | sh -s -- --pin ${pair.data.pin}`}
          </CodeBlock>

          <div style={{ height: 'var(--space-2)' }} />

          <CodeBlock label="Windows, in PowerShell">
            {/* A param script, so it is invoked as a script block — `| iex`
                would run it with no arguments and never see the PIN. */}
            {`& ([scriptblock]::Create((irm ${origin}/install.ps1))) -Pin ${pair.data.pin}`}
          </CodeBlock>

          <details style={{ marginTop: 'var(--space-3)' }}>
            <summary
              style={{
                cursor: 'pointer',
                fontSize: 'var(--text-sm)',
                color: 'var(--color-fg-muted)',
              }}
            >
              {/* Piping a URL into a shell deserves a way out of it. */}
              Rather not pipe a URL into a shell?
            </summary>
            <p
              className="measure"
              style={{
                margin: 'var(--space-2) 0',
                fontSize: 'var(--text-sm)',
                color: 'var(--color-fg-subtle)',
              }}
            >
              Open <code>{origin}/install.sh</code> and read it first — it is short and does nothing
              clever. Or download the binary yourself and pair by hand:
            </p>
            <CodeBlock label="by hand">{pair.data.pairCommand}</CodeBlock>
          </details>
          <p
            className="tabular"
            style={{
              margin: 'var(--space-2) 0 0',
              fontSize: 'var(--text-xs)',
              color: 'var(--color-fg-subtle)',
            }}
          >
            Single use, expires at {new Date(pair.data.expiresAt).toLocaleTimeString()}.
          </p>
          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
            <Button onClick={() => pair.mutate()}>Another PIN</Button>
            <Button onClick={onDone}>Done</Button>
          </div>
        </>
      ) : (
        <>
          <p
            className="measure"
            style={{
              margin: '0 0 var(--space-3)',
              fontSize: 'var(--text-sm)',
              color: 'var(--color-fg-subtle)',
            }}
          >
            Pairing exchanges a short PIN for a long-lived key, so no credential is ever copied by
            hand onto a host.
          </p>
          <Button variant="primary" busy={pair.isPending} onClick={() => pair.mutate()}>
            Generate a PIN
          </Button>
          {pair.isError && (
            <div style={{ marginTop: 'var(--space-2)' }}>
              <Banner tone="down">Could not generate a pairing code.</Banner>
            </div>
          )}
        </>
      )}
    </Card>
  )
}

/**
 * What the instance's own agent can and cannot see.
 *
 * The question this answers is "why is my check on localhost down", and it is
 * asked by someone who has no reason to know that the agent runs in a container
 * whose loopback is not the machine's. Left unsaid, the check simply fails and
 * the address looks right — the worst combination to debug.
 *
 * Stated, not offered as a control. `network_mode` is fixed when the container
 * is created; this process has no Docker socket to change it with, and giving
 * it one would be root on the host. A button here would be a button that lies.
 *
 * The blind spots are measured rather than assumed: with a shared namespace,
 * outbound to the internet and to the compose network works, `127.0.0.1` means
 * the API's container, and other Docker networks are cut off by bridge
 * isolation.
 */
function Vantage({ mode }: { mode: string }) {
  const host = mode === 'host'

  return (
    <details style={{ marginTop: 'var(--space-1)' }}>
      <summary
        style={{
          fontSize: 'var(--text-xs)',
          color: 'var(--color-fg-subtle)',
          cursor: 'pointer',
        }}
      >
        Measures from {host ? 'this machine' : 'inside its container'}
      </summary>
      <div
        style={{
          marginTop: 'var(--space-2)',
          fontSize: 'var(--text-xs)',
          color: 'var(--color-fg-subtle)',
          lineHeight: 1.6,
        }}
      >
        {host ? (
          <p style={{ margin: 0 }}>
            <strong>Can reach</strong> services on this machine — including those listening only on
            its loopback — its local network, other Docker networks, and the internet.{' '}
            <code>localhost</code> in a check means the machine.
          </p>
        ) : (
          <>
            <p style={{ margin: 0 }}>
              <strong>Can reach</strong> the internet and this instance&rsquo;s own containers.
            </p>
            <p style={{ margin: 'var(--space-2) 0 0' }}>
              <strong>Cannot reach</strong> services listening on this machine&rsquo;s loopback, or
              containers on other Docker networks. In a check, <code>localhost</code> means the
              agent&rsquo;s own container — not this machine — so a check written against it will
              fail however correct the address looks.
            </p>
            <p style={{ margin: 'var(--space-2) 0 0' }}>
              To measure from the machine instead, set these in <code>.env</code> and run{' '}
              <code>docker compose -f docker-compose.prod.yml up -d</code>. Linux only.
            </p>
            <pre
              style={{
                margin: 'var(--space-2) 0 0',
                padding: 'var(--space-2)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--color-bg-subtle)',
                overflowX: 'auto',
              }}
            >
              <code>
                TERN_AGENT_NETWORK_MODE=host{'\n'}
                TERN_LOCAL_AGENT_SERVER=http://127.0.0.1:$TERN_HTTP_PORT
              </code>
            </pre>
          </>
        )}
      </div>
    </details>
  )
}

function AgentRow({
  slug,
  agent,
  canWrite,
  selected,
  onSelect,
  picked,
  onPick,
  now,
}: {
  slug: string
  agent: Agent
  canWrite: boolean
  selected: boolean
  onSelect: () => void
  picked: boolean
  onPick: () => void
  now: number
}) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(agent.name)
  const [site, setSite] = useState(agent.site ?? '')
  const [error, setError] = useState<string | null>(null)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['agents', slug] })

  const save = useMutation({
    mutationFn: () => adminApi.updateAgent(slug, agent.id, { name, site: site.trim() || null }),
    onSuccess: async () => {
      setEditing(false)
      setError(null)
      await invalidate()
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  })

  const revoke = useMutation({
    mutationFn: () => adminApi.revokeAgent(slug, agent.id),
    onSuccess: () => invalidate(),
  })

  const [confirming, setConfirming] = useState(false)
  const [open, setOpen] = useState(false)
  const freshness = freshnessOf(agent, now)
  const revoked = agent.status === 'revoked'

  return (
    <Card
      style={
        selected
          ? { borderColor: 'var(--color-accent)', boxShadow: 'var(--shadow-card)' }
          : undefined
      }
    >
      <div
        onClick={onSelect}
        style={{
          display: 'flex',
          gap: 'var(--space-3)',
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        {/* The instance's own agent is not selectable, because the only two
            bulk actions are revoke and delete and it accepts neither. Offering
            a checkbox that poisons the whole selection with a 409 would be a
            worse way to learn that. */}
        {canWrite && !agent.isLocal && (
          <input
            type="checkbox"
            checked={picked}
            aria-label={`Select ${agent.name}`}
            onClick={(event) => event.stopPropagation()}
            onChange={onPick}
            style={{ width: 20, height: 20, flexShrink: 0 }}
          />
        )}
        {canWrite && agent.isLocal && <span style={{ width: 20, flexShrink: 0 }} />}

        <span
          aria-hidden="true"
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            flexShrink: 0,
            background: revoked
              ? 'var(--color-fg-subtle)'
              : freshness === 'fresh'
                ? 'var(--status-operational)'
                : freshness === 'stale'
                  ? 'var(--status-degraded)'
                  : 'var(--status-down)',
          }}
        />

        <div style={{ minWidth: 0, flex: 1 }}>
          <strong style={{ textDecoration: revoked ? 'line-through' : undefined }}>
            {agent.name}
          </strong>
          {/* Said on the row rather than only in a tooltip on a missing button:
              "why can I not remove this one" is the question, and the answer is
              what it is, not what it lacks. */}
          {agent.isLocal && (
            <span
              title="Provisioned and run by this instance. Set TERN_LOCAL_AGENT=false to turn it off."
              style={{
                marginLeft: 'var(--space-2)',
                padding: '1px var(--space-2)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-fg-subtle)',
                fontSize: 'var(--text-xs)',
                fontWeight: 600,
                whiteSpace: 'nowrap',
              }}
            >
              this instance
            </span>
          )}
          <div
            className="tabular"
            style={{ fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}
          >
            {agent.site ?? 'no site'} · {agent.os ?? 'unknown OS'}
            {agent.arch ? `/${agent.arch}` : ''} · {agent.agentVersion ?? 'version unknown'} ·{' '}
            {lastSeen(agent, now)}
          </div>
          {agent.isLocal && agent.networkMode && <Vantage mode={agent.networkMode} />}
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          {/* The question a fleet screen is actually asked: what is this one
              doing? Answered here rather than by opening every control. */}
          <Button
            ariaLabel={`${open ? 'Hide' : 'Show'} the controls ${agent.name} runs`}
            onClick={() => setOpen((v) => !v)}
            disabled={agent.jobCount === 0}
          >
            {agent.jobCount === 0
              ? 'No probes'
              : `${open ? '▾' : '▸'} ${agent.jobCount} probe${agent.jobCount === 1 ? '' : 's'}`}
          </Button>
          {canWrite && !revoked && (
            <>
              <Button onClick={() => setEditing((v) => !v)}>{editing ? 'Cancel' : 'Rename'}</Button>
              {/* Renaming stays available — it is a label, and an operator
                  running several instances may well want to say which. Only
                  revoking is refused. */}
              {!agent.isLocal && (
                <Button variant="danger" onClick={() => setConfirming(true)}>
                  Revoke
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {open && agent.controls.length > 0 && (
        <ul
          style={{
            listStyle: 'none',
            margin: 'var(--space-3) 0 0',
            padding: 'var(--space-3) 0 0',
            borderTop: '1px solid var(--color-border)',
            display: 'grid',
            gap: 'var(--space-1)',
          }}
        >
          {agent.controls.map((control) => (
            <li
              key={control.id}
              style={{
                display: 'flex',
                gap: 'var(--space-3)',
                alignItems: 'baseline',
                fontSize: 'var(--text-sm)',
              }}
            >
              <span style={{ fontWeight: 600 }}>{control.name}</span>
              <code
                className="tabular"
                style={{ fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}
              >
                {control.key}
              </code>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <div style={{ marginTop: 'var(--space-2)' }}>
          <Banner tone="down">{error}</Banner>
        </div>
      )}

      {editing && (
        <div className="field-row" style={{ gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
          <Field label="Name" hint="What the people running it call it.">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Site" hint="Data centre, customer, region — your words.">
            <Input value={site} onChange={(e) => setSite(e.target.value)} />
          </Field>
          <div>
            <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          </div>
        </div>
      )}

      {confirming && (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <Banner tone="down">
            {/* Named, and not undoable — revoking kills the key with the record,
                so the agent stops being able to push at all. */}
            Revoke “{agent.name}”? Its key is revoked too, so it stops reporting immediately and
            must be paired again.
          </Banner>
          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
            <Button variant="danger" busy={revoke.isPending} onClick={() => revoke.mutate()}>
              Revoke it
            </Button>
            <Button onClick={() => setConfirming(false)}>Keep it</Button>
          </div>
        </div>
      )}
    </Card>
  )
}

function lastSeen(agent: Agent, now: number): string {
  if (agent.status === 'revoked') return 'revoked'
  if (!agent.lastSeenAt) return 'never reported'

  const minutes = Math.floor((now - Date.parse(agent.lastSeenAt)) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

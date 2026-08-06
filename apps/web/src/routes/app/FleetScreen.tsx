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
          hint="Open a control, go to its Script step and choose the Agent tab. Pairing hands the agent its probes — there is nothing to copy."
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
            Run this on the machine to monitor. It receives its key <em>and</em> the probes it is
            meant to run — there is no config to copy across.
          </p>
          <CodeBlock label="on the machine being monitored">{pair.data.pairCommand}</CodeBlock>
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
        {canWrite && (
          <input
            type="checkbox"
            checked={picked}
            aria-label={`Select ${agent.name}`}
            onClick={(event) => event.stopPropagation()}
            onChange={onPick}
            style={{ width: 20, height: 20, flexShrink: 0 }}
          />
        )}

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
          <div
            className="tabular"
            style={{ fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}
          >
            {agent.site ?? 'no site'} · {agent.os ?? 'unknown OS'}
            {agent.arch ? `/${agent.arch}` : ''} · {agent.agentVersion ?? 'version unknown'} ·{' '}
            {lastSeen(agent, now)}
          </div>
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
              <Button variant="danger" onClick={() => setConfirming(true)}>
                Revoke
              </Button>
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
        <div
          style={{
            display: 'grid',
            gap: 'var(--space-3)',
            gridTemplateColumns: '1fr 1fr',
            marginTop: 'var(--space-3)',
          }}
        >
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

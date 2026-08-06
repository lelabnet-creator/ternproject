import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminApi, ApiError, type Agent } from '../../lib/adminApi'
import { AgentGalaxy, freshnessOf } from '../../charts/AgentGalaxy'
import { Banner, Button, Card, EmptyState, Field, Input } from '../../components/ui'

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

  if (agents.isPending) return <p style={{ paddingTop: 'var(--space-6)' }}>Loading the fleet…</p>
  if (agents.isError) return <Banner tone="down">Could not load the agents.</Banner>

  const live = agents.data.filter((a) => a.status !== 'revoked')
  const now = Date.now()
  const quiet = live.filter((a) => freshnessOf(a, now) !== 'fresh')

  return (
    <section style={{ paddingTop: 'var(--space-6)', display: 'grid', gap: 'var(--space-5)' }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 'var(--text-xl)' }}>Agents</h1>
        <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--color-fg-subtle)' }}>
          {live.length} active
          {agents.data.length > live.length && `, ${agents.data.length - live.length} revoked`}
          {quiet.length > 0 && ` · ${quiet.length} not reporting`}
        </p>
      </div>

      {agents.data.length === 0 ? (
        <EmptyState
          title="No agents yet"
          hint="Open a control, go to its Script step and choose the Agent tab. Pairing hands the agent its probes — there is nothing to copy."
        />
      ) : (
        <>
          <Card>
            <AgentGalaxy
              agents={agents.data}
              now={now}
              selectedId={selected}
              onSelect={setSelected}
            />
          </Card>

          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            {agents.data.map((agent) => (
              <AgentRow
                key={agent.id}
                slug={slug}
                agent={agent}
                canWrite={canWrite}
                selected={agent.id === selected}
                onSelect={() => setSelected(agent.id)}
                now={now}
              />
            ))}
          </div>
        </>
      )}
    </section>
  )
}

function AgentRow({
  slug,
  agent,
  canWrite,
  selected,
  onSelect,
  now,
}: {
  slug: string
  agent: Agent
  canWrite: boolean
  selected: boolean
  onSelect: () => void
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
            {agent.jobCount} probe{agent.jobCount === 1 ? '' : 's'} · {lastSeen(agent, now)}
          </div>
        </div>

        {canWrite && !revoked && (
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Button onClick={() => setEditing((v) => !v)}>{editing ? 'Cancel' : 'Rename'}</Button>
            <Button variant="danger" onClick={() => setConfirming(true)}>
              Revoke
            </Button>
          </div>
        )}
      </div>

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

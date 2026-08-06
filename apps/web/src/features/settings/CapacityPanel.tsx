import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { adminApi, ApiError } from '../../lib/adminApi'
import { Banner, Button, Card, Field, Input } from '../../components/ui'

/**
 * Whether the HTTP layer is sized for the fleet that grew since it was
 * configured.
 *
 * Every limit in TERN ships with a default that is right for a small
 * installation and silently wrong for a large one, and nothing in the product
 * said which side of that line a deployment was on. This computes what the fleet
 * asks for, shows it beside what the environment currently allows, and marks the
 * gaps.
 *
 * Read-only, like the mail settings and for the same reason: these are
 * per-process values shared by every tenant on the instance. A form here would
 * either lie or let one tenant throttle another.
 */
export function CapacityPanel({ slug, canWrite }: { slug: string; canWrite: boolean }) {
  const queryClient = useQueryClient()
  const settings = useQuery({
    queryKey: ['settings', slug],
    queryFn: () => adminApi.settings(slug),
  })

  const [what, setWhat] = useState({ intervalS: 60, concurrentViewers: 20 })
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The saved assumptions, not defaults invented afresh each visit: the numbers
  // this screen produces are only as good as what is assumed behind them, and
  // re-typing the shape of your own fleet every time is how they end up wrong.
  useEffect(() => {
    if (settings.data) {
      setWhat(settings.data.sizingAssumptions)
      setDirty(false)
    }
  }, [settings.data])

  const save = useMutation({
    mutationFn: () => adminApi.updateSettings(slug, { sizingAssumptions: what }),
    onSuccess: async () => {
      setError(null)
      setDirty(false)
      await queryClient.invalidateQueries({ queryKey: ['settings', slug] })
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  })
  const [hypothetical, setHypothetical] = useState<{ agents: string; probesPerAgent: string }>({
    agents: '',
    probesPerAgent: '',
  })

  const capacity = useQuery({
    queryKey: ['capacity', slug, what, hypothetical],
    queryFn: () =>
      adminApi.capacity(slug, {
        intervalS: what.intervalS,
        concurrentViewers: what.concurrentViewers,
        agents: hypothetical.agents === '' ? undefined : Number(hypothetical.agents),
        probesPerAgent:
          hypothetical.probesPerAgent === '' ? undefined : Number(hypothetical.probesPerAgent),
      }),
  })

  if (capacity.isPending) return <p>Measuring…</p>
  if (capacity.isError || !capacity.data) {
    return <Banner tone="down">Could not read the capacity settings.</Banner>
  }

  const { measured, effective, sizing } = capacity.data
  const ingestTight =
    effective.ingestRateLimitPerMinute < sizing.recommended.ingestRateLimitPerMinute
  const poolTight = effective.dbPoolMax < sizing.recommended.dbPoolMax

  return (
    <section style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <p className="measure" style={{ margin: 0, color: 'var(--color-fg-subtle)' }}>
        {measured.agents} active agent{measured.agents === 1 ? '' : 's'} · {measured.probes} control
        {measured.probes === 1 ? '' : 's'} · {measured.retentionDays}-day retention
      </p>

      {error && <Banner tone="down">{error}</Banner>}

      {(ingestTight || poolTight) && (
        <Banner tone="degraded">
          {/* The finding, not a scolding: these are defaults, and outgrowing
              them is what success looks like. */}
          This deployment has outgrown at least one default.{' '}
          {ingestTight &&
            `The ingest limit allows ${effective.ingestRateLimitPerMinute}/min and the fleet wants ${sizing.recommended.ingestRateLimitPerMinute}. `}
          {poolTight &&
            `The connection pool holds ${effective.dbPoolMax} and wants ${sizing.recommended.dbPoolMax}.`}
        </Banner>
      )}

      <Card>
        <h2 style={{ margin: '0 0 var(--space-3)', fontSize: 'var(--text-base)' }}>
          What the fleet asks for
        </h2>

        <div
          style={{
            display: 'grid',
            gap: 'var(--space-4)',
            gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))',
            marginBottom: 'var(--space-4)',
          }}
        >
          <Field label="Probe interval (s)" hint="How often each probe runs.">
            <Input
              type="number"
              min={5}
              value={what.intervalS}
              disabled={!canWrite}
              onChange={(e) => {
                setWhat({ ...what, intervalS: Number(e.target.value) || 60 })
                setDirty(true)
              }}
            />
          </Field>
          <Field label="Concurrent viewers" hint="People with the page open at once.">
            <Input
              type="number"
              min={0}
              value={what.concurrentViewers}
              disabled={!canWrite}
              onChange={(e) => {
                setWhat({ ...what, concurrentViewers: Number(e.target.value) || 0 })
                setDirty(true)
              }}
            />
          </Field>
          <Field label="Agents" hint={`Blank = measured (${measured.agents}).`}>
            <Input
              type="number"
              min={0}
              value={hypothetical.agents}
              onChange={(e) => setHypothetical({ ...hypothetical, agents: e.target.value })}
              placeholder={String(measured.agents)}
            />
          </Field>
          <Field label="Probes per agent" hint={`Blank = measured (${measured.probes}).`}>
            <Input
              type="number"
              min={0}
              value={hypothetical.probesPerAgent}
              onChange={(e) => setHypothetical({ ...hypothetical, probesPerAgent: e.target.value })}
              placeholder={String(measured.probes)}
            />
          </Field>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table
            className="tabular"
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 'var(--text-sm)',
              minWidth: '32rem',
            }}
          >
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--color-fg-subtle)' }}>
                <th style={cell}>Setting</th>
                <th style={cell}>Now</th>
                <th style={cell}>Needs</th>
                <th style={cell}>Environment variable</th>
              </tr>
            </thead>
            <tbody>
              <Row
                name="Ingest requests / min"
                now={effective.ingestRateLimitPerMinute}
                needs={sizing.recommended.ingestRateLimitPerMinute}
                env="INGEST_RATE_LIMIT_MAX"
              />
              <Row
                name="Database connections"
                now={effective.dbPoolMax}
                needs={sizing.recommended.dbPoolMax}
                env="DB_POOL_MAX"
              />
              <Row
                name="Sign-ins / min"
                now={effective.authRateLimitPerMinute}
                needs={effective.authRateLimitPerMinute}
                env="AUTH_RATE_LIMIT_MAX"
              />
            </tbody>
          </table>
        </div>

        <dl
          className="tabular"
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: 'var(--space-2) var(--space-4)',
            margin: 'var(--space-4) 0 0',
            fontSize: 'var(--text-sm)',
          }}
        >
          <dt style={{ color: 'var(--color-fg-subtle)' }}>Points / min</dt>
          <dd style={{ margin: 0 }}>{sizing.pointsPerMinute}</dd>
          <dt style={{ color: 'var(--color-fg-subtle)' }}>Ingest requests / min</dt>
          <dd style={{ margin: 0 }}>
            {sizing.ingestRequestsPerMinute}{' '}
            <span style={{ color: 'var(--color-fg-subtle)' }}>
              (one per agent per run — an agent batches its probes)
            </span>
          </dd>
          <dt style={{ color: 'var(--color-fg-subtle)' }}>Page reads / min</dt>
          <dd style={{ margin: 0 }}>{sizing.readRequestsPerMinute}</dd>
          <dt style={{ color: 'var(--color-fg-subtle)' }}>Raw points retained</dt>
          <dd style={{ margin: 0 }}>
            {sizing.rawPointsRetained.toLocaleString()} ≈{' '}
            {sizing.rawStorageMb > 1024
              ? `${(sizing.rawStorageMb / 1024).toFixed(1)} GB`
              : `${Math.round(sizing.rawStorageMb)} MB`}{' '}
            before compression
          </dd>
        </dl>

        {sizing.notes.length > 0 && (
          <ul
            style={{
              margin: 'var(--space-4) 0 0',
              paddingLeft: '1.2em',
              fontSize: 'var(--text-sm)',
              color: 'var(--color-fg-muted)',
            }}
          >
            {sizing.notes.map((note) => (
              <li key={note} style={{ marginBottom: 'var(--space-2)' }}>
                {note}
              </li>
            ))}
          </ul>
        )}

        {canWrite && (
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-3)',
              alignItems: 'center',
              marginTop: 'var(--space-4)',
            }}
          >
            <Button
              variant="primary"
              busy={save.isPending}
              disabled={!dirty}
              onClick={() => save.mutate()}
            >
              Save assumptions
            </Button>
            {dirty && (
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)' }}>
                Unsaved
              </span>
            )}
          </div>
        )}

        <p
          className="measure"
          style={{
            margin: 'var(--space-4) 0 0',
            fontSize: 'var(--text-xs)',
            color: 'var(--color-fg-subtle)',
          }}
        >
          {/* Said plainly, because "why can I not save this" is a fair question
              about a screen full of numbers. */}
          The assumptions above are yours and are saved. The limits in the table are per-process and
          shared by every tenant on this instance — they are set in the environment and applied at
          restart, so this screen names the variable rather than pretending to change it.
        </p>
      </Card>
    </section>
  )
}

function Row({ name, now, needs, env }: { name: string; now: number; needs: number; env: string }) {
  const tight = now < needs
  return (
    <tr style={{ borderTop: '1px solid var(--color-border)' }}>
      <td style={cell}>{name}</td>
      <td style={{ ...cell, color: tight ? 'var(--status-degraded)' : undefined, fontWeight: 600 }}>
        {now}
      </td>
      <td style={cell}>{needs}</td>
      <td style={cell}>
        <code style={{ fontSize: 'var(--text-xs)' }}>{env}</code>
      </td>
    </tr>
  )
}

const cell: React.CSSProperties = {
  padding: 'var(--space-2) var(--space-3) var(--space-2) 0',
  verticalAlign: 'top',
  fontWeight: 'inherit',
}

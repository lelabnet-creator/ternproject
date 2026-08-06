import { useQuery } from '@tanstack/react-query'
import { adminApi } from '../../lib/adminApi'
import { Banner, Card } from '../../components/ui'

/**
 * Running the instance, as opposed to running a status page on it.
 *
 * Two questions, in this order, because that is the order an operator asks
 * them: *is the machinery keeping up*, and *where is the load coming from*.
 * Everything shown is measured; nothing is projected. The Capacity screen is
 * where a tenant models a fleet it does not have yet — this one only reports
 * what is happening.
 *
 * What it deliberately does not show: any tenant's incidents, subscribers or
 * measurements. Supervision is not administration, and an operator able to read
 * every customer's incident history has an access level nobody agreed to.
 */
export function PlatformScreen() {
  const overview = useQuery({ queryKey: ['system', 'overview'], queryFn: adminApi.systemOverview })
  const health = useQuery({
    queryKey: ['system', 'health'],
    queryFn: adminApi.systemHealth,
    refetchInterval: 30_000,
  })
  const load = useQuery({ queryKey: ['system', 'load'], queryFn: () => adminApi.systemLoad(24) })

  if (overview.isPending || health.isPending) {
    return <p style={{ paddingTop: 'var(--space-6)' }}>Measuring the instance…</p>
  }
  if (overview.isError || health.isError || !overview.data || !health.data) {
    return <Banner tone="down">Could not read the platform state.</Banner>
  }

  const { instance, tenants } = overview.data
  const failing = health.data.checks.filter((c) => c.state !== 'ok')

  return (
    <section style={{ paddingTop: 'var(--space-6)', display: 'grid', gap: 'var(--space-5)' }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 'var(--text-xl)' }}>Platform</h1>
        <p
          className="measure"
          style={{ margin: 'var(--space-1) 0 0', color: 'var(--color-fg-subtle)' }}
        >
          This instance: {instance.tenants} tenants, {instance.controls} controls,{' '}
          {instance.activeAgents} of {instance.agents} agents active. Up{' '}
          {formatDuration(health.data.uptimeS)}.
        </p>
      </div>

      {failing.length > 0 && (
        <Banner tone={failing.some((c) => c.state === 'fail') ? 'down' : 'degraded'}>
          {failing.length === 1
            ? `${failing[0]!.label}: ${failing[0]!.detail}`
            : `${failing.length} checks want attention — see below.`}
        </Banner>
      )}

      <div className="split">
        <div className="split-aside" style={{ display: 'grid', gap: 'var(--space-4)' }}>
          <Card>
            <h2 style={{ margin: '0 0 var(--space-3)', fontSize: 'var(--text-base)' }}>Health</h2>
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'grid',
                gap: 'var(--space-3)',
              }}
            >
              {health.data.checks.map((check) => (
                <li key={check.id} style={{ display: 'flex', gap: 'var(--space-3)' }}>
                  {/* Colour and a word, never colour alone. */}
                  <span
                    aria-hidden="true"
                    style={{
                      width: 10,
                      height: 10,
                      marginTop: 6,
                      borderRadius: '50%',
                      flexShrink: 0,
                      background: toneOf(check.state),
                    }}
                  />
                  <span style={{ minWidth: 0 }}>
                    <strong style={{ fontSize: 'var(--text-sm)' }}>{check.label}</strong>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 'var(--text-xs)',
                        color: 'var(--color-fg-muted)',
                      }}
                    >
                      {check.state === 'ok' ? '' : `${check.state.toUpperCase()} · `}
                      {check.detail}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <h2 style={{ margin: '0 0 var(--space-3)', fontSize: 'var(--text-base)' }}>
              Throughput
            </h2>
            <dl
              className="tabular"
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                gap: 'var(--space-2) var(--space-4)',
                margin: 0,
                fontSize: 'var(--text-sm)',
              }}
            >
              <dt style={{ color: 'var(--color-fg-subtle)' }}>Last hour</dt>
              <dd style={{ margin: 0 }}>{instance.pointsLastHour.toLocaleString()} points</dd>
              <dt style={{ color: 'var(--color-fg-subtle)' }}>Last day</dt>
              <dd style={{ margin: 0 }}>{instance.pointsLastDay.toLocaleString()} points</dd>
              <dt style={{ color: 'var(--color-fg-subtle)' }}>Measurements on disk</dt>
              <dd style={{ margin: 0 }}>
                {/* Null and zero are different facts; a dashboard that shows 0
                    for "could not measure" is lying. */}
                {instance.checksBytes === null
                  ? 'not reported by the database'
                  : formatBytes(instance.checksBytes)}
              </dd>
              <dt style={{ color: 'var(--color-fg-subtle)' }}>Ingest limit</dt>
              <dd style={{ margin: 0 }}>
                {health.data.limits.ingestRateLimitPerMinute}/min per key
              </dd>
              <dt style={{ color: 'var(--color-fg-subtle)' }}>Pool</dt>
              <dd style={{ margin: 0 }}>{health.data.limits.dbPoolMax} connections</dd>
            </dl>

            {load.data && load.data.buckets.length > 1 && (
              <div style={{ marginTop: 'var(--space-4)' }}>
                <LoadBars buckets={load.data.buckets} />
              </div>
            )}
          </Card>
        </div>

        <Card>
          <h2 style={{ margin: '0 0 var(--space-3)', fontSize: 'var(--text-base)' }}>
            Tenants, by load
          </h2>
          <div style={{ overflowX: 'auto' }}>
            <table
              className="tabular"
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 'var(--text-sm)',
                minWidth: '38rem',
              }}
            >
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--color-fg-subtle)' }}>
                  <th style={cell}>Tenant</th>
                  <th style={cell}>Controls</th>
                  <th style={cell}>Agents</th>
                  <th style={cell}>Points/min</th>
                  <th style={cell}>Retention</th>
                  <th style={cell}>Last point</th>
                </tr>
              </thead>
              <tbody>
                {[...tenants]
                  .sort((a, b) => b.pointsPerMinute - a.pointsPerMinute)
                  .map((tenant) => (
                    <tr key={tenant.id} style={{ borderTop: '1px solid var(--color-border)' }}>
                      <td style={cell}>
                        <a
                          href={`/app/${tenant.slug}`}
                          style={{ color: 'var(--color-accent-ink)', fontWeight: 600 }}
                        >
                          {tenant.name}
                        </a>
                        <span
                          style={{
                            display: 'block',
                            fontSize: 'var(--text-xs)',
                            color: 'var(--color-fg-subtle)',
                          }}
                        >
                          {tenant.slug} · {tenant.visibility}
                          {tenant.isSystem && ' · this instance'}
                        </span>
                      </td>
                      <td style={cell}>{tenant.controls}</td>
                      <td style={cell}>{tenant.agents}</td>
                      <td style={{ ...cell, fontWeight: tenant.pointsPerMinute > 0 ? 600 : 400 }}>
                        {tenant.pointsPerMinute}
                      </td>
                      <td style={cell}>
                        {tenant.retentionMode === 'live' ? 'live' : `${tenant.retentionDays} d`}
                      </td>
                      <td style={{ ...cell, color: 'var(--color-fg-subtle)' }}>
                        {tenant.lastPointAt
                          ? new Date(tenant.lastPointAt).toLocaleTimeString()
                          : 'never'}
                      </td>
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
            Points a minute is averaged over the last hour, so a tenant that has just started
            reading low here is not idle — it is new. Nothing on this page reads a tenant&rsquo;s
            incidents, subscribers or measurements.
          </p>
        </Card>
      </div>
    </section>
  )
}

/**
 * Ingest volume by hour. Bars rather than a line: these are counts in a bucket,
 * and a line between them would imply a rate that was never measured.
 */
function LoadBars({ buckets }: { buckets: { ts: string; points: number }[] }) {
  const peak = Math.max(1, ...buckets.map((b) => b.points))

  return (
    <figure style={{ margin: 0 }}>
      <figcaption
        style={{
          fontSize: 'var(--text-xs)',
          color: 'var(--color-fg-subtle)',
          marginBottom: 'var(--space-2)',
        }}
      >
        Points per hour, last {buckets.length} h — peak {peak.toLocaleString()}
      </figcaption>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 64 }}>
        {buckets.map((bucket) => (
          <div
            key={bucket.ts}
            title={`${new Date(bucket.ts).toLocaleString()} — ${bucket.points.toLocaleString()} points`}
            style={{
              flex: 1,
              minWidth: 2,
              // A floor of 2px so an hour with a handful of points is visible
              // as "some" rather than indistinguishable from "none".
              height: `${Math.max(2, (bucket.points / peak) * 100)}%`,
              background: 'var(--color-accent)',
              borderRadius: '2px 2px 0 0',
            }}
          />
        ))}
      </div>
    </figure>
  )
}

function toneOf(state: 'ok' | 'warn' | 'fail'): string {
  return state === 'ok'
    ? 'var(--status-operational)'
    : state === 'warn'
      ? 'var(--status-degraded)'
      : 'var(--status-down)'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function formatDuration(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h`
  return `${Math.round(seconds / 86_400)} d`
}

const cell: React.CSSProperties = {
  padding: 'var(--space-2) var(--space-3) var(--space-2) 0',
  verticalAlign: 'top',
  fontWeight: 'inherit',
}

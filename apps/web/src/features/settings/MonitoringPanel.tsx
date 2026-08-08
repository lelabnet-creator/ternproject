import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { adminApi, type ClassFigures } from '../../lib/adminApi'
import { Banner, Button, Card, EmptyState } from '../../components/ui'

/**
 * What the HTTP layer is doing right now.
 *
 * The rest of the admin reports what was stored; this reports what was served,
 * which is the only one of the two that still moves during a jam. It is here
 * rather than on Platform because the question it answers — "is the layer
 * keeping up, and which host is leaning on it" — is asked by whoever is holding
 * the pager, and on a single-tenant install that is the tenant admin.
 *
 * Two audiences, and the response decides which one is reading: the agents are
 * always the tenant's own, and the instance figures arrive only for an admin of
 * the system tenant. A tenant admin on a shared install never sees the shared
 * machinery, because it is not theirs to read.
 */
export function MonitoringPanel({ slug }: { slug: string }) {
  const [minutes, setMinutes] = useState(60)

  const monitoring = useQuery({
    queryKey: ['monitoring', slug, minutes],
    queryFn: () => adminApi.monitoring(slug, minutes),
    // The point of the tab is watching something move. Ten seconds is often
    // enough to see a jam build without making the tab part of the load.
    refetchInterval: 10_000,
  })

  if (monitoring.isPending) return <p style={{ color: 'var(--color-fg-subtle)' }}>Measuring…</p>
  if (monitoring.isError) return <Banner tone="down">Could not read the figures.</Banner>

  const { instance, agents, platform } = monitoring.data

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <Card>
        <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-3)',
              alignItems: 'baseline',
              flexWrap: 'wrap',
            }}
          >
            <h2 style={{ margin: 0, fontSize: 'var(--text-base)', flex: 1 }}>
              Live traffic
              <span
                className="tabular"
                style={{
                  marginLeft: 'var(--space-2)',
                  fontWeight: 400,
                  fontSize: 'var(--text-xs)',
                  color: 'var(--color-fg-subtle)',
                }}
              >
                last {instance.minutesCovered} min
              </span>
            </h2>
            <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
              {[15, 60, 120].map((option) => (
                <Button
                  key={option}
                  variant={option === minutes ? 'primary' : 'secondary'}
                  onClick={() => setMinutes(option)}
                >
                  {option} min
                </Button>
              ))}
            </div>
          </div>

          {/*
           * Said before any number is read, not in a footnote after.
           *
           * These counters live in the process that answered. Behind a load
           * balancer this is one instance's share of the traffic, and reading it
           * as the deployment's is exactly the mistake the shape invites.
           */}
          <Banner tone="maintenance">
            Measured in this API process — <code className="tabular">{instance.name}</code>, running
            since {new Date(instance.startedAt).toLocaleString()}. If you run more than one API
            container, each keeps its own count and neither knows about the other.
          </Banner>
        </div>
      </Card>

      {platform && <PlatformFigures platform={platform} />}

      <Card>
        <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 'var(--text-sm)' }}>Push rate by agent</h3>
            <p
              className="measure"
              style={{
                margin: 'var(--space-1) 0 0',
                fontSize: 'var(--text-sm)',
                color: 'var(--color-fg-subtle)',
              }}
            >
              Ingest requests this instance served, by the agent that sent them. During a jam this
              is the column that says which host to look at.
            </p>
          </div>

          {agents.length === 0 ? (
            <EmptyState
              title="No ingest in this window"
              hint="Either nothing is pushing, or the pushes reached another instance."
            />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <Th>Agent</Th>
                    <Th>Site</Th>
                    <Th>State</Th>
                    <Th align="right">Requests</Th>
                    <Th align="right">Per minute</Th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map((agent) => (
                    <tr key={agent.id}>
                      <Td>{agent.name}</Td>
                      <Td>{agent.site ?? '—'}</Td>
                      <Td>{agent.status}</Td>
                      <Td align="right">{agent.requests.toLocaleString()}</Td>
                      <Td align="right">{agent.perMinute}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {platform && platform.unattributedRequests > 0 && (
            <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}>
              {platform.unattributedRequests.toLocaleString()} further ingest request
              {platform.unattributedRequests === 1 ? '' : 's'} came from keys that match no agent of
              this page — another tenant, or an agent since deleted.
            </p>
          )}
        </div>
      </Card>
    </div>
  )
}

function PlatformFigures({
  platform,
}: {
  platform: NonNullable<Awaited<ReturnType<typeof adminApi.monitoring>>['platform']>
}) {
  const peak = Math.max(1, ...platform.perMinute.map((b) => b.requests))
  const poolShare = platform.pool.max === 0 ? 0 : platform.pool.active / platform.pool.max

  return (
    <>
      <Card>
        <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
          <h3 style={{ margin: 0, fontSize: 'var(--text-sm)' }}>By kind of traffic</h3>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <Th>Class</Th>
                  <Th align="right">Per minute</Th>
                  <Th align="right">Requests</Th>
                  <Th align="right">Rate limited</Th>
                  <Th align="right">Failed</Th>
                  <Th align="right">p50</Th>
                  <Th align="right">p95</Th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(platform.byClass).map(([kind, figures]) => (
                  <tr key={kind}>
                    <Td>{CLASS_LABELS[kind] ?? kind}</Td>
                    <Td align="right">{figures.perMinute}</Td>
                    <Td align="right">{figures.requests.toLocaleString()}</Td>
                    <Td align="right" tone={figures.rateLimited > 0 ? 'warn' : undefined}>
                      {figures.rateLimited.toLocaleString()}
                    </Td>
                    <Td align="right" tone={figures.failed > 0 ? 'bad' : undefined}>
                      {figures.failed.toLocaleString()}
                    </Td>
                    <Td align="right">{latency(figures.p50Ms)}</Td>
                    <Td align="right">{latency(figures.p95Ms)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p
            className="measure"
            style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}
          >
            Latencies come from a histogram, so each is the bound the sample fell under rather than
            an exact figure. <span className="tabular">&gt; 10 s</span> means the samples ran past
            the last bucket — the histogram stops there rather than inventing a number.
          </p>

          {ingestNearLimit(platform.byClass.ingest, platform.limits.ingestRateLimitPerMinute) && (
            <Banner tone="degraded">
              Ingest is running at{' '}
              <strong className="tabular">{platform.byClass.ingest?.perMinute}</strong> a minute
              against a limit of{' '}
              <strong className="tabular">{platform.limits.ingestRateLimitPerMinute}</strong>. The
              Capacity screen computes what your fleet actually needs.
            </Banner>
          )}
        </div>
      </Card>

      <Card>
        <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
          <h3 style={{ margin: 0, fontSize: 'var(--text-sm)' }}>The scarce resources</h3>

          <div className="facts">
            <Gauge
              label="Requests in flight"
              value={platform.inFlight}
              hint="Being served at this instant. A number that climbs and stays up is the shape of a jam."
            />
            <Gauge
              label="Database pool"
              value={`${platform.pool.active} / ${platform.pool.max}`}
              share={poolShare}
              hint={`${platform.pool.open} connection${platform.pool.open === 1 ? '' : 's'} open, ${platform.pool.active} running a query. DB_POOL_MAX bounds it.`}
            />
            <Gauge
              label="Ingest limit"
              value={`${platform.limits.ingestRateLimitPerMinute} / min`}
              hint="Per Authorization header — INGEST_RATE_LIMIT_MAX."
            />
            <Gauge
              label="Auth limit"
              value={`${platform.limits.authRateLimitPerMinute} / min`}
              hint="AUTH_RATE_LIMIT_MAX, against credential stuffing."
            />
          </div>

          {platform.pool.open === 0 && (
            <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}>
              The pool reads as empty, which usually means this database role cannot read{' '}
              <code>pg_stat_activity</code>. Everything else on this tab is unaffected.
            </p>
          )}
        </div>
      </Card>

      <Card>
        <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <h3 style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
            Requests a minute
            <span
              className="tabular"
              style={{
                marginLeft: 'var(--space-2)',
                fontWeight: 400,
                fontSize: 'var(--text-xs)',
                color: 'var(--color-fg-subtle)',
              }}
            >
              peak {peak.toLocaleString()}
            </span>
          </h3>

          {platform.perMinute.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--color-fg-subtle)' }}>Nothing served yet.</p>
          ) : (
            <div
              role="img"
              aria-label={`Requests per minute over the window, peaking at ${peak}`}
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                gap: 1,
                height: 72,
                overflowX: 'auto',
              }}
            >
              {platform.perMinute.map((bucket) => (
                <div
                  key={bucket.minute}
                  title={`${new Date(bucket.minute).toLocaleTimeString()} — ${bucket.requests} requests${bucket.rateLimited > 0 ? `, ${bucket.rateLimited} rate limited` : ''}`}
                  style={{
                    flex: '1 0 3px',
                    minWidth: 3,
                    height: `${Math.max(2, (bucket.requests / peak) * 100)}%`,
                    // Rate limiting is the one thing here worth a second colour:
                    // it is the difference between busy and refusing.
                    background:
                      bucket.rateLimited > 0 ? 'var(--status-degraded)' : 'var(--color-accent)',
                    borderRadius: 1,
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </Card>
    </>
  )
}

// ── Small pieces ────────────────────────────────────────────────────────────

const CLASS_LABELS: Record<string, string> = {
  ingest: 'Ingest',
  agent: 'Agent',
  admin: 'Admin',
  public: 'Public page',
}

/** Warn from four fifths of the limit: at the limit it is already refusing. */
function ingestNearLimit(figures: ClassFigures | undefined, limit: number): boolean {
  if (!figures || limit === 0) return false
  return figures.rateLimited > 0 || figures.perMinute >= limit * 0.8
}

function latency(ms: number | null): string {
  return ms === null ? '> 10 s' : ms >= 1000 ? `≤ ${ms / 1000} s` : `≤ ${ms} ms`
}

function Gauge({
  label,
  value,
  hint,
  share,
}: {
  label: string
  value: string | number
  hint: string
  /** 0…1. Draws a bar under the figure when the value has a ceiling. */
  share?: number
}) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-1)' }}>
      <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{label}</span>
      <span className="tabular" style={{ fontSize: 'var(--text-lg)' }}>
        {value}
      </span>
      {share !== undefined && (
        <div
          aria-hidden="true"
          style={{
            height: 4,
            borderRadius: 2,
            background: 'var(--color-border)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${Math.min(100, share * 100)}%`,
              height: '100%',
              background: share >= 0.8 ? 'var(--status-degraded)' : 'var(--color-accent)',
            }}
          />
        </div>
      )}
      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}>{hint}</span>
    </div>
  )
}

function Th({ children, align }: { children: React.ReactNode; align?: 'right' }) {
  return (
    <th
      scope="col"
      style={{
        textAlign: align ?? 'left',
        padding: 'var(--space-2)',
        borderBottom: '1px solid var(--color-border)',
        fontSize: 'var(--text-xs)',
        color: 'var(--color-fg-subtle)',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </th>
  )
}

function Td({
  children,
  align,
  tone,
}: {
  children: React.ReactNode
  align?: 'right'
  tone?: 'warn' | 'bad'
}) {
  return (
    <td
      className={align === 'right' ? 'tabular' : undefined}
      style={{
        textAlign: align ?? 'left',
        padding: 'var(--space-2)',
        borderBottom: '1px solid var(--color-border)',
        fontSize: 'var(--text-sm)',
        color:
          tone === 'bad'
            ? 'var(--status-down)'
            : tone === 'warn'
              ? 'var(--status-degraded)'
              : undefined,
        fontWeight: tone ? 600 : undefined,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </td>
  )
}

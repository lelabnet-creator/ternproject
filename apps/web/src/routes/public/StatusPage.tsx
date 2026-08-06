import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { TernWordmark } from '../../components/brand/TernMark'
import { type UptimeDay } from '../../charts/UptimeRibbon'
import { resolveOptions, widgetById } from '../../charts/registry'
import { SystemPulse } from '../../charts/SystemPulse'
import { api, type StatusComponent, type StatusSummary } from '../../lib/api'
import { STATUS_PRESENTATION } from '../../lib/status'

/**
 * The public status page.
 *
 * Mobile-first: one column of component cards, groups as headings, the pulse at
 * the top. Everything widens rather than rearranging, so the same reading order
 * holds on a phone and on a wall display.
 */
export function StatusPage({ slug }: { slug: string }) {
  const { t, i18n } = useTranslation()

  const summary = useQuery({
    queryKey: ['summary', slug],
    queryFn: () => api.summary(slug),
    // Polling, not a socket, for the first cut: a status page is read for a few
    // minutes at a time and 20s of latency is invisible, while a dropped socket
    // silently freezing the page is not.
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  })

  const period = summary.data?.tenant.retentionMode === 'live' ? '24h' : '90d'

  const uptime = useQuery({
    queryKey: ['uptime', slug, period],
    queryFn: () => api.uptime(slug, period),
    enabled: Boolean(summary.data),
    refetchInterval: 5 * 60_000,
  })

  const online = useOnline()

  if (summary.isPending) return <PageSkeleton />
  if (summary.isError || !summary.data) {
    return (
      <Centered>
        <p style={{ color: 'var(--color-fg-muted)' }}>{t('page.loadError')}</p>
        <button onClick={() => void summary.refetch()}>{t('page.retry')}</button>
      </Centered>
    )
  }

  const data = summary.data
  const locale = i18n.language
  const timeZone = data.tenant.defaultTimezone

  return (
    <div
      style={{
        maxWidth: '72rem',
        margin: '0 auto',
        padding: 'var(--space-6) var(--space-4) var(--space-12)',
      }}
    >
      <Header name={data.tenant.name} />

      {!online && (
        <Banner tone="unknown">
          {t('page.offline', { when: formatTime(data.generatedAt, locale, timeZone) })}
        </Banner>
      )}

      <section style={{ padding: 'var(--space-8) 0' }}>
        <SystemPulse
          overall={data.overall.status}
          affectedCount={data.overall.affectedCount}
          groups={topLevelGroups(data)}
        />
        <p
          className="tabular"
          style={{
            textAlign: 'center',
            fontSize: 'var(--text-xs)',
            color: 'var(--color-fg-subtle)',
            marginTop: 'var(--space-2)',
          }}
        >
          {t('page.lastUpdated', { when: formatTime(data.generatedAt, locale, timeZone) })}
        </p>
      </section>

      {groupTree(data).map(({ group, components }) => (
        <section key={group?.id ?? 'ungrouped'} style={{ marginBottom: 'var(--space-8) ' }}>
          {group && (
            <h2
              style={{
                fontSize: 'var(--text-sm)',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: 'var(--color-fg-subtle)',
                margin: '0 0 var(--space-3)',
              }}
            >
              {group.name}
            </h2>
          )}

          <div style={layoutStyle(data.tenant.layout)}>
            {components.map((component) => (
              <ComponentCard
                key={component.id}
                component={component}
                days={uptime.data?.days.filter((d) => d.controlId === component.id) ?? []}
                showRibbon={data.tenant.retentionMode === 'historical'}
                locale={locale}
                timeZone={timeZone}
                layout={data.tenant.layout}
              />
            ))}
          </div>
        </section>
      ))}

      <Footer />
    </div>
  )
}

/**
 * The density the tenant chose, expressed as a grid.
 *
 * `grid` uses auto-fit with a minimum, not a fixed column count: on a phone
 * that resolves to one column on its own, so there is no breakpoint to keep in
 * sync with anything. `compact` stays one column and tightens the gap — the
 * cards themselves shed their chart, which is where the height actually goes.
 */
function layoutStyle(layout: 'list' | 'grid' | 'compact'): React.CSSProperties {
  if (layout === 'grid') {
    return {
      display: 'grid',
      gap: 'var(--space-3)',
      gridTemplateColumns: 'repeat(auto-fit, minmax(20rem, 1fr))',
    }
  }
  return { display: 'grid', gap: layout === 'compact' ? 'var(--space-1)' : 'var(--space-3)' }
}

function ComponentCard({
  component,
  days,
  showRibbon,
  locale,
  timeZone,
  layout,
}: {
  component: StatusComponent
  days: UptimeDay[]
  showRibbon: boolean
  locale: string
  timeZone: string
  layout: 'list' | 'grid' | 'compact'
}) {
  const { t } = useTranslation()
  const presentation = STATUS_PRESENTATION[component.status]
  const Icon = presentation.icon

  const Widget = widgetById(component.widget)
  const widgetOptions = resolveOptions(Widget, component.widgetOptions)

  return (
    <article
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        padding: layout === 'compact' ? 'var(--space-2) var(--space-3)' : 'var(--space-4)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 'var(--text-base)', fontWeight: 600 }}>
            {component.name}
          </h3>
          {component.description && (
            <p
              style={{
                margin: 'var(--space-1) 0 0',
                fontSize: 'var(--text-sm)',
                color: 'var(--color-fg-subtle)',
              }}
            >
              {component.description}
            </p>
          )}
        </div>

        {/* Icon, colour and words together — never the dot alone. */}
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            color: presentation.color,
            fontSize: 'var(--text-sm)',
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          <Icon size={18} aria-hidden="true" />
          {t(presentation.labelKey)}
        </span>
      </div>

      {component.value !== null && component.valueLabel && (
        <p
          className="tabular"
          style={{
            margin: 'var(--space-2) 0 0',
            fontSize: 'var(--text-sm)',
            color: 'var(--color-fg-muted)',
          }}
        >
          {component.valueLabel}: {component.value}
          {component.valueUnit ? ` ${component.valueUnit}` : ''}
        </p>
      )}

      {showRibbon && layout !== 'compact' && (
        <div style={{ marginTop: 'var(--space-4)' }}>
          {days.length === 0 ? (
            <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)', margin: 0 }}>
              {t('page.noDataHint')}
            </p>
          ) : (
            // Rendered through the registry, so the page shows whatever the
            // editor's gallery promised rather than a hard-coded ribbon.
            <Widget.Component
              label={component.name}
              locale={locale}
              timeZone={timeZone}
              options={widgetOptions}
              series={daysToSeries(days)}
              unit={component.valueUnit}
              valueLabel={component.valueLabel}
              warnAt={Number(widgetOptions.warnAt ?? 0) || null}
              limitAt={Number(widgetOptions.limitAt ?? 0) || null}
            />
          )}
        </div>
      )}
    </article>
  )
}

// ── Layout pieces ───────────────────────────────────────────────────────────

function Header({ name }: { name: string }) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--space-4)',
        paddingBottom: 'var(--space-4)',
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      <h1 style={{ margin: 0, fontSize: 'var(--text-xl)', fontWeight: 600 }}>{name}</h1>
      <ThemeToggle />
    </header>
  )
}

function Footer() {
  return (
    <footer
      style={{
        marginTop: 'var(--space-12)',
        paddingTop: 'var(--space-4)',
        borderTop: '1px solid var(--color-border)',
        display: 'flex',
        justifyContent: 'center',
        opacity: 0.6,
        fontSize: 'var(--text-xs)',
      }}
    >
      {/* Tenant branding owns the header; TERN steps back to a quiet credit. */}
      <TernWordmark size={24} />
    </footer>
  )
}

function ThemeToggle() {
  const { t } = useTranslation()
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null)

  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme
  }, [theme])

  return (
    <button
      type="button"
      aria-label={t('theme.toggle')}
      onClick={() =>
        setTheme((current) => {
          if (current) return current === 'dark' ? 'light' : 'dark'
          // First press flips away from whatever the system is showing.
          return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark'
        })
      }
      style={{
        background: 'none',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        color: 'var(--color-fg-muted)',
        padding: '0 var(--space-3)',
        fontSize: 'var(--text-sm)',
      }}
    >
      {t('theme.toggle')}
    </button>
  )
}

function Banner({ tone, children }: { tone: 'unknown'; children: React.ReactNode }) {
  return (
    <div
      role="status"
      style={{
        marginTop: 'var(--space-4)',
        padding: 'var(--space-3) var(--space-4)',
        borderRadius: 'var(--radius-sm)',
        background: `var(--status-${tone}-soft)`,
        color: 'var(--color-fg)',
        fontSize: 'var(--text-sm)',
      }}
    >
      {children}
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: '60dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-4)',
      }}
    >
      {children}
    </div>
  )
}

/** Skeleton, not a spinner: the layout is known, so reserve it and avoid a jump. */
function PageSkeleton() {
  return (
    <div style={{ maxWidth: '72rem', margin: '0 auto', padding: 'var(--space-6) var(--space-4)' }}>
      <div
        style={{
          height: 240,
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-surface)',
          marginBottom: 'var(--space-6)',
        }}
      />
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            height: 96,
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-surface)',
            marginBottom: 'var(--space-3)',
          }}
        />
      ))}
    </div>
  )
}

/**
 * Turns the API's per-day rollups into the point shape widgets take.
 *
 * One adapter here rather than a second data path per widget: the registry's
 * components are written once and fed identically whether the source is a real
 * aggregate or an editor preview.
 */
function daysToSeries(days: UptimeDay[]) {
  return days.map((day) => ({
    ts: new Date(`${day.day}T12:00:00Z`),
    status: day.worstStatus,
    latencyMs: null,
    value: day.uptimePct,
    message: null,
  }))
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function topLevelGroups(data: StatusSummary) {
  return (
    data.groups
      .filter((g) => g.parentId === null)
      .map((group) => ({
        id: group.id,
        name: group.name,
        status: group.status,
        componentCount: countDescendants(data, group.id),
      }))
      // A group whose components are all internal has nothing to show a visitor.
      // Rendering its segment anyway would put an arc on the ring that corresponds
      // to nothing else on the page.
      .filter((group) => group.componentCount > 0)
  )
}

function countDescendants(data: StatusSummary, groupId: string): number {
  const childIds = data.groups.filter((g) => g.parentId === groupId).map((g) => g.id)
  const own = data.components.filter((c) => c.groupId === groupId).length
  return own + childIds.reduce((sum, id) => sum + countDescendants(data, id), 0)
}

/** Flattens the group tree into reading order, ungrouped components last. */
function groupTree(data: StatusSummary) {
  const sections: { group: StatusGroupLike | null; components: StatusComponent[] }[] = []

  const walk = (parentId: string | null) => {
    for (const group of data.groups.filter((g) => g.parentId === parentId)) {
      const components = data.components.filter((c) => c.groupId === group.id)
      if (components.length > 0) sections.push({ group, components })
      walk(group.id)
    }
  }
  walk(null)

  const ungrouped = data.components.filter((c) => c.groupId === null)
  if (ungrouped.length > 0) sections.push({ group: null, components: ungrouped })

  return sections
}

type StatusGroupLike = { id: string; name: string }

function formatTime(iso: string, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone }).format(new Date(iso))
}

/** Drives the offline banner. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}

export const __testables = { groupTree, countDescendants }

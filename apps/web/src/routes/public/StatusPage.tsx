import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { TernWordmark } from '../../components/brand/TernMark'
import { ThemePicker } from '../../components/ThemePicker'
import { accentById, applyAccent } from '../../lib/accents'
import { applyFont, fontById } from '../../lib/fonts'
import { type UptimeDay } from '../../charts/UptimeRibbon'
import { resolveOptions, widgetById } from '../../charts/registry'
import { SystemPulse } from '../../charts/SystemPulse'
import { api, type StatusComponent, type StatusSummary } from '../../lib/api'
import { STATUS_PRESENTATION } from '../../lib/status'
import { useCompact } from '../../lib/useCompact'
import { rememberPage } from '../../lib/recentPages'
import { SponsorButton } from '../../components/SponsorButton'
import { SiteFooter } from '../../components/SiteFooter'
import { previewOverrides } from './preview'
import { TenantStyle } from './TenantStyle'
import { communicationsPlacement, CustomLayout } from './CustomLayout'
import { defaultBlocks, hasComponentsBlock, parseBlocks } from '@tern/shared/blocks'
import { GroupPanes } from './GroupPanes'
import { DemoBanner } from '../../components/DemoBanner'

/**
 * The public status page.
 *
 * Mobile-first: one column of component cards, groups as headings, the pulse at
 * the top. Everything widens rather than rearranging, so the same reading order
 * holds on a phone and on a wall display.
 *
 * Two shells, and the difference between them is the whole of what `custom`
 * means. The three densities draw a page TERN arranged: header, pulse,
 * subscribe, notes, components, in that order, inside a card. `custom` draws
 * the tenant's arrangement instead — the same pieces, wherever they put them,
 * with no card around it. TERN keeps the utility strip and its own credit,
 * because neither reports anything about the service.
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

  /*
   * Up here with the other hooks, and that is not a matter of tidiness.
   *
   * This sat further down, below `if (summary.isPending) return …` — so it ran
   * on the renders that had data and not on the ones that did not, which is the
   * conditional-hook mistake exactly. React counts hooks by call order, so the
   * first render after the skeleton added a thirty-fifth where there had been
   * thirty-four, and the page threw "Rendered more hooks than during the
   * previous render" before it drew anything.
   */
  const compact = useCompact()
  /*
   * "Only what is not working", for the moment somebody opens this page during
   * an outage and wants the answer without reading the whole estate.
   *
   * Off by default and never sticky: a filtered page that looks like a healthy
   * one is the worst thing this could produce, and a preference remembered
   * across visits would do exactly that on the next visit — a green page,
   * because everything red had been hidden and nobody remembered asking.
   */
  const [onlyProblems, setOnlyProblems] = useState(false)

  const branding = summary.data?.tenant.branding as Record<string, unknown> | undefined

  const accentId = branding?.accent
  useEffect(() => {
    applyAccent(accentById(typeof accentId === 'string' ? accentId : undefined))
  }, [accentId])

  // The tenant's typeface, on the page its readers actually open. Applied here
  // as well as in the admin because the two are separate documents — a visitor
  // never loads the admin, and a page that ignored the choice would make the
  // setting look like it only skinned the editor.
  const fontId = branding?.font
  useEffect(() => {
    applyFont(fontById(typeof fontId === 'string' ? fontId : undefined))
  }, [fontId])

  // Same field the admin rail reads, and it was already served here — the page
  // simply never asked for it, so a tenant that had set a logo saw it in the
  // editor and the TERN wordmark on the page its readers open.
  const logoUrl = typeof branding?.logoUrl === 'string' ? branding.logoUrl : null

  // Remembered here rather than at the root, and only once a summary has come
  // back: the root cannot tell whether a name exists, and a list built from
  // what was typed there would be a list of guesses.
  const tenantName = summary.data?.tenant.name
  useEffect(() => {
    if (tenantName) rememberPage(slug, tenantName)
  }, [slug, tenantName])

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

  // The admin's layout editor frames this page to preview an arrangement that
  // has not been saved. Presentation only — the query cannot reveal a component
  // the reader could not already see, reorder anything server-side, or persist.
  const preview = previewOverrides(window.location.search)
  const layout = preview.layout ?? data.tenant.layout

  /*
   * Parsed rather than trusted: the column is JSON, and a page arranged by a
   * future version must degrade block by block rather than throw on a visitor.
   *
   * An empty arrangement is not a blank page — it is a page nobody has
   * rearranged yet, and drawing nothing for it would lose the header, the pulse
   * and the components at once. The editor seeds the same list the moment
   * somebody opens the Design tab, so this only catches pages that were
   * `custom` before any of this existed.
   */
  const stored = layout === 'custom' ? parseBlocks(data.tenant.customBlocks) : []
  const blocks = stored.length > 0 ? stored : defaultBlocks()

  // Read once and used in two places, which is the point: the notes above the
  // components and the `incidents` block are the same render, and a page that
  // computed the condition twice could show both or neither.
  const placement = communicationsPlacement(layout, blocks)

  const daysFor = (component: StatusComponent) =>
    uptime.data?.days.filter((day) => day.controlId === component.id) ?? []

  const communications = (
    <Communications
      incidents={data.incidents}
      maintenances={data.maintenances}
      components={data.components}
      locale={locale}
      timeZone={timeZone}
      // Inside a block the width is already whatever the block spans, so the
      // notes stack; the density only has something to say when they are laid
      // out against the whole page.
      layout={placement === 'arranged' ? 'list' : layout}
      framed={placement === 'above'}
    />
  )

  // Before anything the page reports, not under it: someone who reads a figure
  // and only then learns it was invented has already been misled.
  const notices = (
    <>
      {data.tenant.isDemo && <DemoBanner />}
      {!online && (
        <Banner tone="unknown">
          {t('page.offline', { when: formatTime(data.generatedAt, locale, timeZone) })}
        </Banner>
      )}
    </>
  )

  /*
   * The custom shell: the arrangement is the page.
   *
   * What is left outside it is the shortest list that could be: the notices,
   * because a demo page must say so before it says anything else; the theme and
   * admin controls, because a reader stranded without a theme toggle has no
   * other way to get one; the credit, because it names TERN rather than the
   * service. Everything a visitor came to read — the name, the ring, the
   * incidents, the components — is a block, placed wherever the tenant put it.
   */
  if (layout === 'custom') {
    return (
      <div
        data-tern="page"
        style={{
          maxWidth: '72rem',
          margin: '0 auto',
          padding: 'var(--space-6) var(--space-4) var(--space-12)',
        }}
      >
        <TenantStyle css={data.tenant.custom?.css ?? ''} />

        <div data-tern="utility" data-tern-guard="">
          {notices}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 'var(--space-3)',
              marginBottom: 'var(--space-4)',
            }}
          >
            <AdminLink slug={slug} />
            <ThemeToggle />
          </div>
        </div>

        <CustomLayout
          blocks={blocks}
          data={data}
          days={daysFor}
          locale={locale}
          timeZone={timeZone}
          renderComponent={(component, componentDays) => (
            <ComponentCard
              component={component}
              days={componentDays}
              locale={locale}
              timeZone={timeZone}
              layout="list"
            />
          )}
          renderCommunications={() => communications}
          renderHeader={() => <Header name={data.tenant.name} logoUrl={logoUrl} controls={false} />}
          renderPulse={(showUpdatedAt) => (
            <Pulse
              data={data}
              logoUrl={logoUrl}
              locale={locale}
              timeZone={timeZone}
              showUpdatedAt={showUpdatedAt}
            />
          )}
          renderSubscribe={() => (
            <Subscribe slug={slug} disclaimer={data.tenant.subscriberDisclaimer ?? null} />
          )}
          renderComponents={(density) => (
            <ComponentGrid
              data={data}
              order={preview.order}
              days={daysFor}
              locale={locale}
              timeZone={timeZone}
              density={density}
              compact={compact}
            />
          )}
        />

        {/* The two guarantees. An arrangement can place the incidents and the
            components anywhere; it cannot leave a status page with no news and
            no status on it. Absence of the block is what brings them back. */}
        {placement === 'above' && <div data-tern-guard="">{communications}</div>}
        {!hasComponentsBlock(blocks) && (
          <div data-tern-guard="">
            <ComponentGrid
              data={data}
              order={preview.order}
              days={daysFor}
              locale={locale}
              timeZone={timeZone}
              density="list"
              compact={compact}
            />
          </div>
        )}

        <div data-tern-guard="">
          <Footer />
        </div>
      </div>
    )
  }

  return (
    <div
      data-tern="page"
      style={{
        maxWidth: '72rem',
        margin: '0 auto',
        padding: 'var(--space-6) var(--space-4) var(--space-12)',
      }}
    >
      <div className="page-card">
        {/*
          Two arrangements, not one restyled.

          The compact header does not shrink the wide one — it moves three
          controls into a menu, which CSS cannot do without `order`, and `order`
          separates what the eye sees from what the keyboard traverses. See
          `useCompact` for the whole of that reasoning.
        */}
        {compact ? (
          <CompactHeader
            name={data.tenant.name}
            slug={slug}
            logoUrl={logoUrl}
            onlyProblems={onlyProblems}
            onOnlyProblems={setOnlyProblems}
          />
        ) : (
          <Header name={data.tenant.name} slug={slug} logoUrl={logoUrl} controls />
        )}

        {notices}

        {/*
          The answer first.

          `Pulse` is the sentence somebody opened this page to read, and it used
          to be the fourth thing on it — behind the mark, a sponsor button, a
          theme picker and a subscribe form. On a phone that is four screens of
          chrome before a single word about the service.
        */}
        {compact ? (
          /*
            The whole page, paginated — not only the component groups.
            
            The order is the order of the questions somebody asks: is it up,
            what is being done about it, and then which parts. Each of those is
            a pane, so none of them costs a scroll to reach, and the dots say
            how many there are before the first swipe.
          */
          <GroupPanes
            groups={[
              {
                id: 'overall',
                name: null,
                statuses: [data.overall.status],
                content: (
                  <Pulse
                    data={data}
                    logoUrl={logoUrl}
                    locale={locale}
                    timeZone={timeZone}
                    showUpdatedAt
                  />
                ),
              },
              // Only when there is something to say. An empty pane teaches the
              // reader that a dot may lead nowhere, and the next one they skip
              // is the one that mattered.
              ...(data.incidents.length > 0 || data.maintenances.length > 0
                ? [
                    {
                      id: 'communications',
                      name: 'Incidents & maintenance',
                      statuses: [data.overall.status],
                      content: communications,
                    },
                  ]
                : []),
              ...groupTree(data, preview.order)
                .map(({ group, components }) => ({
                  group,
                  components: onlyProblems
                    ? components.filter(
                        (component) =>
                          component.status !== 'operational' && component.status !== 'unknown',
                      )
                    : components,
                }))
                // A group with nothing wrong in it is not an empty pane, it is
                // no pane: a dot leading to a blank screen would be the filter
                // failing at the one thing it was asked to do.
                .filter(({ components }) => components.length > 0)
                .map(({ group, components }) => ({
                  id: group?.id ?? 'ungrouped',
                  name: group?.name ?? 'Components',
                  statuses: components.map((component) => component.status),
                  content: (
                    <div style={layoutStyle(layout)}>
                      {components.map((component) => (
                        <ComponentCard
                          key={component.id}
                          component={component}
                          days={daysFor(component)}
                          locale={locale}
                          timeZone={timeZone}
                          layout={layout}
                        />
                      ))}
                    </div>
                  ),
                })),
            ]}
          />
        ) : (
          <>
            <Pulse
              data={data}
              logoUrl={logoUrl}
              locale={locale}
              timeZone={timeZone}
              showUpdatedAt
            />

            {/*
              Above the components, because an incident is why most people
              opened the page. The coloured tiles below say *which* things are
              wrong; this says what is happening and what is being done, which
              is the part a reader would otherwise go looking for on social
              media.
            */}
            {placement === 'above' && communications}

            <ComponentGrid
              data={data}
              order={preview.order}
              days={daysFor}
              locale={locale}
              timeZone={timeZone}
              density={layout}
              compact={false}
            />
          </>
        )}

        {/*
          After the components, at every width.
          
          Subscribing is what a reader decides *having* read the status, not
          before reaching it — so a form above the answer is a toll gate on the
          one thing the page exists to say. Moved for desktop too rather than
          only for phones: the order was wrong there as well, it merely cost
          less.
        */}
        <Subscribe slug={slug} disclaimer={data.tenant.subscriberDisclaimer ?? null} />
      </div>

      {/* Outside the card: this says who made the page, not what it reports. */}
      <Footer />
    </div>
  )
}

/**
 * The ring, and when it was last true.
 *
 * Extracted so the arranged page draws the same one rather than a second
 * rendering of it. The timestamp is optional only in an arrangement — a page
 * built for a wall has a clock on the wall — and the ring never is.
 */
function Pulse({
  data,
  logoUrl,
  locale,
  timeZone,
  showUpdatedAt,
}: {
  data: StatusSummary
  logoUrl: string | null
  locale: string
  timeZone: string
  showUpdatedAt: boolean
}) {
  const { t } = useTranslation()

  return (
    <section style={{ padding: 'var(--space-8) 0' }}>
      <SystemPulse
        overall={data.overall.status}
        affectedCount={data.overall.affectedCount}
        groups={topLevelGroups(data)}
        // Only when the header is the tenant's. See the note beside the mark in
        // SystemPulse.
        attribution={logoUrl !== null}
      />
      {showUpdatedAt && (
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
      )}
    </section>
  )
}

/**
 * Every component, grouped, at one density.
 *
 * The same render in all four layouts: three of them pass their own density, and
 * the arranged one passes whatever its `components` block was set to. Extracting
 * it is what lets the block exist at all — without it, arranging a page with
 * forty controls would mean placing forty blocks.
 */
function ComponentGrid({
  data,
  order,
  days,
  locale,
  timeZone,
  density,
  compact,
}: {
  data: StatusSummary
  order?: string[]
  days: (component: StatusComponent) => UptimeDay[]
  locale: string
  timeZone: string
  density: 'list' | 'grid' | 'compact'
  /** Narrow enough to page through the groups instead of stacking them. */
  compact: boolean
}) {
  const tree = groupTree(data, order)

  /*
   * Sideways on a phone, stacked everywhere else.
   *
   * Five groups down a 390px screen is five screens of scrolling to learn what
   * is working. Paging through them is the native answer for content that is
   * peer rather than sequential — and `GroupPanes` carries the reasons it is
   * tabs-plus-swipe rather than swipe alone.
   */
  if (compact && tree.length > 1) {
    return (
      <div data-tern="components">
        <GroupPanes
          groups={tree.map(({ group, components }) => ({
            id: group?.id ?? 'ungrouped',
            name: group?.name ?? null,
            statuses: components.map((component) => component.status),
            content: (
              <div style={layoutStyle(density)}>
                {components.map((component) => (
                  <ComponentCard
                    key={component.id}
                    component={component}
                    days={days(component)}
                    locale={locale}
                    timeZone={timeZone}
                    layout={density}
                  />
                ))}
              </div>
            ),
          }))}
        />
      </div>
    )
  }

  return (
    <div data-tern="components">
      {tree.map(({ group, components }) => (
        <section key={group?.id ?? 'ungrouped'} className="page-group">
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

          <div style={layoutStyle(density)}>
            {components.map((component) => (
              <ComponentCard
                key={component.id}
                component={component}
                days={days(component)}
                locale={locale}
                timeZone={timeZone}
                layout={density}
              />
            ))}
          </div>
        </section>
      ))}
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
function layoutStyle(layout: 'list' | 'grid' | 'compact' | 'custom'): React.CSSProperties {
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
  locale,
  timeZone,
  layout,
}: {
  component: StatusComponent
  days: UptimeDay[]
  locale: string
  timeZone: string
  layout: 'list' | 'grid' | 'compact' | 'custom'
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

      {/*
        The widget the operator chose, in both retention modes.

        This used to be gated on `retentionMode === 'historical'`, under a prop
        called `showRibbon` — accurate when the only thing drawn here was the
        90-day uptime ribbon, and wrong from the moment the registry gained
        widgets marked `requires: 'live'`. A live-mode page offered those in the
        editor's gallery, saved the choice, and then drew a name and a status
        word: the one screen that exists to show the widget never showed it.
        Nothing was missing but the permission — the page already fetches a 24h
        period in live mode, so the series was there all along.

        `compact` still sheds the chart. That is the density doing its job: the
        chart is where the height goes, and shedding it is what makes the row
        compact.
      */}
      {layout !== 'compact' && (
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

function Header({
  name,
  slug,
  logoUrl,
  controls,
}: {
  name: string
  /** Only needed for the admin link, which an arranged header does not draw. */
  slug?: string
  logoUrl: string | null
  /**
   * Whether the header carries the theme toggle and the way back to the admin.
   *
   * False in an arranged page, where those two live in the utility strip
   * instead — outside the arrangement, because they are the reader's controls
   * rather than the tenant's content, and a header dragged to the bottom of the
   * page would otherwise take the theme toggle with it.
   */
  controls: boolean
}) {
  return (
    <header
      data-tern="header"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--space-4)',
        flexWrap: 'wrap',
        paddingBottom: 'var(--space-4)',
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      <HeaderMark name={name} logoUrl={logoUrl} />

      {/* Centred between the name and the controls, and it grows to take what
          is left so it stays centred as the name changes length. It wraps to
          its own line before it squeezes either neighbour — this is the one
          thing in the header nobody came here to read. */}
      <div style={{ flex: '1 1 12rem', display: 'flex', justifyContent: 'center' }}>
        <SponsorButton />
      </div>

      {controls && slug && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <AdminLink slug={slug} />
          <ThemeToggle />
        </div>
      )}
    </header>
  )
}

/**
 * A way back to the admin from the page it publishes.
 *
 * Shown to everyone rather than only to members: the link leads to a sign-in,
 * and hiding it would mean asking the server whether the reader is a member —
 * which is a request, a round trip and a fact about the reader, to save one
 * line of text.
 */
/**
 * Subscribing, in two channels and one form.
 *
 * A disclosure rather than a modal: a modal needs a focus trap, an escape route
 * and a scrim to be correct, and this is one field. Closed by default because
 * most visitors came to read a status, not to sign up for one.
 */
function Subscribe({ slug, disclaimer }: { slug: string; disclaimer: string | null }) {
  const [open, setOpen] = useState(false)
  const [channel, setChannel] = useState<'email' | 'webhook'>('email')
  const [address, setAddress] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'failed'>('idle')

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setState('sending')
    try {
      await api.subscribe(slug, channel, address)
      setState('done')
    } catch {
      // Refusal and network failure land together on purpose: the form says the
      // same thing either way, because saying more would say whether the
      // address was already known.
      setState('failed')
    }
  }

  return (
    <section data-tern="subscribe" style={{ padding: 'var(--space-4) 0 0' }}>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{
            minHeight: 44,
            padding: '0 var(--space-4)',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--color-border-strong)',
            background: 'var(--color-surface)',
            color: 'var(--color-fg)',
            fontFamily: 'inherit',
            fontSize: 'var(--text-sm)',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Subscribe to updates
        </button>
      ) : (
        <div
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--space-4)',
          }}
        >
          {state === 'done' ? (
            <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
              {/* Both channels confirm before anything is sent, and the wording
                  says where to look for that confirmation. */}
              {channel === 'email'
                ? 'Almost there — confirm from the message we just sent.'
                : 'Almost there — your endpoint has received a confirmation link. Follow it to start receiving updates.'}
            </p>
          ) : (
            <form onSubmit={submit} style={{ display: 'grid', gap: 'var(--space-3)' }}>
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                {(
                  [
                    ['email', 'Email'],
                    ['webhook', 'Webhook'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={channel === id}
                    onClick={() => setChannel(id)}
                    style={{
                      minHeight: 44,
                      padding: '0 var(--space-4)',
                      borderRadius: 'var(--radius-sm)',
                      border: `1px solid ${channel === id ? 'var(--color-accent)' : 'var(--color-border)'}`,
                      background: channel === id ? 'var(--color-accent-soft)' : 'transparent',
                      color: channel === id ? 'var(--color-accent-ink)' : 'var(--color-fg-muted)',
                      fontFamily: 'inherit',
                      fontSize: 'var(--text-sm)',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <label style={{ display: 'grid', gap: 'var(--space-1)' }}>
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>
                  {channel === 'email' ? 'Email address' : 'Endpoint URL'}
                </span>
                <input
                  type={channel === 'email' ? 'email' : 'url'}
                  required
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder={
                    channel === 'email' ? 'you@example.com' : 'https://hooks.example.com/status'
                  }
                  style={{
                    background: 'var(--color-bg)',
                    color: 'var(--color-fg)',
                    border: '1px solid var(--color-border-strong)',
                    borderRadius: 'var(--radius-sm)',
                    padding: 'var(--space-2) var(--space-3)',
                    fontSize: 'var(--text-base)',
                    fontFamily: 'inherit',
                    minHeight: 44,
                  }}
                />
              </label>

              {disclaimer && (
                <p
                  style={{
                    margin: 0,
                    fontSize: 'var(--text-xs)',
                    color: 'var(--color-fg-subtle)',
                  }}
                >
                  {disclaimer}
                </p>
              )}

              {state === 'failed' && (
                <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--status-down)' }}>
                  That did not go through. Check the address and try again.
                </p>
              )}

              <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  style={{
                    minHeight: 44,
                    padding: '0 var(--space-4)',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--color-border-strong)',
                    background: 'transparent',
                    color: 'var(--color-fg)',
                    fontFamily: 'inherit',
                    fontSize: 'var(--text-sm)',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={state === 'sending' || address.length < 3}
                  style={{
                    minHeight: 44,
                    padding: '0 var(--space-5)',
                    borderRadius: 'var(--radius-sm)',
                    border: 0,
                    background: 'var(--color-accent)',
                    color: 'var(--color-accent-fg)',
                    fontFamily: 'inherit',
                    fontSize: 'var(--text-sm)',
                    fontWeight: 600,
                    cursor: 'pointer',
                    opacity: state === 'sending' || address.length < 3 ? 0.5 : 1,
                  }}
                >
                  {state === 'sending' ? '…' : 'Subscribe'}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * The mark and the name, shared by both header arrangements.
 *
 * Extracted rather than duplicated: it carries five decisions about sizing and
 * about what a screen reader is told, and two copies of that is two places for
 * them to drift apart.
 */
function HeaderMark({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  /* The tenant's own mark when it has one, and the product's when it does
  not — the same rule the admin rail follows, for the same reason: this
  page belongs to whoever's name is on it.

  With a logo there is no rule and no wordmark. The slash existed to
  separate two brands, and the link home carried an `aria-label` of
  "TERN" that would be read out over somebody else's logo. TERN is still
  named, in the footer, which is where a status page carrying a
  customer's mark should say what it runs on.

  The image is `alt=""` on purpose: the name is in the heading beside it,
  and a screen reader announcing "CrisisLab CrisisLab" is worse than one
  that treats the picture as the decoration it is here.

  28 and not 24: 24 is the floor of the logo system, where TernMark
  drops the eye and thickens the stroke to compensate — the mark stops
  reading as a bird and turns into a comma beside the name. 28 is the
  first step where the eye comes back.

  And not the 34 the admin and landing headers use: the wordmark's text
  is 0.85 × its size, so 34 would set `tern` at 29px against a 24px
  (--text-xl) tenant name and put the platform above the customer. At 28
  it lands just under, and the name still reads first. */
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minWidth: 0 }}>
      {logoUrl ? (
        // Constrained rather than trusted: a logo of any shape has to sit on
        // one line of this header without setting its height.
        <img
          src={logoUrl}
          alt=""
          style={{ maxHeight: 32, maxWidth: '12rem', objectFit: 'contain' }}
        />
      ) : (
        <>
          <a
            href="/"
            aria-label="TERN"
            style={{ display: 'inline-flex', color: 'inherit', textDecoration: 'none' }}
          >
            <TernWordmark size={28} />
          </a>
          <span aria-hidden="true" style={{ color: 'var(--color-border)' }}>
            /
          </span>
        </>
      )}
      <h1
        style={{
          margin: 0,
          fontSize: 'var(--text-xl)',
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {name}
      </h1>
    </div>
  )
}

/**
 * The header, arranged for one thumb.
 *
 * ## What was wrong
 *
 * At 390px a reader crossed five full-width blocks — the mark, Sponsor TERN,
 * "Manage this page" with its theme picker, the demonstration notice, and
 * Subscribe — before the first pixel that said anything about the service. None
 * of those five is wrong; their rank was. The one thing everybody opened this
 * page for was the fourth screen down.
 *
 * ## What native apps do instead
 *
 * Three borrowings, and they are the same three on both platforms. A single bar
 * of about 56px carrying the title and *at most* one or two actions — iOS
 * navigation bar, Material top app bar. Everything else behind one overflow
 * control rather than crammed alongside it. And the content beginning
 * immediately under the bar, the way a weather app shows the temperature before
 * it shows its settings.
 *
 * So: the mark stays, the three controls move into the menu, and `Pulse` — the
 * sentence that answers the question — becomes the first thing under the bar.
 */
function CompactHeader({
  name,
  slug,
  logoUrl,
  onlyProblems,
  onOnlyProblems,
}: {
  name: string
  slug?: string
  logoUrl: string | null
  onlyProblems: boolean
  onOnlyProblems: (value: boolean) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const menu = useRef<HTMLDivElement>(null)

  /*
   * Escape and click-outside, neither of which `<details>` provides.
   *
   * A menu that only closes by pressing the same button again is one a reader
   * dismisses by tapping the page — and is then surprised to find still open.
   * Escape is the same contract every dialog on this page already honours.
   */
  useEffect(() => {
    if (!open) return

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        // Focus returns to the control that opened it, or the reader is left
        // at the top of the document with no idea where they are.
        menu.current?.querySelector<HTMLButtonElement>('[data-overflow-trigger]')?.focus()
      }
    }
    const onDown = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false)
    }

    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open])

  return (
    <header
      data-tern="header"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--space-3)',
        minHeight: 56,
        paddingBottom: 'var(--space-3)',
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      <HeaderMark name={name} logoUrl={logoUrl} />

      <div ref={menu} style={{ position: 'relative', flex: '0 0 auto' }}>
        <button
          type="button"
          data-overflow-trigger=""
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={t('page.moreOptions')}
          onClick={() => setOpen((v) => !v)}
          style={{
            // 44px square: the minimum tap target, met by the control itself
            // rather than by a hit area nobody can see.
            width: 44,
            height: 44,
            display: 'grid',
            placeItems: 'center',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--color-border)',
            background: open ? 'var(--color-surface)' : 'transparent',
            color: 'var(--color-fg-muted)',
            cursor: 'pointer',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
            <circle cx="5" cy="12" r="1.75" />
            <circle cx="12" cy="12" r="1.75" />
            <circle cx="19" cy="12" r="1.75" />
          </svg>
        </button>

        {open && (
          <div
            role="menu"
            style={{
              position: 'absolute',
              top: 'calc(100% + var(--space-1))',
              right: 0,
              zIndex: 20,
              minWidth: '13rem',
              display: 'grid',
              gap: 'var(--space-3)',
              padding: 'var(--space-3)',
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border-strong)',
              borderRadius: 'var(--radius-md)',
              boxShadow: 'var(--shadow-card)',
            }}
          >
            {/*
              First in the menu, because it is the only entry here that changes
              what the page says rather than how it looks. The others are the
              reader's preferences; this one is the reader's question.
            */}
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                minHeight: 44,
                fontSize: 'var(--text-sm)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={onlyProblems}
                onChange={(event) => onOnlyProblems(event.target.checked)}
              />
              Only what is not working
            </label>

            <ThemePicker compact />
            {slug && <AdminLink slug={slug} />}
            <SponsorButton />
          </div>
        )}
      </div>
    </header>
  )
}

function AdminLink({ slug }: { slug: string }) {
  const { t } = useTranslation()

  return (
    <a
      href={`/app/${slug}`}
      style={{
        fontSize: 'var(--text-sm)',
        color: 'var(--color-fg-subtle)',
        textDecoration: 'none',
      }}
    >
      {t('page.manage')}
    </a>
  )
}

/**
 * The mark moved to the header, so what belongs here is the credit — who built
 * this and where the code lives, in the same words as every other screen.
 */
function Footer() {
  return (
    <div
      style={{
        marginTop: 'var(--space-12)',
        paddingTop: 'var(--space-4)',
        borderTop: '1px solid var(--color-border)',
      }}
    >
      <SiteFooter />
    </div>
  )
}

function ThemeToggle() {
  // The same control as the admin's, so a reader's choice is one choice and it
  // survives a reload — the previous toggle forgot it on every visit.
  return <ThemePicker compact />
}

/**
 * What is happening, in words.
 *
 * The API has served open incidents and maintenance windows in `summary.json`
 * since the beginning and nothing rendered them: a visitor saw a component turn
 * red and was told neither why nor whether anyone had noticed. The title, the
 * severity and the running commentary reached subscribers only — which is to
 * say, the people who had already decided to trust the page.
 *
 * Nothing is drawn when there is nothing to say. A permanent "no incidents"
 * panel is a line of furniture that trains people to skip the place where the
 * news appears.
 *
 * It follows the density like everything else on the page. It used to ignore
 * it: rendered above the components and outside the layout, it kept its full
 * size on a `compact` page where every card beside it had tightened, and stayed
 * a full-width stack on a `grid` page where nothing else was. The reader was
 * told the page had one density and shown two.
 */
function Communications({
  incidents,
  maintenances,
  components,
  locale,
  timeZone,
  layout,
  framed,
}: {
  incidents: StatusSummary['incidents']
  maintenances: StatusSummary['maintenances']
  components: StatusSummary['components']
  locale: string
  timeZone: string
  layout: 'list' | 'grid' | 'compact' | 'custom'
  /**
   * Whether to draw the surrounding card.
   *
   * Off inside an arranged block, which already sits in one — nesting the two
   * would put a panel inside a panel and read as a mistake.
   */
  framed: boolean
}) {
  const { t } = useTranslation()
  if (incidents.length === 0 && maintenances.length === 0) return null

  const nameOf = (ids: string[]) =>
    ids
      .map((id) => components.find((c) => c.id === id)?.name)
      .filter((name): name is string => Boolean(name))
      .join(', ')

  const dense = layout === 'compact'
  // The same grid the components get, so `grid` flows the notes into the same
  // columns and `compact` closes the same gaps.
  const noteStyle = dense ? DENSE_NOTE : undefined
  const titleSize = dense ? 'var(--text-sm)' : 'var(--text-base)'

  return (
    <section
      data-tern="incidents"
      className={framed ? 'page-group' : undefined}
      style={layoutStyle(layout)}
    >
      {incidents.length > 0 && <SectionTitle>{t('incident.active')}</SectionTitle>}

      {incidents.map((incident) => {
        const affected = nameOf(incident.impacts.map((i) => i.controlId))
        return (
          <article
            key={incident.id}
            className="page-note"
            data-tone={incident.severity}
            style={noteStyle}
          >
            <h3 style={{ margin: 0, fontSize: titleSize }}>{incident.title}</h3>
            <p className="page-note-meta tabular">
              {t('incident.started', { when: formatTime(incident.startedAt, locale, timeZone) })}
              {' · '}
              {incident.status}
              {affected && <> · {t('incident.affecting', { components: affected })}</>}
            </p>
            {/* The newest update, not the whole timeline. Someone checking
                whether it is over needs one paragraph, not a history. */}
            {incident.latestUpdate && (
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{incident.latestUpdate.body}</p>
            )}
          </article>
        )
      })}

      {maintenances.length > 0 && <SectionTitle>{t('maintenance.upcoming')}</SectionTitle>}

      {maintenances.map((window) => {
        const affected = nameOf(window.controlIds)
        return (
          <article key={window.id} className="page-note" data-tone="maintenance" style={noteStyle}>
            <h3 style={{ margin: 0, fontSize: titleSize }}>{window.title}</h3>
            <p className="page-note-meta tabular">
              {window.status === 'in_progress' && <>{t('maintenance.running')} · </>}
              {t('maintenance.window', {
                start: formatTime(window.scheduledStart, locale, timeZone),
                end: formatTime(window.scheduledEnd, locale, timeZone),
              })}
              {affected && <> · {t('incident.affecting', { components: affected })}</>}
            </p>
            {window.body && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{window.body}</p>}
          </article>
        )
      })}
    </section>
  )
}

/**
 * What `compact` does to a note: tightens the box, never the sentence.
 *
 * The mirror of what `ComponentCard` does one screen down — the same padding it
 * drops to, and the same reason. A compact card also sheds its chart, and this
 * one deliberately does not shed the latest update: the chart repeats what the
 * status word beside it already says, while the update is the one paragraph the
 * reader came for. Saving height by withholding the news would be the density
 * making an editorial decision.
 */
const DENSE_NOTE: React.CSSProperties = {
  padding: 'var(--space-2) var(--space-3)',
  gap: 'var(--space-1)',
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        // A heading is not a column. In `grid` the notes flow into auto-fit
        // tracks and this must stay a full-width rule over them; in every other
        // density there is one track and the span costs nothing.
        gridColumn: '1 / -1',
        fontSize: 'var(--text-sm)',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: 'var(--color-fg-subtle)',
        margin: 'var(--space-2) 0 0',
      }}
    >
      {children}
    </h2>
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
      {/* The same card the loaded page draws, so the arrival is a fill rather
          than a rearrangement. The blocks inside are raised against it — on the
          page's own surface they would be invisible. */}
      <div className="page-card">
        <div
          style={{
            height: 240,
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-surface-raised)',
            marginBottom: 'var(--space-6)',
          }}
        />
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              height: 96,
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-surface-raised)',
              marginBottom: 'var(--space-3)',
            }}
          />
        ))}
      </div>
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
function groupTree(data: StatusSummary, previewOrder?: string[]) {
  const sections: { group: StatusGroupLike | null; components: StatusComponent[] }[] = []

  // A draft order from the layout editor, applied to presentation only. Anything
  // the list does not mention keeps its stored position and sorts after, so a
  // partial list degrades to "these first" rather than to chaos.
  const rank = previewOrder ? new Map(previewOrder.map((id, index) => [id, index])) : null
  const arrange = (components: StatusComponent[]) =>
    rank
      ? [...components].sort(
          (a, b) =>
            (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
            (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
        )
      : components

  const walk = (parentId: string | null) => {
    for (const group of data.groups.filter((g) => g.parentId === parentId)) {
      const components = data.components.filter((c) => c.groupId === group.id)
      if (components.length > 0) sections.push({ group, components: arrange(components) })
      walk(group.id)
    }
  }
  walk(null)

  const ungrouped = data.components.filter((c) => c.groupId === null)
  if (ungrouped.length > 0) sections.push({ group: null, components: arrange(ungrouped) })

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

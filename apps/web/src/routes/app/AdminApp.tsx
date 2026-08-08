import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminApi, ApiError, type Control } from '../../lib/adminApi'
import { Banner, Button, Card, CodeBlock, EmptyState, Field, Input } from '../../components/ui'
import { TernWordmark } from '../../components/brand/TernMark'
import { ThemePicker } from '../../components/ThemePicker'
import { SponsorButton } from '../../components/SponsorButton'
import { SiteFooter } from '../../components/SiteFooter'
import { SetupWizard } from '../../features/onboarding/SetupWizard'
import { FirstRunSetup } from '../../features/onboarding/FirstRunSetup'
import { GuidedTour } from '../../features/onboarding/GuidedTour'
import { DemoBanner } from '../../components/DemoBanner'
import { accentById, applyAccent } from '../../lib/accents'
import { PasskeyCancelled, passkeysSupported, signInWithPasskey } from '../../lib/passkeys'
import { ScriptTabs } from '../../features/control-editor/ScriptTabs'
import { PreviewStep } from '../../features/control-editor/PreviewStep'
import * as Icons from 'lucide-react'
import { CHIPS } from '../../lib/accents'
import { DEFAULT_WIDGET, resolveOptions, widgetById } from '../../charts/registry'
import type { CheckStatusValue } from '@tern/shared/status'
import { api } from '../../lib/api'
import { LayoutScreen } from './LayoutScreen'
import { IncidentsScreen } from './IncidentsScreen'
import { MaintenancesScreen } from './MaintenancesScreen'
import { FleetScreen } from './FleetScreen'
import { OptionsScreen } from './OptionsScreen'
import { LogsScreen } from './LogsScreen'
import { PlatformScreen } from './PlatformScreen'

/**
 * The admin surface.
 *
 * A rail on a wide screen, a row of tabs on a narrow one — one navigation, two
 * shapes. Below 1024px the rail would eat a third of the width; above it, a
 * horizontal tab strip wastes the height it sits in and pushes the work down
 * the page.
 *
 * The content is no longer capped at 64rem. That cap made every screen a column
 * down the middle of a 1440px display with two empty margins, and the screens
 * that suffer most from it — the fleet, the layout editor, the capacity table —
 * are exactly the ones with something to put there. Long prose still gets a
 * measure, per screen, where a full-width paragraph would be unreadable.
 *
 * An outage is sometimes handled from a phone on a train, so nothing here
 * depends on the wide case working.
 */
export function AdminApp({ slug }: { slug: string }) {
  const me = useQuery({ queryKey: ['me'], queryFn: adminApi.me, retry: false })
  const [section, setSection] = useSection(slug)

  // The tenant's accent, applied to its admin as well as its page: an operator
  // switching between two tenants should see which one they are in.
  const summary = useQuery({
    queryKey: ['summary', slug],
    queryFn: () => api.summary(slug),
    retry: false,
  })
  const signedIn = !me.isError && !me.isPending

  /*
   * A stranger, on a demo page.
   *
   * The whole point of a demo is that the product can be looked at rather than
   * described, so this shows the admin without a session. It is only safe
   * beside `readOnly`, which the API enforces for everyone at the single point
   * every route passes through — the screens below simply have nothing to
   * offer, because every write would be refused anyway.
   */
  /*
   * The demo shell would otherwise swallow the sign-in form entirely, leaving
   * the page's actual administrator with no way in. `?signin=1` is the door,
   * linked from the rail — a query parameter rather than a route because the
   * demo shell and the form are the same address wearing two faces.
   */
  const wantsSignIn = new URLSearchParams(window.location.search).get('signin') === '1'
  const demo = me.isError && !wantsSignIn && summary.data?.tenant.isDemo === true

  /*
   * Asked only when there is no session, and only then because the answer
   * decides which of two screens a stranger sees: a sign-in form, or the
   * first-run setup. On an instance that has been running for a year this
   * query never fires.
   */
  const setupState = useQuery({
    queryKey: ['setup-state'],
    queryFn: adminApi.setupState,
    enabled: me.isError,
    retry: false,
  })

  // Fetched here as well as in the Controls screen, on the same query key: the
  // first-run wizard needs to know whether this tenant has anything in it yet,
  // and React Query serves both from one request.
  const controls = useQuery({
    queryKey: ['controls', slug],
    queryFn: () => adminApi.controls(slug),
    enabled: signedIn || demo,
    retry: false,
  })
  const branding = signedIn
    ? (summary.data?.tenant.branding as Record<string, unknown> | undefined)
    : undefined
  const logoUrl = typeof branding?.logoUrl === 'string' ? branding.logoUrl : null
  const accentId = branding?.accent
  useEffect(() => {
    applyAccent(accentById(typeof accentId === 'string' ? accentId : undefined))
  }, [accentId])

  if (me.isPending) return <Centered>Loading…</Centered>

  if (me.isError && !demo) {
    /*
     * The summary decides whether this is a demo, so a sign-in form drawn
     * before it lands would be replaced a moment later — and on a demo page it
     * is the wrong screen entirely. Same reasoning as the setup check below,
     * and the same fix: wait for the answer instead of guessing at it.
     */
    if (summary.isPending) return <Centered>Loading…</Centered>

    // Waiting on the answer rather than guessing: drawing the sign-in form and
    // swapping it for the setup screen a moment later shows a password field to
    // someone who has no password, which is the confusion this replaces.
    if (setupState.isPending) return <Centered>Loading…</Centered>

    if (setupState.data?.needsSetup) {
      return (
        <FirstRunSetup
          tenant={setupState.data.tenant}
          onReady={(createdSlug) => {
            /*
             * The address in the bar named a page; setup may have created a
             * different one. That happens whenever this screen was reached at
             * `/app/<old-slug>` — a bookmark, or a tab left open across a
             * reset — and leaving it would point every later request at a page
             * that does not exist, which surfaces as a bare "Not found" inside
             * the next wizard.
             */
            if (createdSlug && createdSlug !== slug) {
              window.location.replace(`/app/${encodeURIComponent(createdSlug)}`)
              return
            }
            void setupState.refetch()
            void me.refetch()
          }}
        />
      )
    }

    return <LoginScreen onSignedIn={() => void me.refetch()} />
  }

  /*
   * A demo visitor has no membership, because they have no account. They are
   * given the shape of one so the shell has a name and a role to draw, and the
   * role it draws is the truth: they can read.
   */
  const membership = demo
    ? {
        tenantId: '',
        slug,
        name: summary.data?.tenant.name ?? slug,
        role: 'viewer',
        isSystem: false,
      }
    : me.data?.memberships.find((m) => m.slug === slug)

  if (!membership) {
    return (
      <Centered>
        <Banner tone="down">You are signed in, but not a member of “{slug}”.</Banner>
      </Centered>
    )
  }

  // Never for a demo visitor, and never on a read-only page — the API refuses
  // either way, and offering a button that answers 403 is worse than not
  // offering it.
  const canWrite = membership.role === 'admin' && !demo && summary.data?.tenant.readOnly !== true

  /*
   * A tenant nobody has configured gets the wizard instead of the shell.
   *
   * Two conditions, and both are needed. The marker alone would put the wizard
   * in front of every tenant that predates it; an empty control list alone
   * would bring it back every time somebody deleted their last control, which
   * is precisely when they least want to be walked through the basics.
   *
   * Only for an admin: a viewer cannot save any of the answers, so offering the
   * questions would be a dead end.
   */
  const needsSetup =
    canWrite &&
    !branding?.setupCompletedAt &&
    controls.data !== undefined &&
    controls.data.length === 0

  if (needsSetup) {
    return (
      <SetupWizard
        slug={slug}
        tenantName={membership.name}
        onFinished={() => void summary.refetch()}
      />
    )
  }

  return (
    <div className="admin-shell">
      <aside className="admin-rail">
        <div className="admin-brand">
          {logoUrl ? (
            // The tenant's mark where the product's used to be: an operator
            // switching between customers should see whose page they are in.
            // Constrained rather than trusted: a logo of any shape has to fit
            // this rail without pushing the navigation down.
            <img
              src={logoUrl}
              alt={membership.name}
              style={{ maxWidth: '100%', maxHeight: 40, objectFit: 'contain' }}
            />
          ) : (
            <TernWordmark size={34} />
          )}
          <p className="admin-tenant">
            {membership.name}
            <span>{membership.role}</span>
          </p>
        </div>

        <AdminNav
          slug={slug}
          section={section}
          onNavigate={setSection}
          isSystem={membership.isSystem === true}
        />

        {/* The foot of the rail on a wide screen, the right-hand end of the app
            bar on a narrow one — same three controls, same order, laid out by
            `.admin-rail-foot` rather than from here. */}
        <div className="admin-rail-foot">
          <ThemePicker />
          {/* At the foot of the rail rather than on a screen: it is the one
              spot an operator passes every session and never has to read. */}
          <SponsorButton />
          {/* A demo visitor has no session to end, and the demo shell would
              otherwise hide the sign-in form entirely — leaving the page's
              actual administrator with no way in. */}
          <Button
            ariaLabel={demo ? 'Sign in' : 'Sign out'}
            onClick={() => {
              if (demo) {
                window.location.assign(`/app/${slug}?signin=1`)
                return
              }
              void adminApi.logout().then(() => window.location.reload())
            }}
          >
            {/* Wrapped rather than given to Button directly: Button is not a
                flex container, and an icon beside a text node would sit on the
                baseline instead of centred against it. */}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              {demo ? (
                <Icons.LogIn size={15} aria-hidden="true" />
              ) : (
                <Icons.LogOut size={15} aria-hidden="true" />
              )}
              <span className="chrome-label">{demo ? 'Sign in' : 'Sign out'}</span>
            </span>
          </Button>

          {/* Under sign-out, and deliberately the quietest thing in the rail:
              nobody navigates by it, but it is the first thing anyone is asked
              for when reporting that something is wrong. Dropped from the app
              bar, where every pixel is spent on the tenant's name and the three
              controls above — see `.admin-build`. */}
          <p className="admin-build tabular">
            v{__TERN_VERSION__}
            <span aria-hidden="true"> · </span>
            <span title="Build">{__TERN_BUILD__}</span>
          </p>
        </div>
      </aside>

      {/*
        Only once the shell is on screen, and never over the setup wizard: a
        tour of a rail that has not rendered has nothing to point at, and one
        that interrupts first-run setup is a second thing to dismiss before the
        first can be finished.
      */}
      {!demo && me.data?.user.tourSeenAt === null && (
        <GuidedTour
          steps={tourSteps(membership.isSystem === true)}
          onFinish={() => {
            // Optimistic, and safe to be: the worst case if the write fails is
            // the tour reappearing on the next sign-in, which is the state the
            // reader was already in.
            void adminApi.setTourSeen(true).finally(() => void me.refetch())
          }}
        />
      )}

      <main className="admin-main">
        {/* Said on every screen, not only the first: someone who arrives deep
            in the admin from a link has had no chance to be told. */}
        {demo && <DemoBanner variant="admin" />}

        {/*
          Why nothing can be changed, said once for every screen.
          
          A disabled button gives no reason and looks exactly like an enabled
          one that did not work — the report that led here was "I cannot click
          another density", from a page where all four were disabled and the
          saved one merely looked chosen. The demo banner above already explains
          its own case, so this covers the other two.
        */}
        {!demo && !canWrite && (
          <Banner tone="maintenance">
            {summary.data?.tenant.readOnly
              ? 'This page is read-only: every change is refused, whoever is signed in. Nothing below will save.'
              : `You are signed in as a ${membership.role}, which can read this page but not change it.`}
          </Banner>
        )}
        {section === 'incidents' ? (
          <IncidentsScreen slug={slug} canWrite={canWrite} />
        ) : section === 'maintenance' ? (
          <MaintenancesScreen slug={slug} canWrite={canWrite} />
        ) : section === 'layout' ? (
          <LayoutScreen slug={slug} canWrite={canWrite} />
        ) : section === 'agents' ? (
          <FleetScreen slug={slug} canWrite={canWrite} />
        ) : section === 'logs' ? (
          <LogsScreen slug={slug} canWrite={canWrite} />
        ) : section === 'options' ? (
          <OptionsScreen slug={slug} canWrite={canWrite} signedIn={!demo} />
        ) : section === 'platform' ? (
          <PlatformScreen />
        ) : (
          <ControlsScreen slug={slug} canWrite={canWrite} />
        )}
      </main>
    </div>
  )
}

// ── Navigation ──────────────────────────────────────────────────────────────

const SECTIONS = [
  // Icon *and* label, never the icon alone: an icon-only rail is a memory test,
  // and the words are what a screen reader reads out.
  { id: 'controls', label: 'Controls', icon: 'Activity' },
  // Second, not buried: declaring an incident is the thing this product exists
  // to do, and it is reached under pressure.
  { id: 'incidents', label: 'Incidents', icon: 'Siren' },
  { id: 'maintenance', label: 'Maintenance', icon: 'CalendarClock' },
  { id: 'layout', label: 'Page layout', icon: 'LayoutGrid' },
  { id: 'agents', label: 'Agents', icon: 'Radar' },
  { id: 'logs', label: 'Logs', icon: 'ScrollText' },
  { id: 'options', label: 'Options', icon: 'Settings' },
  { id: 'platform', label: 'Platform', icon: 'Server' },
] as const

type Section = (typeof SECTIONS)[number]['id']

/**
 * What the tour says about each rail entry.
 *
 * Keyed by section id and looked up rather than listed separately, so the steps
 * are generated from the rail itself. An entry with no copy still gets a step —
 * a tour that silently skips a screen is worse than one with a plain sentence
 * about it — which is also why ids that only exist once other work lands are
 * already written here rather than added later and forgotten.
 */
const TOUR_COPY: Record<string, string> = {
  controls:
    'One control is one thing you watch. Create one and TERN hands you a script that pushes to it, or a probe it runs for you.',
  incidents:
    'When something breaks, you declare it here. That marks the affected components, tells subscribers, and starts the timeline you will publish a postmortem against.',
  maintenance:
    'Work you know about in advance. Subscribers are reminded before the window opens, and alerting stays quiet for the components you attach while it runs.',
  layout: 'What the public page shows, in what order, at one of three densities.',
  agents:
    'The hosts running your probes. Pairing hands an agent its jobs, so the list of what is monitored never lives only on the monitored machine.',
  logs: 'Who changed what, where to forward it, and what the HTTP layer is doing right now.',
  options: 'Naming, branding, retention, mail and subscribers. Also where this tour lives.',
  platform: 'How much load each page puts on the instance, and whether the instance is keeping up.',
}

/** One step per rail entry that this reader can actually see. */
export function tourSteps(isSystem: boolean): { target: string; title: string; body: string }[] {
  return SECTIONS.filter((entry) => entry.id !== 'platform' || isSystem).map((entry) => ({
    target: `[data-tour="${entry.id}"]`,
    title: entry.label,
    body: TOUR_COPY[entry.id] ?? `Open ${entry.label}.`,
  }))
}

/**
 * Two sections, and the URL says which one.
 *
 * A router library would be more machinery than this needs, but the address bar
 * still has to be right: /app/acme/layout must be linkable, reloadable, and the
 * browser's back button must work. That is `pushState` plus `popstate`, not a
 * piece of component state pretending to be a route.
 */
function sectionFromPath(pathname: string, slug: string): Section {
  const rest = pathname.replace(`/app/${slug}`, '').replace(/^\//, '')
  return SECTIONS.find((s) => s.id === rest)?.id ?? 'controls'
}

function useSection(slug: string): [Section, (next: Section) => void] {
  const read = (): Section => sectionFromPath(window.location.pathname, slug)

  const [section, setSection] = useState<Section>(read)

  useEffect(() => {
    // Re-read the path on popstate rather than closing over `read`, so the
    // listener has no stale slug and the effect needs no dependency on it.
    const onPop = () => setSection(sectionFromPath(window.location.pathname, slug))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [slug])

  const navigate = (next: Section) => {
    window.history.pushState({}, '', next === 'controls' ? `/app/${slug}` : `/app/${slug}/${next}`)
    setSection(next)
  }

  return [section, navigate]
}

function NavIcon({ name }: { name: string }) {
  const Icon = (Icons as unknown as Record<string, React.ComponentType<{ size?: number }>>)[name]
  return Icon ? (
    <span aria-hidden="true" style={{ display: 'inline-flex', flexShrink: 0 }}>
      <Icon size={17} />
    </span>
  ) : null
}

function AdminNav({
  slug,
  section,
  onNavigate,
  isSystem,
}: {
  slug: string
  section: Section
  onNavigate: (next: Section) => void
  /** Only the instance's own tenant supervises the instance. */
  isSystem: boolean
}) {
  return (
    <nav aria-label="Sections" className="admin-nav">
      {SECTIONS.filter((entry) => entry.id !== 'platform' || isSystem).map((entry) => {
        const current = entry.id === section
        return (
          <a
            key={entry.id}
            href={entry.id === 'controls' ? `/app/${slug}` : `/app/${slug}/${entry.id}`}
            // A real link, so it can be opened in a new tab and read by anything
            // that harvests links — the click handler only avoids the reload.
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey) return
              event.preventDefault()
              onNavigate(entry.id)
            }}
            aria-current={current ? 'page' : undefined}
            className={current ? 'admin-nav-item is-current' : 'admin-nav-item'}
            // What the guided tour anchors each step to. A selector on the real
            // element rather than a screenshot, so a rail that grows an entry
            // grows a step with it.
            data-tour={entry.id}
          >
            <NavIcon name={entry.icon} />
            {entry.label}
          </a>
        )
      })}
    </nav>
  )
}

// ── Controls ────────────────────────────────────────────────────────────────

function ControlsScreen({ slug, canWrite }: { slug: string; canWrite: boolean }) {
  const queryClient = useQueryClient()
  const controls = useQuery({
    queryKey: ['controls', slug],
    queryFn: () => adminApi.controls(slug),
  })
  const [editing, setEditing] = useState<Control | 'new' | null>(null)
  const [query, setQuery] = useState('')

  if (controls.isPending) return <Centered>Loading controls…</Centered>
  if (controls.isError) return <Banner tone="down">Could not load controls.</Banner>

  if (editing) {
    return (
      <ControlEditor
        slug={slug}
        control={editing === 'new' ? null : editing}
        onDone={() => {
          setEditing(null)
          void queryClient.invalidateQueries({ queryKey: ['controls', slug] })
        }}
      />
    )
  }

  const matches = matching(controls.data, query)

  return (
    <section style={{ paddingTop: 'var(--space-6)' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 'var(--space-4)',
          gap: 'var(--space-3)',
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 'var(--text-xl)' }}>Controls</h1>
          {/* The count is only worth showing once it differs from the whole. */}
          {query.trim() !== '' && (
            <p
              className="tabular"
              style={{
                margin: 'var(--space-1) 0 0',
                fontSize: 'var(--text-sm)',
                color: 'var(--color-fg-subtle)',
              }}
            >
              {matches.length} of {controls.data.length}
            </p>
          )}
        </div>
        {canWrite && (
          <Button variant="primary" onClick={() => setEditing('new')}>
            New control
          </Button>
        )}
      </div>

      {/* Filtering happens in the browser: the whole list is already loaded, so
          a round trip per keystroke would add latency to answer a question the
          page can answer instantly. It stops being right somewhere past a few
          hundred controls, which is where a server-side search earns its
          complexity. */}
      {controls.data.length > 0 && (
        <div style={{ marginBottom: 'var(--space-4)', maxWidth: '30rem' }}>
          <Field label="Find a control" hint="Matches the name, the key and the description.">
            <Input
              type="search"
              value={query}
              placeholder="api, cache, backup…"
              onChange={(e) => setQuery(e.target.value)}
            />
          </Field>
        </div>
      )}

      {controls.data.length === 0 ? (
        <EmptyState
          title="No controls yet"
          hint="A control is one thing you monitor. Create one and TERN will hand you a script that pushes to it."
          action={
            canWrite ? (
              <Button variant="primary" onClick={() => setEditing('new')}>
                Create the first control
              </Button>
            ) : undefined
          }
        />
      ) : matches.length === 0 ? (
        /* Distinct from "no controls yet": one is a state to fix, the other is
           a search to change, and the same words for both would be wrong. */
        <EmptyState
          title={`Nothing matches “${query}”`}
          hint="Names, keys and descriptions are searched."
          action={<Button onClick={() => setQuery('')}>Clear the search</Button>}
        />
      ) : (
        /*
         * A grid rather than a stack. Twenty controls in a single column on a
         * 1440px display is one line of text per screen-inch and two empty
         * thirds; a card can carry what the row could not — the widget, the
         * probe kind, whether it is public — without any of them becoming a
         * column that has to be maintained.
         */
        <div className="card-grid">
          {matches.map((control) => (
            <ControlCard
              key={control.id}
              control={control}
              slug={slug}
              canWrite={canWrite}
              onEdit={() => setEditing(control)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * Substring match across the three things a control is known by.
 *
 * Case-insensitive and accent-insensitive, because a key is `db-eu-west` while
 * its name might be "Base de données (Paris)" and someone typing "donnees"
 * should find it. Every term must match somewhere, so "api paris" narrows
 * rather than widens — the behaviour of every search box people already use.
 */
export function matching(controls: Control[], query: string): Control[] {
  const terms = fold(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return controls

  return controls.filter((control) => {
    const haystack = fold(`${control.name} ${control.key} ${control.description ?? ''}`)
    return terms.every((term) => haystack.includes(term))
  })
}

function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
}

function ControlCard({
  control,
  canWrite,
  onEdit,
  slug,
}: {
  control: Control
  canWrite: boolean
  onEdit: () => void
  slug: string
}) {
  const widget = widgetById(control.widget)
  const queryClient = useQueryClient()
  const [refused, setRefused] = useState<string | null>(null)

  /*
   * Not offered where it cannot work: a pushed control has no probe to run, and
   * a disabled one is supposed to have stopped. The server refuses both anyway
   * — this only keeps a button off the card that could never do anything.
   */
  const checkable = canWrite && control.kind !== 'push' && control.enabled

  const check = useMutation({
    mutationFn: () => adminApi.checkNow(slug, control.id),
    onSuccess: async () => {
      setRefused(null)
      // The three timestamps below are what just changed, and they come from
      // the list — so the list is what has to be refetched.
      await queryClient.invalidateQueries({ queryKey: ['controls', slug] })
    },
    // The API's sentence is the useful one: it names which of the three
    // refusals applied, and an agent owning the control is not an error the
    // reader can fix by pressing again.
    onError: (err) => setRefused(err instanceof ApiError ? err.message : String(err)),
  })

  return (
    <Card>
      <div
        style={{
          display: 'grid',
          gap: 'var(--space-2)',
          height: '100%',
        }}
      >
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
          <strong style={{ flex: 1, minWidth: 0 }}>{control.name}</strong>
          {/* State as a word, never as a colour alone — and only when it is not
              the default, so the eye lands on the exceptions. */}
          {!control.isPublic && <Tag>internal</Tag>}
          {!control.enabled && <Tag tone="down">disabled</Tag>}
          {checkable && (
            <Button
              ariaLabel={`Check ${control.name} now`}
              busy={check.isPending}
              onClick={() => check.mutate()}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <Icons.RefreshCw size={14} aria-hidden="true" />
                Check
              </span>
            </Button>
          )}
          {canWrite && <Button onClick={onEdit}>Edit</Button>}
        </div>

        {refused && (
          <p
            role="alert"
            style={{
              margin: 0,
              fontSize: 'var(--text-xs)',
              color: 'var(--status-down)',
            }}
          >
            {refused}
          </p>
        )}

        <code
          className="tabular"
          style={{ fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}
        >
          {control.key}
        </code>

        {control.description && (
          <p
            style={{
              margin: 0,
              fontSize: 'var(--text-sm)',
              color: 'var(--color-fg-muted)',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {control.description}
          </p>
        )}

        {/* A tinted strip rather than more white: the specs live here, each
            with an icon, so a card can be read by shape before it is read by
            word. The icons are tinted with the accent rather than given hues of
            their own — a second categorical palette beside the status one is
            how a coloured chip starts being mistaken for a state. */}
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-3)',
            flexWrap: 'wrap',
            alignItems: 'center',
            fontSize: 'var(--text-xs)',
            color: 'var(--color-fg-muted)',
            marginTop: 'auto',
            // Inset with its own rounding rather than bled to the card's edge:
            // the bleed relied on a negative margin inside a clipping container,
            // which cut the strip's bottom off.
            padding: 'var(--space-2) var(--space-3)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--color-surface-raised)',
            border: '1px solid var(--color-border)',
          }}
        >
          <Spec
            icon={control.kind === 'push' ? 'ArrowUpFromLine' : 'Radar'}
            chip={control.kind === 'push' ? 'deep' : 'rose'}
            label={control.kind === 'push' ? 'pushed' : `${control.kind} probe`}
          />
          <Spec icon={widget.icon} chip={widget.chip} label={widget.label} />
        </div>

        <ControlActivity control={control} />
      </div>
    </Card>
  )
}

/**
 * The three moments that answer "is this thing alright" without opening it.
 *
 * They are not redundant with each other, which is why all three are here. The
 * last check says whether anything is still reporting; the last success says
 * how long it has been broken; the last failure says whether a control that
 * reads fine now has been quietly flapping. A card showing only the first can
 * be green and three days stale at the same time.
 *
 * Status carries a colour, but never only a colour: each line has its own glyph
 * and its own word, so the card survives a monochrome print, a colour-blind
 * reader, and the theme being wrong.
 */
function ControlActivity({ control }: { control: Control }) {
  const status = control.lastCheckStatus
  const failed = status === 'down' || status === 'partial'

  /*
   * The word, not just the tint.
   *
   * Without it the three lines can read as a contradiction — a check at 22:09,
   * no success, no failure — when the honest answer is that the last thing
   * recorded was `unknown`, which is neither. `unknown` is not even a
   * measurement: it is the scheduler noting that nothing arrived in time. A
   * reader owed that word should not have to open the control to find it.
   */
  const said = status === null ? null : status === 'unknown' ? 'no data' : status

  return (
    <dl
      style={{
        display: 'grid',
        gap: 'var(--space-1)',
        margin: 0,
        fontSize: 'var(--text-xs)',
      }}
    >
      <ActivityLine
        icon={status === null ? 'CircleDashed' : failed ? 'CircleAlert' : 'Activity'}
        tone={status === null ? 'var(--status-unknown)' : statusTone(status)}
        label="Last check"
        at={control.lastCheckAt}
        none="never reported"
        said={said}
        saidTone={status === null ? undefined : statusTone(status)}
        why={control.lastCheckMessage}
      />
      <ActivityLine
        icon="CircleCheck"
        tone="var(--status-operational)"
        label="Last success"
        at={control.lastSuccessAt}
        none="no success recorded"
      />
      <ActivityLine
        icon="CircleX"
        tone="var(--status-down)"
        label="Last failure"
        at={control.lastFailureAt}
        // Not "never failed": the window is what the instance still keeps, and
        // claiming a clean record beyond it would be a claim we cannot make.
        none="none on record"
      />
    </dl>
  )
}

function statusTone(status: string): string {
  const known = ['operational', 'degraded', 'partial', 'down', 'maintenance']
  return known.includes(status) ? `var(--status-${status})` : 'var(--status-unknown)'
}

function ActivityLine({
  icon,
  tone,
  label,
  at,
  none,
  said,
  saidTone,
  why,
}: {
  icon: string
  tone: string
  label: string
  at: string | null
  none: string
  /** The status this line reports, where a time alone would not explain it. */
  said?: string | null
  saidTone?: string
  /** The check's own message, hovered rather than shown — it is a sentence. */
  why?: string | null
}) {
  const Icon = (Icons as unknown as Record<string, React.ComponentType<{ size?: number }>>)[icon]

  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
      <span
        aria-hidden="true"
        style={{ color: at ? tone : 'var(--color-fg-subtle)', lineHeight: 0, alignSelf: 'center' }}
      >
        {Icon && <Icon size={13} />}
      </span>
      <dt style={{ color: 'var(--color-fg-subtle)' }}>{label}</dt>
      <dd
        className="tabular"
        style={{
          margin: 0,
          marginLeft: 'auto',
          textAlign: 'right',
          color: at ? 'var(--color-fg)' : 'var(--color-fg-subtle)',
          fontStyle: at ? 'normal' : 'italic',
        }}
      >
        {at ? (
          // The absolute moment is what is read, and the age is what is
          // hovered: "14:02" answers "was that before or after the deploy",
          // which "3 h ago" makes the reader compute.
          <time
            dateTime={at}
            title={[`${new Date(at).toLocaleString()} · ${ago(at)}`, why]
              .filter(Boolean)
              .join('\n')}
          >
            {said && (
              <>
                <span style={{ color: saidTone, fontWeight: 600 }}>{said}</span>
                <span aria-hidden="true" style={{ color: 'var(--color-fg-subtle)' }}>
                  {' · '}
                </span>
              </>
            )}
            {shortWhen(at)}
          </time>
        ) : (
          none
        )}
      </dd>
    </div>
  )
}

/**
 * Date and time, dropping what today already implies.
 *
 * Same day: the clock alone, because the date is the one the reader is living
 * in. Otherwise the day comes back, and the year only once it is not this one —
 * a card is a small surface and "2026" earns its place on none of them.
 */
function shortWhen(iso: string): string {
  const at = new Date(iso)
  const now = new Date()
  const sameDay = at.toDateString() === now.toDateString()

  const clock = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return clock

  const day = at.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  })
  return `${day} ${clock}`
}

/** The same wording the fleet screen uses for an agent's last contact. */
function ago(iso: string): string {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

/** One fact about a control: a coloured chip, an icon, and the word it stands for. */
function Spec({ icon, chip, label }: { icon: string; chip: keyof typeof CHIPS; label: string }) {
  const Icon = (Icons as unknown as Record<string, React.ComponentType<{ size?: number }>>)[icon]
  const colour = CHIPS[chip]!

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 22,
          height: 22,
          borderRadius: 'var(--radius-sm)',
          // The colour lives in the chip, and the glyph is measured against it
          // rather than against the card — a filled chip is legible in either
          // theme without a second set of values.
          background: colour.fill,
          color: colour.fg,
          flexShrink: 0,
        }}
      >
        {/* Never the icon alone — the word beside it is what a screen reader
            and a colourblind reader both get. */}
        {Icon ? <Icon size={13} /> : null}
      </span>
      {label}
    </span>
  )
}

function Tag({ children, tone }: { children: React.ReactNode; tone?: 'down' }) {
  return (
    <span
      style={{
        flexShrink: 0,
        padding: '0 var(--space-2)',
        borderRadius: 'var(--radius-full)',
        border: `1px solid ${tone === 'down' ? 'var(--status-down)' : 'var(--color-border-strong)'}`,
        color: tone === 'down' ? 'var(--status-down)' : 'var(--color-fg-muted)',
        fontSize: 'var(--text-xs)',
        fontWeight: 600,
      }}
    >
      {children}
    </span>
  )
}

// ── Editor ──────────────────────────────────────────────────────────────────

const STEPS = ['Definition', 'Preview', 'Simulate', 'Script'] as const

/** Matches `Input`'s styling — a `<select>` is a different element and inherits none of it. */
const SELECT_STYLE: React.CSSProperties = {
  background: 'var(--color-bg)',
  color: 'var(--color-fg)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 'var(--radius-sm)',
  padding: 'var(--space-2) var(--space-3)',
  fontSize: 'var(--text-base)',
  fontFamily: 'inherit',
  minHeight: 44,
  width: '100%',
}

/** The kinds a control can be, in the order the picker offers them. */
const CONTROL_KINDS = [
  { id: 'push', label: 'Push', hint: 'Your script or CI sends the measurement to TERN.' },
  { id: 'http', label: 'HTTP', hint: 'Request a URL and read the response.' },
  { id: 'tcp', label: 'TCP', hint: 'Open a socket to a host and port.' },
  { id: 'ping', label: 'Ping', hint: 'ICMP echo to a host.' },
  { id: 'dns', label: 'DNS', hint: 'Resolve a name and check the answer.' },
  { id: 'cert', label: 'TLS certificate', hint: 'Read the certificate and its expiry.' },
] as const

const KIND_HINT: Record<string, string> = Object.fromEntries(
  CONTROL_KINDS.map((k) => [k.id, k.hint]),
)

/**
 * The probe spec for what the form currently describes.
 *
 * Only the fields belonging to the chosen kind are emitted: the API validates
 * against a discriminated union, and a leftover `url` on a ping probe is a
 * rejected save with a message about a field the operator cannot see.
 */
function probeConfig(form: {
  kind: string
  url: string
  method: string
  host: string
  port: number
  dnsName: string
  recordType: string
}): Record<string, unknown> {
  switch (form.kind) {
    case 'http':
      return { url: form.url.trim(), method: form.method }
    case 'tcp':
      return { host: form.host.trim(), port: form.port }
    case 'ping':
      return { host: form.host.trim() }
    case 'dns':
      return { name: form.dnsName.trim(), recordType: form.recordType }
    case 'cert':
      return { host: form.host.trim(), port: form.port }
    default:
      // `push` carries no probe. An empty object rather than the previous spec,
      // so switching a control to push actually stops it being probed.
      return {}
  }
}

function ControlEditor({
  slug,
  control,
  onDone,
}: {
  slug: string
  control: Control | null
  onDone: () => void
}) {
  // The tenant's retention mode decides which widgets can be fed at all. Read
  // from the public summary, which admins can see and which is already cached.
  const summary = useQuery({ queryKey: ['summary', slug], queryFn: () => api.summary(slug) })
  const retentionMode = summary.data?.tenant.retentionMode ?? 'historical'

  const [step, setStep] = useState(0)
  /*
   * A control says what is checked, how, and from where — and until this form
   * carried those, everything it created was a `push` control: a row waiting for
   * something outside TERN to send it a measurement. The probe kinds existed in
   * the API and in the agent all along, reachable only by hand.
   */
  const probe = (control?.config ?? {}) as Record<string, unknown>
  const [form, setForm] = useState({
    key: control?.key ?? '',
    name: control?.name ?? '',
    description: control?.description ?? '',
    kind: control?.kind ?? 'push',
    // One field per target shape rather than one shared "target": switching
    // between HTTP and ping should not silently reinterpret a URL as a hostname.
    url: typeof probe.url === 'string' ? probe.url : '',
    method: typeof probe.method === 'string' ? probe.method : 'GET',
    host: typeof probe.host === 'string' ? probe.host : '',
    port: typeof probe.port === 'number' ? probe.port : 443,
    dnsName: typeof probe.name === 'string' ? probe.name : '',
    recordType: typeof probe.recordType === 'string' ? probe.recordType : 'A',
    expectedIntervalS: control?.expectedIntervalS ?? 60,
    degradedThresholdMs: control?.degradedThresholdMs ?? 500,
    downThresholdMs: control?.downThresholdMs ?? 3000,
    isPublic: control?.isPublic ?? true,
  })
  // The whole control, not just its id: the preview needs its key for a stable
  // sample seed, its unit to decide which widgets apply, and its current widget
  // so the gallery opens on the existing choice.
  const [savedControl, setSavedControl] = useState<Control | null>(control)
  const saved = savedControl
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        key: form.key.trim(),
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        kind: form.kind,
        config: probeConfig(form),
        // Two meanings, one column, and both are "how often to expect a point":
        // the interval a probe runs at, and the silence after which a pushed
        // control goes unknown.
        expectedIntervalS: form.kind === 'push' ? null : form.expectedIntervalS,
        degradedThresholdMs: form.degradedThresholdMs,
        downThresholdMs: form.downThresholdMs,
        isPublic: form.isPublic,
      }
      if (savedControl) {
        await adminApi.updateControl(slug, savedControl.id, body)
        return { ...savedControl, ...body, description: body.description ?? null }
      }
      const created = await adminApi.createControl(slug, body)
      // Compose the control locally rather than refetching: the API returned
      // the id, and everything else is what was just submitted.
      return {
        ...created,
        ...body,
        description: body.description ?? null,
        groupId: null,
        enabled: true,
        valueUnit: null,
        valueLabel: null,
        slaTarget: null,
        widget: DEFAULT_WIDGET,
        widgetOptions: {},
        position: 0,
        // Nothing has reported to a control created a second ago, and these are
        // the honest values for that — not a gap to be filled by a refetch.
        lastCheckAt: null,
        lastCheckStatus: null,
        lastCheckMessage: null,
        lastSuccessAt: null,
        lastFailureAt: null,
      } satisfies Control
    },
    onSuccess: (result) => {
      setSavedControl(result)
      setError(null)
      setStep(1)
    },
    // The API's message is the useful one — "the degraded threshold must be
    // below the down threshold" beats a generic failure.
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  })

  return (
    <section style={{ paddingTop: 'var(--space-6)', display: 'grid', gap: 'var(--space-4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 'var(--text-xl)' }}>
          {control ? control.name : 'New control'}
        </h1>
        {/* "Back to controls", not "Back": the step footer below has its own
            Back, which means the previous step. Two buttons a screen apart with
            the same word and different destinations is a coin toss. */}
        <Button onClick={onDone}>Back to controls</Button>
      </div>

      {/* A step indicator, and steps past the first stay locked until the
          control exists — the later ones all need its id. */}
      <ol
        style={{
          display: 'flex',
          gap: 'var(--space-2)',
          listStyle: 'none',
          padding: 0,
          margin: 0,
          flexWrap: 'wrap',
        }}
      >
        {STEPS.map((label, index) => {
          const reachable = index === 0 || Boolean(saved)
          return (
            <li key={label}>
              <button
                onClick={() => reachable && setStep(index)}
                disabled={!reachable}
                aria-current={index === step ? 'step' : undefined}
                style={{
                  background: index === step ? 'var(--color-surface-raised)' : 'transparent',
                  border: `1px solid ${index === step ? 'var(--color-border-strong)' : 'var(--color-border)'}`,
                  color: reachable ? 'var(--color-fg)' : 'var(--color-fg-subtle)',
                  borderRadius: 'var(--radius-full)',
                  padding: '0 var(--space-3)',
                  minHeight: 36,
                  fontSize: 'var(--text-sm)',
                  fontFamily: 'inherit',
                  cursor: reachable ? 'pointer' : 'not-allowed',
                }}
              >
                {index + 1}. {label}
              </button>
            </li>
          )
        })}
      </ol>

      {error && <Banner tone="down">{error}</Banner>}

      {step === 0 && (
        <Card>
          <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
            <Field
              label="Key"
              hint="Lowercase letters, digits, dot, dash or underscore. Scripts and alerts push against this, so renaming the display name never breaks ingestion."
            >
              <Input
                value={form.key}
                onChange={(e) => setForm({ ...form, key: e.target.value })}
                placeholder="api-gateway"
                disabled={Boolean(saved)}
              />
            </Field>

            <Field label="Name">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="API gateway"
              />
            </Field>

            <Field label="Description">
              <Input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </Field>

            {/*
             * What is checked, and where the check points.
             *
             * A control with no probe is a `push` control: TERN waits to be
             * told. Anything else is a job somebody runs — this instance
             * itself, or an agent placed where this instance cannot reach.
             */}
            <Field label="What to check" hint={KIND_HINT[form.kind] ?? ''}>
              <select
                value={form.kind}
                onChange={(e) => setForm({ ...form, kind: e.target.value })}
                style={SELECT_STYLE}
              >
                {CONTROL_KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
            </Field>

            {form.kind === 'http' && (
              <div className="field-row is-lead-first">
                <Field label="URL" hint="Where the request goes. https:// or http://.">
                  <Input
                    value={form.url}
                    onChange={(e) => setForm({ ...form, url: e.target.value })}
                    placeholder="https://example.com/health"
                  />
                </Field>
                <Field label="Method">
                  <select
                    value={form.method}
                    onChange={(e) => setForm({ ...form, method: e.target.value })}
                    style={SELECT_STYLE}
                  >
                    {['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            )}

            {(form.kind === 'tcp' || form.kind === 'cert') && (
              <div className="field-row is-lead-first">
                <Field label="Host" hint="A hostname or an address. No scheme.">
                  <Input
                    value={form.host}
                    onChange={(e) => setForm({ ...form, host: e.target.value })}
                    placeholder="example.com"
                  />
                </Field>
                <Field label="Port">
                  <Input
                    type="number"
                    value={form.port}
                    onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
                  />
                </Field>
              </div>
            )}

            {form.kind === 'ping' && (
              <Field label="Host" hint="A hostname or an address. ICMP must be allowed to it.">
                <Input
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                  placeholder="example.com"
                />
              </Field>
            )}

            {form.kind === 'dns' && (
              <div className="field-row is-lead-first">
                <Field label="Name" hint="The record to resolve.">
                  <Input
                    value={form.dnsName}
                    onChange={(e) => setForm({ ...form, dnsName: e.target.value })}
                    placeholder="example.com"
                  />
                </Field>
                <Field label="Type">
                  <select
                    value={form.recordType}
                    onChange={(e) => setForm({ ...form, recordType: e.target.value })}
                    style={SELECT_STYLE}
                  >
                    {['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'].map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            )}

            {form.kind !== 'push' && (
              <div className="field-row is-lead-last">
                <Field label="Every (seconds)" hint="How often the check runs.">
                  <Input
                    type="number"
                    value={form.expectedIntervalS}
                    onChange={(e) =>
                      setForm({ ...form, expectedIntervalS: Number(e.target.value) })
                    }
                  />
                </Field>
                <Field
                  label="Runs from"
                  hint="Pair an agent to check from inside a network this server cannot reach."
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      minHeight: 44,
                      fontSize: 'var(--text-sm)',
                      color: 'var(--color-fg-muted)',
                    }}
                  >
                    This server, until an agent covers this control
                  </div>
                </Field>
              </div>
            )}

            {/*
             * Latency thresholds are folded away, and the defaults are the
             * answer for almost everyone. Naming a control is a decision; the
             * millisecond at which it counts as degraded is a tuning exercise,
             * and putting the two on one screen made the second look as
             * required as the first.
             *
             * `<details>` rather than a toggle we own: it opens without state,
             * is keyboard-operable, and its contents stay findable by the
             * browser's own in-page search when closed.
             */}
            <details>
              <summary
                style={{
                  cursor: 'pointer',
                  fontSize: 'var(--text-sm)',
                  color: 'var(--color-fg-muted)',
                }}
              >
                Advanced
              </summary>

              <div className="field-row" style={{ marginTop: 'var(--space-3)' }}>
                <Field
                  label="Degraded above (ms)"
                  hint="A push carrying a slower latency than this is shown degraded."
                >
                  <Input
                    type="number"
                    value={form.degradedThresholdMs}
                    onChange={(e) =>
                      setForm({ ...form, degradedThresholdMs: Number(e.target.value) })
                    }
                  />
                </Field>
                <Field label="Down above (ms)" hint="Must be above the degraded threshold.">
                  <Input
                    type="number"
                    value={form.downThresholdMs}
                    onChange={(e) => setForm({ ...form, downThresholdMs: Number(e.target.value) })}
                  />
                </Field>
              </div>
            </details>

            {/*
             * No visibility control here. A control is on the page or it is not
             * worth creating, and this edition has no public/private
             * distinction to hang it from. `form.isPublic` is still submitted
             * so that editing a control which auto-registration created as
             * internal does not quietly publish it on the next save.
             */}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button
                variant="primary"
                busy={save.isPending}
                disabled={!form.key.trim() || !form.name.trim()}
                onClick={() => save.mutate()}
              >
                {saved ? 'Save changes' : 'Create and continue'}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {step === 1 && savedControl && (
        <PreviewStep
          slug={slug}
          control={savedControl}
          retentionMode={retentionMode}
          onSaved={(widget, widgetOptions) =>
            setSavedControl({ ...savedControl, widget, widgetOptions })
          }
        />
      )}
      {step === 2 && saved && <SimulateStep slug={slug} control={saved} />}
      {step === 3 && saved && <ScriptTabs slug={slug} controlId={saved.id} />}

      {/*
       * The way onward, for every step after the first.
       *
       * Step one ends on "Create and continue" and the rest ended on nothing —
       * the numbered tabs above were the only way forward, which asks the
       * reader to notice that a row they took for a progress indicator is
       * actually the navigation. A sequence that names its steps should carry
       * you through them.
       *
       * "Back" is the step behind, not the way out; leaving is the button at
       * the top, where it was before and still is.
       */}
      {step > 0 && saved && (
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-2)',
            justifyContent: 'flex-end',
            marginTop: 'var(--space-4)',
          }}
        >
          <Button onClick={() => setStep(step - 1)}>Back</Button>
          {step < STEPS.length - 1 ? (
            <Button variant="primary" onClick={() => setStep(step + 1)}>
              Continue
            </Button>
          ) : (
            <Button variant="primary" onClick={onDone}>
              Done
            </Button>
          )}
        </div>
      )}
    </section>
  )
}

function SimulateStep({ slug, control }: { slug: string; control: Control }) {
  const queryClient = useQueryClient()
  const [days, setDays] = useState(30)
  const [uptime, setUptime] = useState(0.995)
  const [result, setResult] = useState<string | null>(null)

  const controlId = control.id

  // The point of the step: seeing the widget with data in it. Read back from
  // the server rather than drawn from the generator's return value, so what is
  // shown is what was actually stored — including the shape the aggregation
  // gives it.
  const series = useQuery({
    queryKey: ['series', slug, controlId, days],
    queryFn: () => adminApi.series(slug, controlId, days),
  })

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['uptime', slug] })
    await queryClient.invalidateQueries({ queryKey: ['series', slug, controlId] })
  }

  const simulate = useMutation({
    mutationFn: () => adminApi.simulate(slug, controlId, { days, targetUptime: uptime }),
    onSuccess: (r) => {
      setResult(`${r.inserted} points generated.`)
      void refresh()
    },
  })

  const purge = useMutation({
    mutationFn: () => adminApi.purgeSimulation(slug, controlId),
    onSuccess: (r) => {
      setResult(`${r.deleted} simulation points removed.`)
      void refresh()
    },
  })

  return (
    <Card>
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <Banner tone="maintenance">
          {/* Said plainly, because the alternative is someone quietly wondering
              whether their demo is inflating a published number. */}
          Simulation data is marked separately and never counts towards published uptime. Remove it
          in one click when you are done.
        </Banner>

        <div className="field-row">
          <Field label="Days">
            <Input
              type="number"
              min={1}
              max={90}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            />
          </Field>
          <Field label="Target uptime" hint="0.9 to 1">
            <Input
              type="number"
              step="0.001"
              min={0.5}
              max={1}
              value={uptime}
              onChange={(e) => setUptime(Number(e.target.value))}
            />
          </Field>
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <Button variant="primary" busy={simulate.isPending} onClick={() => simulate.mutate()}>
            Generate
          </Button>
          <Button variant="danger" busy={purge.isPending} onClick={() => purge.mutate()}>
            Remove simulation data
          </Button>
        </div>

        {result && <Banner tone="operational">{result}</Banner>}

        {/* ── The widget, on this control's actual data ─────────────────── */}
        <div>
          <h3 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-sm)' }}>
            {widgetById(control.widget).label}
            {series.data?.synthetic && (
              <span
                style={{
                  marginLeft: 'var(--space-2)',
                  fontSize: 'var(--text-xs)',
                  fontWeight: 600,
                  color: 'var(--status-maintenance)',
                }}
              >
                simulated data
              </span>
            )}
          </h3>

          {series.isPending ? (
            <p style={{ color: 'var(--color-fg-subtle)', margin: 0 }}>Loading the series…</p>
          ) : series.data && series.data.points.length > 0 ? (
            <SimulatedWidget control={control} points={series.data.points} />
          ) : (
            <p style={{ color: 'var(--color-fg-subtle)', margin: 0 }}>
              Nothing recorded yet. Generate a simulation and the widget will draw it.
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}

/**
 * The control's chosen widget, fed the series the server just returned.
 *
 * Rendered through the registry rather than a fixed chart, so this step answers
 * the question it is actually asked: not "is there data" but "does the widget I
 * picked look right with data in it".
 */
function SimulatedWidget({
  control,
  points,
}: {
  control: Control
  points: {
    ts: string
    status: string
    latencyMs: number | null
    value: number | null
    metrics?: Record<string, number>
  }[]
}) {
  const widget = widgetById(control.widget)
  const options = resolveOptions(widget, control.widgetOptions)

  const series = points.map((point) => ({
    ts: new Date(point.ts),
    status: point.status as CheckStatusValue,
    latencyMs: point.latencyMs,
    value: point.value,
    metrics: point.metrics,
    message: null,
  }))

  return (
    <widget.Component
      label={control.name}
      locale="en"
      timeZone="UTC"
      options={options}
      series={series}
      unit={control.valueUnit}
      valueLabel={control.valueLabel}
      warnAt={Number(options.warnAt ?? 0) || null}
      limitAt={Number(options.limitAt ?? 0) || null}
    />
  )
}

// ── Sign in ─────────────────────────────────────────────────────────────────

function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [needsMfa, setNeedsMfa] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Read once at first render: whether the browser can do WebAuthn at all does
  // not change while somebody is looking at the form.
  const [canUsePasskey] = useState(passkeysSupported)

  const passkeySignIn = useMutation({
    mutationFn: signInWithPasskey,
    onSuccess: () => {
      setError(null)
      onSignedIn()
    },
    onError: (err) => {
      // Dismissing the prompt is a decision, not a failure. Anything else is
      // worth saying out loud.
      if (err instanceof PasskeyCancelled) setError(null)
      else setError(err instanceof Error ? err.message : String(err))
    },
  })

  const signIn = useMutation({
    mutationFn: async () => {
      if (needsMfa) {
        await adminApi.verifyMfa(code)
        return { mfaRequired: false }
      }
      return adminApi.login(email, password)
    },
    onSuccess: (result) => {
      setError(null)
      if (result.mfaRequired) setNeedsMfa(true)
      else onSignedIn()
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  })

  if (recovering) return <RecoverScreen onBack={() => setRecovering(false)} />

  return (
    /*
     * The same shape as the root: photograph on one side, a card on the other.
     * Signing in and choosing a page are the two doors into this product, and
     * two doors that look unrelated make the second one feel like a different
     * building.
     */
    <main className="landing">
      <div className="landing-image" role="img" aria-label="A tern over the sea" />

      <div className="landing-panel">
        <Card style={{ width: 'min(26rem, 100%)' }}>
          <div style={{ textAlign: 'center', marginBottom: 'var(--space-5)' }}>
            <TernWordmark size={34} />
            <h1
              style={{
                margin: 'var(--space-3) 0 0',
                fontSize: 'var(--text-xl)',
                color: 'var(--color-fg)',
              }}
            >
              Sign in
            </h1>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              signIn.mutate()
            }}
            style={{ display: 'grid', gap: 'var(--space-4)' }}
          >
            {error && <Banner tone="down">{error}</Banner>}

            {needsMfa ? (
              <Field label="Authentication code" hint="From your authenticator app.">
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                />
              </Field>
            ) : (
              <>
                <Field label="Email">
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="username"
                    autoFocus
                  />
                </Field>
                <Field label="Password">
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                </Field>
              </>
            )}

            <Button type="submit" variant="primary" busy={signIn.isPending}>
              {needsMfa ? 'Verify' : 'Sign in'}
            </Button>

            {/* Below the password rather than above it. A passkey is the better
                way in for whoever has one, but the form has to open on the way
                that works for everybody — including the person signing in from
                a machine that is not theirs. It is hidden entirely, rather than
                disabled, where the browser cannot do WebAuthn: an offer that
                cannot be accepted is worse than no offer.

                It is not shown beside the TOTP prompt either, where the account
                is already half identified and a passkey would restart from
                somebody else. */}
            {!needsMfa && canUsePasskey && (
              <>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-3)',
                    color: 'var(--color-fg-subtle)',
                    fontSize: 'var(--text-xs)',
                  }}
                >
                  <span style={{ flex: 1, height: 1, background: 'var(--color-border)' }} />
                  or
                  <span style={{ flex: 1, height: 1, background: 'var(--color-border)' }} />
                </div>

                <Button
                  type="button"
                  onClick={() => passkeySignIn.mutate()}
                  busy={passkeySignIn.isPending}
                >
                  <Icons.KeyRound
                    size={15}
                    aria-hidden="true"
                    style={{ marginRight: 'var(--space-2)' }}
                  />
                  Use a passkey
                </Button>
              </>
            )}

            {/* Offered only on the password step. Beside a TOTP prompt it would
                be answering the wrong question — a lost authenticator is a
                recovery code, not a password reset. */}
            {!needsMfa && (
              <button
                type="button"
                onClick={() => setRecovering(true)}
                style={{
                  border: 0,
                  background: 'none',
                  padding: 0,
                  minHeight: 44,
                  color: 'var(--color-accent-ink)',
                  fontFamily: 'inherit',
                  fontSize: 'var(--text-sm)',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Forgotten your password?
              </button>
            )}
          </form>
        </Card>

        <SiteFooter compact />
      </div>
    </main>
  )
}

/**
 * Asking for a reset link.
 *
 * It reports success for every address, because the API does. Saying "no such
 * account" here would hand out a list of who has one, which is the same oracle
 * the sign-in form goes out of its way to avoid — and this form needs no
 * password to ask.
 */
function RecoverScreen({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)

  const ask = useMutation({
    mutationFn: () => adminApi.forgotPassword(email.trim()),
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  })

  return (
    <main className="landing">
      <div className="landing-image" role="img" aria-label="A tern over the sea" />

      <div className="landing-panel">
        <Card style={{ width: 'min(26rem, 100%)' }}>
          <div style={{ textAlign: 'center', marginBottom: 'var(--space-5)' }}>
            <TernWordmark size={34} />
            <h1
              style={{
                margin: 'var(--space-3) 0 0',
                fontSize: 'var(--text-xl)',
                color: 'var(--color-fg)',
              }}
            >
              Reset your password
            </h1>
          </div>

          {ask.isSuccess ? (
            <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
              <Banner tone="operational">
                If that address has an account, a link is on its way.
              </Banner>
              <p
                style={{
                  margin: 0,
                  fontSize: 'var(--text-sm)',
                  color: 'var(--color-fg-subtle)',
                  lineHeight: 1.6,
                }}
              >
                The link works once and expires in 30 minutes. Nothing has changed on the account
                until you use it.
              </p>
              <Button onClick={onBack}>Back to sign in</Button>
            </div>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                setError(null)
                ask.mutate()
              }}
              style={{ display: 'grid', gap: 'var(--space-4)' }}
            >
              {error && <Banner tone="down">{error}</Banner>}

              <Field label="Email" hint="The address you sign in with.">
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  autoFocus
                />
              </Field>

              <Button
                type="submit"
                variant="primary"
                busy={ask.isPending}
                disabled={email.trim() === ''}
              >
                Send the link
              </Button>

              <button
                type="button"
                onClick={onBack}
                style={{
                  border: 0,
                  background: 'none',
                  padding: 0,
                  minHeight: 44,
                  color: 'var(--color-fg-subtle)',
                  fontFamily: 'inherit',
                  fontSize: 'var(--text-sm)',
                  cursor: 'pointer',
                }}
              >
                Back to sign in
              </button>
            </form>
          )}
        </Card>

        <SiteFooter compact />
      </div>
    </main>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: '80dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-4)',
        padding: 'var(--space-4)',
      }}
    >
      {children}
    </div>
  )
}

export { CodeBlock }

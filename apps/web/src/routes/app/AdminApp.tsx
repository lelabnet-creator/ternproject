import { Fragment, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminApi, ApiError, type Control, type ControlGroup } from '../../lib/adminApi'
import {
  Banner,
  Button,
  Card,
  CodeBlock,
  EmptyState,
  Field,
  Input,
  Select,
} from '../../components/ui'
import { TernWordmark } from '../../components/brand/TernMark'
import { ThemePicker } from '../../components/ThemePicker'
import { SponsorButton } from '../../components/SponsorButton'
import { REPO_URL, SiteFooter } from '../../components/SiteFooter'
import { SetupWizard } from '../../features/onboarding/SetupWizard'
import { FirstRunSetup } from '../../features/onboarding/FirstRunSetup'
import { GuidedTour } from '../../features/onboarding/GuidedTour'
import { DemoBanner } from '../../components/DemoBanner'
import { UpdateNotice } from '../../components/UpdateNotice'
import { sandboxOn } from '../../lib/sandbox-flag'
import { accentById, applyAccent } from '../../lib/accents'
import { applyFont, fontById } from '../../lib/fonts'
import { PasskeyCancelled, passkeysSupported, signInWithPasskey } from '../../lib/passkeys'
import { ScriptTabs } from '../../features/control-editor/ScriptTabs'
import { PreviewStep } from '../../features/control-editor/PreviewStep'
import { ImportScreen } from '../../features/control-import/ImportScreen'
import * as Icons from 'lucide-react'
import { CHIPS } from '../../lib/accents'
import { DEFAULT_WIDGET, resolveOptions, widgetById } from '../../charts/registry'
import type { CheckStatusValue } from '@tern/shared/status'
import { api } from '../../lib/api'
import { meansThisMachine, targetHost } from './targets'
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
  // Retried, except on the one answer that means the question is settled.
  //
  // This asked once and treated every failure as "signed out", which is a
  // conclusion the failure does not support: a 429, a 502 from a reverse proxy
  // mid-reload, a dropped connection on a train all say "could not ask", not
  // "you are not signed in". The difference matters because the two look
  // nothing alike to the reader — one is a sign-in form asking for a password
  // they already gave, the other is a machine that will answer in a moment.
  //
  // Found end to end rather than reasoned about: `/auth/me` lives in the route
  // file that carries the hard limiter meant for `/login` and
  // `/password/forgot` — ten requests a minute, per IP. The admin calls it on
  // every mount, so a brisk session hit the limit and was thrown back to the
  // sign-in form holding a valid session cookie. Behind one NAT that counter is
  // shared by everybody in the building.
  const me = useQuery({
    queryKey: ['me'],
    queryFn: adminApi.me,
    retry: (attempt, error) => attempt < 3 && !(error instanceof ApiError && error.status === 401),
    retryDelay: (attempt) => 500 * 2 ** attempt,
  })
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
  /**
   * The tenant's own settings, read from the admin API.
   *
   * The public summary carries the same values inside `branding`, and reading
   * them from there was a quiet mistake: that response is served
   * `Cache-Control: public, max-age=5, stale-while-revalidate=30` — correct for
   * a status page under load, wrong as the way an administrator learns what
   * they just changed. Answering the setup wizard and watching it reappear was
   * the visible symptom; every other setting echoed back through this object
   * had the same lag, for up to thirty seconds, and looked like a save that had
   * not taken.
   *
   * Same query key as the Options screen, so visiting both costs one request.
   */
  const settings = useQuery({
    queryKey: ['settings', slug],
    queryFn: () => adminApi.settings(slug),
    enabled: signedIn,
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

  // From the summary like the accent, and for the same reason: both are read
  // before the settings query has a chance to answer, and a rail that repaints
  // its typeface a beat after it appears is worse than one that starts right.
  // The lag this shares with the accent is the cached summary's, and it costs
  // nothing here — a tenant that has just changed its font is looking at the
  // Options screen, which applies the choice on click without waiting.
  const fontId = branding?.font
  useEffect(() => {
    applyFont(fontById(typeof fontId === 'string' ? fontId : undefined))
  }, [fontId])

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
  //
  // Unless the development sandbox is answering the writes itself, in which
  // case nothing is refused because nothing is sent. `sandboxOn` is false in
  // production by construction; see lib/sandbox-flag.ts.
  const canWrite =
    sandboxOn() || (membership.role === 'admin' && !demo && summary.data?.tenant.readOnly !== true)

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
  // `settings.data !== undefined` rather than a bare falsy check on the field:
  // while the request is in flight the answer is unknown, and treating unknown
  // as "not set up" flashes the wizard at somebody who finished it months ago.
  const needsSetup =
    canWrite &&
    settings.data !== undefined &&
    !settings.data.setupCompletedAt &&
    controls.data !== undefined &&
    controls.data.length === 0

  if (needsSetup) {
    return (
      <SetupWizard
        slug={slug}
        tenantName={membership.name}
        // The settings, because that is now what decides whether this wizard
        // shows. Refetching the summary re-read a cached body and left the
        // wizard exactly where it was.
        onFinished={() => void settings.refetch()}
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
            // Stacked and large: in the rail this is the header of the whole
            // surface, not a label in a line of text. The app bar on a narrow
            // screen keeps the inline lockup, where height is the scarce thing.
            <TernWordmark size={72} orientation="stacked" />
          )}
          <p className="admin-tenant">
            {membership.name}
            <span>{membership.role}</span>
          </p>
        </div>

        {/* Closes the header before the sections begin. A plain border would do
            the job; this fades out at both ends so the rule stops short of the
            rail's edges without needing a margin that would misalign it against
            the navigation below. */}
        <div className="admin-brand-rule" role="presentation" />

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
        {/*
          Everything the reader is told before the screen itself starts.

          Grouped rather than left as loose siblings so the gap between two of
          them is one rule in one place. They stacked flush against each other
          before, because each carried whatever bottom margin it happened to
          have and a `Banner` carries none — two warnings touching read as one
          box with a colour change in the middle.
        */}
        <div className="admin-notices">
          {/* Said on every screen, not only the first: someone who arrives deep
              in the admin from a link has had no chance to be told. */}
          {demo && <DemoBanner variant="admin" />}

          {/*
            A newer image than the running one, said wherever the operator
            happens to be.

            Three conditions, and each removes a reader who cannot act. Signed
            in, because a demo visitor and a stranger at the sign-in form are
            being shown somebody else's instance. An admin of the system tenant,
            because nobody else can pull an image — and the endpoint answers 404
            to them, so mounting this for a tenant admin would be a failed
            request per navigation for a banner that could never appear.
          */}
          {signedIn && !demo && membership.isSystem === true && <UpdateNotice />}

          {/*
            Why nothing can be changed, said once for every screen.

            A disabled button gives no reason and looks exactly like an enabled
            one that did not work — the report that led here was "I cannot click
            another density", from a page where all four were disabled and the
            saved one merely looked chosen. The demo banner above already
            explains its own case, so this covers the other two.
          */}
          {!demo && !canWrite && (
            <Banner tone="maintenance">
              {summary.data?.tenant.readOnly
                ? 'This page is read-only: every change is refused, whoever is signed in. Nothing below will save.'
                : `You are signed in as a ${membership.role}, which can read this page but not change it.`}
            </Banner>
          )}
        </div>

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
          <ControlsScreen
            slug={slug}
            canWrite={canWrite}
            // The rail is the only other way between sections, and it has no
            // idea what a control is. Handing the jump down as a callback keeps
            // the address-bar mechanics in one place — see `useSection`.
            onOpenLogs={(controlId) => setSection('logs', `?q=${encodeURIComponent(controlId)}`)}
          />
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

function useSection(slug: string): [Section, (next: Section, search?: string) => void] {
  const read = (): Section => sectionFromPath(window.location.pathname, slug)

  const [section, setSection] = useState<Section>(read)

  useEffect(() => {
    // Re-read the path on popstate rather than closing over `read`, so the
    // listener has no stale slug and the effect needs no dependency on it.
    const onPop = () => setSection(sectionFromPath(window.location.pathname, slug))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [slug])

  /*
   * `search` carries a filter across the jump — a control's row opens the logs
   * on `?q=<its id>`. It goes in the address rather than into a piece of shared
   * state because the destination screen already has to survive being reloaded
   * and bookmarked, and a second channel saying the same thing would be a
   * second channel to keep in step. The section itself stays in the path;
   * `sectionFromPath` never looks at the query, so nothing here can confuse it.
   */
  const navigate = (next: Section, search?: string) => {
    const path = next === 'controls' ? `/app/${slug}` : `/app/${slug}/${next}`
    window.history.pushState({}, '', `${path}${search ?? ''}`)
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
        const link = (
          <a
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

        /*
          Where this page's own screens end.

          Everything above the rule edits one status page — its controls, its
          incidents, its branding. Everything below leaves it: the instance the
          page runs on, the guide, the page as the public sees it, the issue
          tracker. Two different jobs sharing one column, and until now nothing
          said where one stopped.

          A rule and not a heading: the sections are already named, and a
          "Beyond this page" label would be a word the reader has to read every
          session to learn nothing new.
        */
        return entry.id === 'options' ? (
          <Fragment key={entry.id}>
            {link}
            <div className="admin-nav-rule" role="presentation" />
          </Fragment>
        ) : (
          <Fragment key={entry.id}>{link}</Fragment>
        )
      })}

      {/*
        The guide, from inside the product it documents.

        It was written, rendered and published, and then reachable only by
        someone who already had the repository open — which is nobody who needs
        it. Last in the rail because it is not a section and never the answer to
        "where am I", but in the rail rather than the foot beside sign-out: the
        foot is three controls wide by measurement, and a fourth would take the
        tenant's name down to an ellipsis on a phone. This strip already scrolls.

        A plain external link, no click handler: it leaves the app, and it opens
        in a new tab so it does not cost the reader the screen they were on —
        which is usually the screen they have the question about.
      */}
      <a
        className="admin-nav-item"
        href="/docs/admin-guide.html"
        target="_blank"
        rel="noopener noreferrer"
        // Names the new tab in the accessible name, where an icon cannot say it.
        aria-label="Documentation (opens in a new tab)"
      >
        <NavIcon name="BookOpen" />
        Documentation
        <Icons.ExternalLink size={13} aria-hidden="true" style={{ flexShrink: 0 }} />
      </a>

      {/*
        The API, beside the guide that describes everything but it.

        The document existed nowhere a reader could find it: generated from the
        route schemas, served by the instance, and reachable only by knowing the
        path. Somebody wanting to script what this screen does had the guides,
        which describe the product, and nothing that describes the calls.

        Under Documentation rather than beside Options: it is reference material
        for a reader, not a setting to change.
      */}
      <a
        className="admin-nav-item"
        href="/api/v1/docs"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="API reference (opens in a new tab)"
      >
        <NavIcon name="Braces" />
        API reference
        <Icons.ExternalLink size={13} aria-hidden="true" style={{ flexShrink: 0 }} />
      </a>

      {/*
        The page itself, as the public sees it.

        Beside the guide because it is the same kind of link — it leaves the
        admin — and because the two questions arrive together: "how does this
        work" and "what does it actually look like right now". Everything above
        edits the page; nothing above shows it.

        A new tab for the same reason as the guide, and a stronger one: checking
        the public page is something you do *while* editing it, and taking the
        editor away to do it would lose the change being made.
      */}
      <a
        className="admin-nav-item"
        href={`/s/${slug}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Public page (opens in a new tab)"
      >
        <NavIcon name="Globe" />
        Public page
        <Icons.ExternalLink size={13} aria-hidden="true" style={{ flexShrink: 0 }} />
      </a>

      {/*
        Reporting a bug or asking for something, from where it was noticed.

        The version and the build are filled in already. They are the first
        thing anyone is asked for and the last thing anyone has to hand — the
        rail prints them at its foot precisely because of that, and a report
        that arrives without them costs a round trip before it can be read.

        A prefilled body rather than `/issues/new/choose`: the chooser drops
        everything passed to it, so picking a template would mean losing the one
        piece of information this link exists to carry.
      */}
      <a
        className="admin-nav-item"
        href={issueUrl()}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Report a bug or request a feature on GitHub (opens in a new tab)"
      >
        <NavIcon name="Bug" />
        Report an issue
        <Icons.ExternalLink size={13} aria-hidden="true" style={{ flexShrink: 0 }} />
      </a>
    </nav>
  )
}

/**
 * A new GitHub issue, with what the maintainer will ask for anyway.
 *
 * Nothing about the tenant, the instance address or the signed-in person goes
 * in: this opens a form on a public tracker, and a link that quietly carried a
 * customer's name into a draft issue would be a leak the first time somebody
 * pressed submit without reading.
 */
function issueUrl(): string {
  const body = [
    '### What happened',
    '',
    '',
    '### What you expected',
    '',
    '',
    '### Steps to reproduce',
    '',
    '',
    '---',
    `TERN v${__TERN_VERSION__} · build ${__TERN_BUILD__}`,
  ].join('\n')

  return `${REPO_URL}/issues/new?body=${encodeURIComponent(body)}`
}

// ── Controls ────────────────────────────────────────────────────────────────

function ControlsScreen({
  slug,
  canWrite,
  onOpenLogs,
}: {
  slug: string
  canWrite: boolean
  onOpenLogs: (controlId: string) => void
}) {
  const queryClient = useQueryClient()
  const controls = useQuery({
    queryKey: ['controls', slug],
    queryFn: () => adminApi.controls(slug),
  })
  /*
   * The folders, on a key of their own.
   *
   * A separate request rather than a field on each control, because the screen
   * has to draw a folder nothing is filed in yet — the empty one somebody made
   * a minute ago is exactly the one they are about to fill, and deriving the
   * list from the controls would make it invisible until it was no longer
   * needed.
   *
   * Both keys are invalidated together after anything that files something: a
   * move changes a control's `groupId` and a folder's count in the same act.
   */
  const groups = useQuery({
    queryKey: ['control-groups', slug],
    queryFn: () => adminApi.controlGroups(slug),
  })

  const [editing, setEditing] = useState<Control | 'new' | null>(null)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [addingFolder, setAddingFolder] = useState(false)
  const [importing, setImporting] = useState(false)
  /* What the last import did, said once on the way back. The screen it happened
     on is gone by then, and a count of forty controls appearing in silence is
     indistinguishable from nothing having happened. */
  const [importNotice, setImportNotice] = useState<string | null>(null)
  const [bulkError, setBulkError] = useState<string | null>(null)

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['controls', slug] })
    await queryClient.invalidateQueries({ queryKey: ['control-groups', slug] })
  }

  /*
   * Leaving the list drops the import's report.
   *
   * It is a confirmation of something that has just happened, and a
   * confirmation still sitting there after a trip through the editor is a claim
   * about the wrong moment.
   */
  const openEditor = (control: Control | 'new') => {
    setImportNotice(null)
    setEditing(control)
  }

  const openImport = () => {
    setImportNotice(null)
    setImporting(true)
  }

  const move = useMutation({
    mutationFn: ({ ids, groupId }: { ids: string[]; groupId: string | null }) =>
      adminApi.moveControls(slug, ids, groupId),
    onSuccess: async () => {
      setBulkError(null)
      // The selection is spent: the controls it named have gone somewhere else,
      // and leaving the boxes ticked invites the next click to move them again.
      setPicked(new Set())
      await invalidate()
    },
    onError: (err) => setBulkError(err instanceof ApiError ? err.message : String(err)),
  })

  const removeMany = useMutation({
    /*
     * One request per control, because there is no bulk delete — and every one
     * of them is attempted.
     *
     * `allSettled` rather than `all`: a refusal on the third of ten must not
     * cancel the other seven, and the reader is owed the count that did go
     * rather than a bare failure over a list they can no longer trust. What
     * comes back is what actually happened.
     */
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => adminApi.deleteControl(slug, id)))
      const refused = results.filter((result) => result.status === 'rejected')
      if (refused.length === 0) return
      const first = refused[0]!.reason
      throw new Error(
        `${ids.length - refused.length} of ${ids.length} deleted. ${
          first instanceof Error ? first.message : String(first)
        }`,
      )
    },
    onSuccess: async () => {
      setBulkError(null)
      setPicked(new Set())
      await invalidate()
    },
    onError: (err) => setBulkError(err.message),
  })

  const togglePicked = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  if (controls.isPending) return <Centered>Loading controls…</Centered>
  if (controls.isError) return <Banner tone="down">Could not load controls.</Banner>

  if (importing) {
    return (
      <ImportScreen
        slug={slug}
        onCancel={() => setImporting(false)}
        onImported={async (outcome) => {
          setImporting(false)
          setImportNotice(
            `Imported ${outcome.created} new and ${outcome.updated} updated control${
              outcome.created + outcome.updated === 1 ? '' : 's'
            }` +
              (outcome.groupsCreated === 0
                ? '.'
                : `, in ${outcome.groupsCreated} new folder${outcome.groupsCreated === 1 ? '' : 's'}.`),
          )
          // Both keys: the import creates folders as well as controls.
          await invalidate()
        }}
      />
    )
  }

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

  const all = controls.data
  // An unreachable folder list leaves a flat screen, not a broken one: the
  // controls are the thing being watched, and they are all here either way.
  const folders = groups.data ?? []
  const matches = matching(all, query)
  const searching = query.trim() !== ''

  const byParent = childrenByParent(folders)
  const byGroup = controlsByFolder(matches, new Set(folders.map((folder) => folder.id)))
  const flat = flattenFolders(byParent)
  const unfiled = byGroup.get(null) ?? []

  // Ticked ids are read back through the current list rather than sent as they
  // were stored: a control deleted in another tab would otherwise still be
  // named in the next bulk request, which answers 404 for the whole selection.
  const pickedIds = all.filter((control) => picked.has(control.id)).map((control) => control.id)

  const context: FolderContext = {
    slug,
    canWrite,
    byParent,
    byGroup,
    flat,
    picked,
    onPick: togglePicked,
    onEdit: openEditor,
    onOpenLogs,
    onChanged: invalidate,
  }

  const cards = (list: Control[]) => (
    /*
     * A grid rather than a stack. Twenty controls in a single column on a
     * 1440px display is one line of text per screen-inch and two empty thirds;
     * a card can carry what a row could not — the widget, the probe kind,
     * whether it is public — without any of them becoming a column that has to
     * be maintained.
     */
    <div className="card-grid">
      {list.map((control) => (
        <ControlCard
          key={control.id}
          control={control}
          slug={slug}
          canWrite={canWrite}
          picked={picked.has(control.id)}
          onPick={() => togglePicked(control.id)}
          onEdit={() => openEditor(control)}
          onOpenLogs={onOpenLogs}
        />
      ))}
    </div>
  )

  return (
    <section style={{ paddingTop: 'var(--space-6)', display: 'grid', gap: 'var(--space-4)' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 'var(--text-xl)' }}>Controls</h1>
          {/* The count is only worth showing once it differs from the whole. */}
          {searching && (
            <p
              className="tabular"
              style={{
                margin: 'var(--space-1) 0 0',
                fontSize: 'var(--text-sm)',
                color: 'var(--color-fg-subtle)',
              }}
            >
              {matches.length} of {all.length}
            </p>
          )}
        </div>
        {canWrite && (
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            {/* Beside "New control" rather than inside the tree: a first folder
                has no folder to be created from, and putting the act only on an
                existing one would leave an empty page with no way to start. */}
            <Button onClick={() => setAddingFolder((open) => !open)}>
              {addingFolder ? 'Cancel' : 'New folder'}
            </Button>
            {/* Beside the singular act rather than hidden in Options: the moment
                somebody wants forty controls is the moment they are looking at
                the button that makes one. */}
            <Button onClick={openImport}>Import YAML</Button>
            <Button variant="primary" onClick={() => openEditor('new')}>
              New control
            </Button>
          </div>
        )}
      </div>

      {importNotice && <Banner tone="operational">{importNotice}</Banner>}

      {canWrite && addingFolder && (
        <FolderForm
          slug={slug}
          folder={null}
          choices={flat}
          onDone={async () => {
            setAddingFolder(false)
            await invalidate()
          }}
          onCancel={() => setAddingFolder(false)}
        />
      )}

      {/* Filtering happens in the browser: the whole list is already loaded, so
          a round trip per keystroke would add latency to answer a question the
          page can answer instantly. It stops being right somewhere past a few
          hundred controls, which is where a server-side search earns its
          complexity. */}
      {all.length > 0 && (
        <div style={{ maxWidth: '30rem' }}>
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

      {canWrite && pickedIds.length > 0 && (
        <BulkBar
          ids={pickedIds}
          choices={flat}
          error={bulkError}
          moving={move.isPending}
          deleting={removeMany.isPending}
          onMove={(groupId) => move.mutate({ ids: pickedIds, groupId })}
          onDelete={() => removeMany.mutate(pickedIds)}
          onClear={() => {
            setPicked(new Set())
            setBulkError(null)
          }}
        />
      )}

      {all.length === 0 && folders.length === 0 ? (
        <EmptyState
          title="No controls yet"
          hint="A control is one thing you monitor. Create one and TERN will hand you a script that pushes to it."
          action={
            canWrite ? (
              /* The import is offered hardest here. An empty page is where a
                 list somebody already has is worth the most, and it is the one
                 screen where nothing else competes for the eye. */
              <div
                style={{
                  display: 'flex',
                  gap: 'var(--space-2)',
                  justifyContent: 'center',
                  flexWrap: 'wrap',
                }}
              >
                <Button variant="primary" onClick={() => openEditor('new')}>
                  Create the first control
                </Button>
                <Button onClick={openImport}>Import from YAML</Button>
              </div>
            ) : undefined
          }
        />
      ) : searching ? (
        /*
         * A search flattens the tree.
         *
         * "Where is the cache control" is answered by the control, not by the
         * shape of the filing around it — and drawing thirty folders, most of
         * them empty of matches, around two cards answers a question nobody
         * asked. The folders come back the moment the box is cleared.
         */
        matches.length === 0 ? (
          /* Distinct from "no controls yet": one is a state to fix, the other is
             a search to change, and the same words for both would be wrong. */
          <EmptyState
            title={`Nothing matches “${query}”`}
            hint="Names, keys and descriptions are searched."
            action={<Button onClick={() => setQuery('')}>Clear the search</Button>}
          />
        ) : (
          cards(matches)
        )
      ) : (
        <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
          {/*
            What is filed nowhere comes first, and only wears a heading once
            there is something to distinguish it from.

            Folders are additive: a page that has never made one should look
            exactly as it did, and a page that has just made its first should
            not find its whole estate pushed below an empty folder.
          */}
          {unfiled.length > 0 && (
            <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
              {folders.length > 0 && (
                <h2
                  style={{
                    margin: 0,
                    fontSize: 'var(--text-sm)',
                    color: 'var(--color-fg-subtle)',
                  }}
                >
                  Unfiled
                </h2>
              )}
              {cards(unfiled)}
            </div>
          )}

          {(byParent.get(null) ?? []).map((folder) => (
            <FolderSection key={folder.id} folder={folder} ctx={context} />
          ))}
        </div>
      )}
    </section>
  )
}

// ── Folders ─────────────────────────────────────────────────────────────────

/**
 * What every node of the tree needs, passed once rather than eight times.
 *
 * The tree is drawn by a component that renders itself, so each level would
 * otherwise re-declare and forward the same eight props. Bundling them says
 * plainly that none of it belongs to a particular folder.
 */
interface FolderContext {
  slug: string
  canWrite: boolean
  byParent: Map<string | null, ControlGroup[]>
  byGroup: Map<string | null, Control[]>
  /** Every folder, depth-first, for the destination pickers. */
  flat: { folder: ControlGroup; depth: number }[]
  picked: Set<string>
  onPick: (id: string) => void
  onEdit: (control: Control) => void
  onOpenLogs: (controlId: string) => void
  onChanged: () => Promise<void>
}

/**
 * The folders, arranged as the tree their `parentId` describes.
 *
 * Keyed by parent so drawing a level is a lookup rather than a scan of the
 * whole list at every node. A folder whose parent is not in the list is treated
 * as a root rather than dropped: this list and the controls' are two separate
 * requests, and a folder that has just been moved must not disappear for the
 * length of a refetch. The API refuses cycles, which is what lets this recurse
 * without a visited set.
 */
function childrenByParent(folders: ControlGroup[]): Map<string | null, ControlGroup[]> {
  const known = new Set(folders.map((folder) => folder.id))
  const byParent = new Map<string | null, ControlGroup[]>()

  for (const folder of folders) {
    const parent = folder.parentId !== null && known.has(folder.parentId) ? folder.parentId : null
    const bucket = byParent.get(parent)
    if (bucket) bucket.push(folder)
    else byParent.set(parent, [folder])
  }

  // `position` is the order somebody chose; the name settles the ties it leaves,
  // so two folders never swap places between one render and the next.
  for (const bucket of byParent.values()) {
    bucket.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
  }

  return byParent
}

/** Every folder, depth-first, with how deep it sits — for the destination pickers. */
function flattenFolders(
  byParent: Map<string | null, ControlGroup[]>,
  parentId: string | null = null,
  depth = 0,
): { folder: ControlGroup; depth: number }[] {
  return (byParent.get(parentId) ?? []).flatMap((folder) => [
    { folder, depth },
    ...flattenFolders(byParent, folder.id, depth + 1),
  ])
}

/**
 * Where a folder may be moved: anywhere but into itself or its own subtree.
 *
 * The API refuses that move with a sentence of its own, so this is not the
 * guard — it is the reason the reader never has to read the guard. An option
 * that can only ever be refused is a worse way to learn a rule than never being
 * offered it.
 */
function offerableParents(
  ctx: FolderContext,
  folder: ControlGroup,
): { folder: ControlGroup; depth: number }[] {
  const inside = new Set([folder.id])
  const walk = (parentId: string) => {
    for (const child of ctx.byParent.get(parentId) ?? []) {
      inside.add(child.id)
      walk(child.id)
    }
  }
  walk(folder.id)

  return ctx.flat.filter((choice) => !inside.has(choice.folder.id))
}

/** The controls of each folder, with everything unfiled under `null`. */
function controlsByFolder(controls: Control[], known: Set<string>): Map<string | null, Control[]> {
  const byGroup = new Map<string | null, Control[]>()

  for (const control of controls) {
    // A `groupId` naming a folder this list does not have goes to the top level
    // rather than nowhere. The two queries can land a moment apart, and a
    // control that is briefly drawn in no section at all is a control somebody
    // will believe they deleted.
    const key = control.groupId !== null && known.has(control.groupId) ? control.groupId : null
    const bucket = byGroup.get(key)
    if (bucket) bucket.push(control)
    else byGroup.set(key, [control])
  }

  return byGroup
}

/** How a folder is offered in a picker: its name, indented by how deep it sits. */
function folderOption(folder: ControlGroup, depth: number): string {
  return `${'— '.repeat(depth)}${folder.name}`
}

/**
 * One folder: its heading, what is filed in it, and the folders under it.
 *
 * It renders itself for its children rather than a flat list rendering an
 * indent class, so nesting is nesting — the panel of a collapsed folder takes
 * its whole subtree with it, which is the only reading of "collapse" that is
 * not a surprise.
 */
function FolderSection({ folder, ctx }: { folder: ControlGroup; ctx: FolderContext }) {
  // The tenant's own default decides the first state, and the reader's click
  // decides every one after: a stored preference is a starting point, not a
  // ruling on the session.
  const [open, setOpen] = useState(!folder.collapsedByDefault)
  const [renaming, setRenaming] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = useMutation({
    mutationFn: (controls: 'unfile' | 'delete') =>
      adminApi.deleteControlGroup(ctx.slug, folder.id, controls),
    onSuccess: async () => {
      setConfirming(false)
      setError(null)
      await ctx.onChanged()
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  })

  const own = ctx.byGroup.get(folder.id) ?? []
  const children = ctx.byParent.get(folder.id) ?? []
  const panelId = `folder-panel-${folder.id}`

  return (
    <section style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
        }}
      >
        {/* The name is inside the button, so the disclosure needs no label of
            its own and the whole heading is the target — a chevron alone is a
            20px hit area for the one act this row is mostly used for. */}
        <button
          type="button"
          onClick={() => setOpen((shown) => !shown)}
          aria-expanded={open}
          aria-controls={panelId}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            minHeight: 36,
            padding: 0,
            border: 0,
            background: 'none',
            color: 'var(--color-fg)',
            fontFamily: 'inherit',
            fontSize: 'var(--text-base)',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <Icons.ChevronRight
            size={15}
            aria-hidden="true"
            style={{
              flexShrink: 0,
              transform: open ? 'rotate(90deg)' : undefined,
              transition: 'transform var(--duration-fast) var(--ease-out)',
            }}
          />
          {open ? (
            <Icons.FolderOpen size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
          ) : (
            <Icons.Folder size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
          )}
          {folder.name}
        </button>

        {/* Said even when it is nothing: an empty folder that looks like a
            collapsed one is how a reader concludes their controls are lost. */}
        <span
          className="tabular"
          style={{ fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}
        >
          {own.length === 0 ? 'empty' : `${own.length} control${own.length === 1 ? '' : 's'}`}
          {children.length > 0 && ` · ${children.length} folder${children.length === 1 ? '' : 's'}`}
        </span>

        {ctx.canWrite && (
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--space-2)' }}>
            <Button
              ariaLabel={renaming ? `Stop editing ${folder.name}` : `Rename ${folder.name}`}
              onClick={() => setRenaming((shown) => !shown)}
            >
              {renaming ? 'Cancel' : 'Rename'}
            </Button>
            <Button
              variant="danger"
              ariaLabel={`Delete ${folder.name}`}
              onClick={() => setConfirming(true)}
            >
              Delete
            </Button>
          </span>
        )}
      </div>

      {ctx.canWrite && renaming && (
        <FolderForm
          slug={ctx.slug}
          folder={folder}
          // Its own subtree is not on offer: the API refuses that move with a
          // sentence, but an option that can only ever be refused is a worse
          // way to learn the rule than never seeing it.
          choices={offerableParents(ctx, folder)}
          onDone={async () => {
            setRenaming(false)
            await ctx.onChanged()
          }}
          onCancel={() => setRenaming(false)}
        />
      )}

      {error && <Banner tone="down">{error}</Banner>}

      {confirming && (
        <div>
          <Banner tone="down">
            {/* What survives, said before the button that removes the folder.
                Filing is not monitoring, and somebody tidying their page must
                not discover the next morning that six services went quiet. */}
            Delete “{folder.name}”? The folder goes and nothing in it does — its{' '}
            {children.length > 0 ? 'folders move up a level and its ' : ''}controls are unfiled,
            still monitored, still on the page.
            {/*
              The other intention, offered rather than left to be done by hand.
              A service being dismantled takes its checks with it, and the way
              to do that until now was to delete N controls one at a time and
              then the folder — which is the same act, performed without a
              transaction and with a chance to stop half way.

              Two buttons rather than a checkbox on one: they destroy different
              amounts, and a tickbox that silently upgrades "delete the folder"
              into "delete six controls" is the click nobody remembers making.
            */}
            {own.length > 0 && (
              <>
                {' '}
                Unless you are taking the service down with it — the second button does that, and
                their history goes with them.
              </>
            )}
          </Banner>
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-2)',
              marginTop: 'var(--space-2)',
              flexWrap: 'wrap',
            }}
          >
            <Button
              variant="danger"
              busy={remove.isPending && remove.variables === 'unfile'}
              disabled={remove.isPending}
              onClick={() => remove.mutate('unfile')}
            >
              {own.length > 0 ? 'Delete the folder, keep the controls' : 'Delete the folder'}
            </Button>
            {own.length > 0 && (
              <Button
                variant="danger"
                busy={remove.isPending && remove.variables === 'delete'}
                disabled={remove.isPending}
                onClick={() => remove.mutate('delete')}
              >
                Delete it and its {own.length} control{own.length === 1 ? '' : 's'}
              </Button>
            )}
            <Button onClick={() => setConfirming(false)} disabled={remove.isPending}>
              Keep it
            </Button>
          </div>
        </div>
      )}

      {/*
        Kept mounted and hidden rather than unmounted, so `aria-controls` above
        always names something real. `display` is set here rather than left to
        the `hidden` attribute, because an inline `display` would win over it.
      */}
      <div
        id={panelId}
        hidden={!open}
        style={{
          display: open ? 'grid' : 'none',
          gap: 'var(--space-4)',
          // The rule is the tree: it says what is inside this folder without
          // spending a column of width on an indent guide per level.
          marginLeft: 'var(--space-2)',
          paddingLeft: 'var(--space-4)',
          borderLeft: '1px solid var(--color-border)',
        }}
      >
        {own.length > 0 ? (
          <div className="card-grid">
            {own.map((control) => (
              <ControlCard
                key={control.id}
                control={control}
                slug={ctx.slug}
                canWrite={ctx.canWrite}
                picked={ctx.picked.has(control.id)}
                onPick={() => ctx.onPick(control.id)}
                onEdit={() => ctx.onEdit(control)}
                onOpenLogs={ctx.onOpenLogs}
              />
            ))}
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)' }}>
            {ctx.canWrite
              ? 'Nothing filed here yet. Tick some controls and use “Move to a folder”.'
              : 'Nothing filed here yet.'}
          </p>
        )}

        {children.map((child) => (
          <FolderSection key={child.id} folder={child} ctx={ctx} />
        ))}
      </div>
    </section>
  )
}

/**
 * Making a folder, and changing one — the same two questions either way.
 *
 * A name and a place. The rest of what a folder carries (its rollup, its
 * default collapse, its position) is left at what the API chooses, because
 * every one of them is a preference somebody discovers they want *after* they
 * have somewhere to put things, and asking all five up front turns "make a
 * folder" into a form.
 */
function FolderForm({
  slug,
  folder,
  choices,
  onDone,
  onCancel,
}: {
  slug: string
  /** The folder being changed, or null to make one. */
  folder: ControlGroup | null
  choices: { folder: ControlGroup; depth: number }[]
  onDone: () => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState(folder?.name ?? '')
  // '' is the top level. A folder id is a uuid, so the two can never collide.
  const [parent, setParent] = useState(folder?.parentId ?? '')
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), parentId: parent === '' ? null : parent }
      return folder
        ? adminApi.updateControlGroup(slug, folder.id, body)
        : adminApi.createControlGroup(slug, body)
    },
    onSuccess: async () => {
      setError(null)
      await onDone()
    },
    // The API's sentence names the rule — a sixth level, or a move into its own
    // subtree — where a generic failure would leave the reader guessing which.
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  })

  return (
    <Card>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate()
        }}
        style={{ display: 'grid', gap: 'var(--space-3)' }}
      >
        {error && <Banner tone="down">{error}</Banner>}

        <div className="field-row is-lead-first">
          <Field label="Folder name" hint="What this part of the page is called.">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Europe"
              autoFocus
            />
          </Field>
          <Field label="Inside" hint="Folders nest five deep at most.">
            <Select value={parent} onChange={(event) => setParent(event.target.value)}>
              <option value="">Top level</option>
              {choices.map((choice) => (
                <option key={choice.folder.id} value={choice.folder.id}>
                  {folderOption(choice.folder, choice.depth)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="form-actions">
          <Button onClick={onCancel}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            busy={save.isPending}
            disabled={name.trim() === ''}
          >
            {folder ? 'Save the folder' : 'Create the folder'}
          </Button>
        </div>
      </form>
    </Card>
  )
}

/**
 * What to do with a selection, where the selection can be seen.
 *
 * A bar rather than a menu on each row: the whole point of ticking several is
 * to act on them once. It sticks to the top of the scroll because the tree it
 * sits above can be several screens tall — a selection made at the bottom of it
 * would otherwise be acted on from a bar the reader has to scroll back to find,
 * and a scroll away from what you have just chosen is how the wrong things get
 * deleted.
 */
function BulkBar({
  ids,
  choices,
  error,
  moving,
  deleting,
  onMove,
  onDelete,
  onClear,
}: {
  ids: string[]
  choices: { folder: ControlGroup; depth: number }[]
  error: string | null
  moving: boolean
  deleting: boolean
  onMove: (groupId: string | null) => void
  onDelete: () => void
  onClear: () => void
}) {
  const [destination, setDestination] = useState('')
  const [confirming, setConfirming] = useState(false)

  return (
    <div style={{ position: 'sticky', top: 'var(--space-2)', zIndex: 2 }}>
      <Card>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 'var(--space-3)',
            flexWrap: 'wrap',
          }}
        >
          <strong style={{ minHeight: 44, display: 'flex', alignItems: 'center' }}>
            {ids.length} selected
          </strong>

          <div style={{ minWidth: '14rem', flex: 1 }}>
            <Field label="Move to a folder" hint="One request, whatever the count.">
              <Select value={destination} onChange={(event) => setDestination(event.target.value)}>
                <option value="">Top level (unfiled)</option>
                {choices.map((choice) => (
                  <option key={choice.folder.id} value={choice.folder.id}>
                    {folderOption(choice.folder, choice.depth)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Button busy={moving} onClick={() => onMove(destination === '' ? null : destination)}>
              Move
            </Button>
            <Button variant="danger" onClick={() => setConfirming(true)}>
              Delete
            </Button>
            <Button onClick={onClear}>Clear</Button>
          </div>
        </div>

        {error && (
          <div style={{ marginTop: 'var(--space-3)' }}>
            <Banner tone="down">{error}</Banner>
          </div>
        )}

        {confirming && (
          <div style={{ marginTop: 'var(--space-3)' }}>
            <Banner tone="down">
              {/* The number is the whole confirmation: "delete the selected
                  controls" is agreed to without reading, and the difference
                  between two and twenty is the difference this is here for. */}
              Delete {ids.length} control{ids.length === 1 ? '' : 's'}? Their history goes with
              them, and anything still pushing to them will start being refused. This cannot be
              undone.
            </Banner>
            <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
              <Button
                variant="danger"
                busy={deleting}
                onClick={() => {
                  setConfirming(false)
                  onDelete()
                }}
              >
                Delete {ids.length === 1 ? 'it' : 'them'}
              </Button>
              <Button onClick={() => setConfirming(false)}>Keep them</Button>
            </div>
          </div>
        )}
      </Card>
    </div>
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

/**
 * A link wearing the secondary button's clothes.
 *
 * It has to be an anchor rather than a `Button`: it goes somewhere, and
 * somewhere you may well want in a second tab while keeping the list you are
 * working through. A `<button>` cannot be middle-clicked, opened in a new tab
 * or copied as an address — the same reasoning as the rail's entries, which are
 * anchors with a click handler for exactly this.
 */
const LINK_BUTTON: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
  background: 'transparent',
  color: 'var(--color-fg)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 'var(--radius-sm)',
  padding: '0 var(--space-4)',
  fontSize: 'var(--text-sm)',
  fontWeight: 600,
  textDecoration: 'none',
}

function ControlCard({
  control,
  canWrite,
  onEdit,
  slug,
  picked,
  onPick,
  onOpenLogs,
}: {
  control: Control
  canWrite: boolean
  onEdit: () => void
  slug: string
  picked: boolean
  onPick: () => void
  onOpenLogs: (controlId: string) => void
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

  /*
   * Stopping and starting a control, from the list.
   *
   * It used to mean opening the editor, walking a four-step wizard and saving
   * the whole definition back — which is a great deal of ceremony, and a great
   * deal of surface to change by accident, for a boolean somebody flips while
   * a deployment is in flight. Pausing one control is the most time-pressed act
   * on this screen and it had the longest path to it.
   *
   * Not optimistic: what is being asserted is that the scheduler has stopped,
   * and a card that says so a beat before the server agrees would be saying the
   * one thing this button exists to be trusted about.
   */
  const setEnabled = useMutation({
    mutationFn: () => adminApi.updateControl(slug, control.id, { enabled: !control.enabled }),
    onSuccess: async () => {
      setRefused(null)
      await queryClient.invalidateQueries({ queryKey: ['controls', slug] })
    },
    onError: (err) => setRefused(err instanceof ApiError ? err.message : String(err)),
  })

  return (
    /*
     * A disabled control is drawn differently, not merely tagged.
     *
     * The tag says it in a word, which is what a screen reader and a monochrome
     * print get; the dashed edge says it at a glance across a grid of twenty,
     * which is the reading the tag alone was losing. Neither is a colour, and
     * neither dims the text — a card nobody can read is not a clearer way of
     * saying a control is paused.
     */
    <Card
      style={
        control.enabled
          ? undefined
          : { borderStyle: 'dashed', borderColor: 'var(--color-border-strong)' }
      }
    >
      <div
        style={{
          display: 'grid',
          gap: 'var(--space-2)',
          height: '100%',
        }}
      >
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
          {/* Named, not numbered: "Select" on twenty cards is twenty identical
              announcements, and the row a checkbox belongs to is exactly what a
              reader who cannot see the grid has no other way of knowing. */}
          {canWrite && (
            <input
              type="checkbox"
              checked={picked}
              aria-label={`Select ${control.name}`}
              onChange={onPick}
              style={{ width: 20, height: 20, flexShrink: 0 }}
            />
          )}
          <strong style={{ flex: 1, minWidth: 0 }}>{control.name}</strong>
          {/* State as a word, never as a colour alone — and only when it is not
              the default, so the eye lands on the exceptions. */}
          {!control.isPublic && <Tag>internal</Tag>}
          {!control.enabled && <Tag tone="down">disabled</Tag>}
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

        {/*
          The acts, at the foot rather than beside the name.

          There are four of them now, and a row that carried them next to the
          title left the title itself about eight characters wide on a card in a
          three-up grid. They are also the last thing read, after the name, the
          specs and the three timestamps — which is the order they are used in.

          `stretch` so the anchor and the buttons share a height: they are one
          row of controls and a link that sits two pixels short reads as a
          different kind of thing.
        */}
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-2)',
            flexWrap: 'wrap',
            alignItems: 'stretch',
          }}
        >
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

          {/* The word says the state and `aria-pressed` says it again, because
              the two audiences read different halves of a button. The name is
              in the label too — pressing "Disabled" on the wrong card is the
              mistake this screen makes easiest. */}
          {canWrite && (
            <Button
              ariaLabel={`${control.enabled ? 'Enabled' : 'Disabled'} — ${control.name}`}
              ariaPressed={control.enabled}
              busy={setEnabled.isPending}
              onClick={() => setEnabled.mutate()}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                {control.enabled ? (
                  <Icons.Pause size={14} aria-hidden="true" />
                ) : (
                  <Icons.Play size={14} aria-hidden="true" />
                )}
                {control.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </Button>
          )}

          {/*
            What has been done to this control, rather than what it measured.

            The trail records the control's id in `target`, and the search box
            over there matches that column — so the address is the whole
            mechanism, and it is a real one: reloadable, bookmarkable, and worth
            pasting into a ticket.
          */}
          <a
            href={`/app/${slug}/logs?q=${encodeURIComponent(control.id)}`}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey) return
              event.preventDefault()
              onOpenLogs(control.id)
            }}
            aria-label={`Audit trail for ${control.name}`}
            style={LINK_BUTTON}
          >
            <Icons.ScrollText size={14} aria-hidden="true" />
            Logs
          </a>

          {canWrite && (
            <Button ariaLabel={`Edit ${control.name}`} onClick={onEdit}>
              Edit
            </Button>
          )}
        </div>
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
  {
    id: 'websocket',
    label: 'WebSocket',
    hint: 'Open the handshake to a ws:// or wss:// endpoint.',
  },
  {
    id: 'docker',
    label: 'Docker container',
    hint: 'A container on an agent’s host. Needs an agent with the Docker socket.',
  },
  {
    id: 'file',
    label: 'File present or absent',
    hint: 'Whether a path exists on an agent’s machine, and how big and how old it is.',
  },
  {
    id: 'directory',
    label: 'Directory activity',
    hint: 'Whether a directory on an agent’s machine is still being written to.',
  },
  {
    id: 'uptime',
    label: 'Uptime / restart',
    hint: 'How long an agent’s machine, or one process on it, has been up. Linux only.',
  },
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
  path: string
  mustExist: boolean
  contains: string
  maxQuietSeconds: number
  uptimeOf: string
  processName: string
  minSeconds: number
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
    case 'websocket':
      return { url: form.url.trim() }
    case 'docker':
      return { container: form.host.trim() }
    case 'file':
      return { path: form.path.trim(), mustExist: form.mustExist }
    case 'directory':
      /*
       * The two optional fields are omitted when empty rather than sent as
       * empty or zero. `contains` is `min(1)` and `maxQuietSeconds` is
       * `positive()`, so either would be rejected by the API for a shape the
       * operator never chose — "no filter" and "filter on nothing" are not the
       * same request.
       */
      return {
        path: form.path.trim(),
        ...(form.contains.trim() ? { contains: form.contains.trim() } : {}),
        ...(form.maxQuietSeconds > 0 ? { maxQuietSeconds: form.maxQuietSeconds } : {}),
      }
    case 'uptime':
      return {
        of: form.uptimeOf,
        ...(form.uptimeOf === 'process' && form.processName.trim()
          ? { process: form.processName.trim() }
          : {}),
        ...(form.minSeconds > 0 ? { minSeconds: form.minSeconds } : {}),
      }
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

  // The same key the fleet screen uses, so this costs no extra request when
  // both are visited — React Query serves one from the other's cache.
  const agents = useQuery({ queryKey: ['agents', slug], queryFn: () => adminApi.agents(slug) })
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
    // The host targets. `path` is shared by `file` and `directory` — they ask
    // about the same thing and never appear together.
    path: typeof probe.path === 'string' ? probe.path : '',
    mustExist: typeof probe.mustExist === 'boolean' ? probe.mustExist : true,
    contains: typeof probe.contains === 'string' ? probe.contains : '',
    // Zero is the form's way of saying "not set", which is why the schema makes
    // both of these `positive()`: there is no meaningful zero to collide with.
    maxQuietSeconds: typeof probe.maxQuietSeconds === 'number' ? probe.maxQuietSeconds : 0,
    uptimeOf: typeof probe.of === 'string' ? probe.of : 'machine',
    processName: typeof probe.process === 'string' ? probe.process : '',
    minSeconds: typeof probe.minSeconds === 'number' ? probe.minSeconds : 0,
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

            {form.kind === 'websocket' && (
              <Field
                label="URL"
                hint="ws:// or wss://. The handshake is measured; no frames are sent."
              >
                <Input
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  placeholder="wss://example.com/socket"
                />
              </Field>
            )}

            {/* Reuses `host` as the container field rather than adding a state
                key: the form is one flat object, and a `container` that only
                ever holds what `host` would has no reason to exist. */}
            {form.kind === 'docker' && (
              <Field
                label="Container"
                hint="Name or ID, as docker ps prints it. Runs on the agent's host — the server cannot run this kind."
              >
                <Input
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                  placeholder="api"
                />
              </Field>
            )}

            {/*
              The three targets that observe the machine rather than the
              network. Each says so in its hint, because the failure they
              otherwise produce is silent in the worst way: a control saved
              against the server, assigned to nothing, reporting an error about
              a path the operator will read as a typo.
            */}
            {form.kind === 'file' && (
              <div className="field-row is-lead-first">
                <Field
                  label="Path"
                  hint="Absolute path on the agent's machine. The server cannot run this kind."
                >
                  <Input
                    value={form.path}
                    onChange={(e) => setForm({ ...form, path: e.target.value })}
                    placeholder="/var/run/exporter.pid"
                  />
                </Field>
                <Field label="Healthy when">
                  <select
                    value={form.mustExist ? 'present' : 'absent'}
                    onChange={(e) => setForm({ ...form, mustExist: e.target.value === 'present' })}
                    style={SELECT_STYLE}
                  >
                    <option value="present">It is there</option>
                    <option value="absent">It is gone</option>
                  </select>
                </Field>
              </div>
            )}

            {form.kind === 'directory' && (
              <>
                <div className="field-row is-lead-first">
                  <Field
                    label="Directory"
                    hint="Absolute path on the agent's machine. One level, not a recursive walk."
                  >
                    <Input
                      value={form.path}
                      onChange={(e) => setForm({ ...form, path: e.target.value })}
                      placeholder="/var/backups"
                    />
                  </Field>
                  <Field label="Only names containing" hint="Optional.">
                    <Input
                      value={form.contains}
                      onChange={(e) => setForm({ ...form, contains: e.target.value })}
                      placeholder=".sql.gz"
                    />
                  </Field>
                </div>
                <Field
                  label="Fail after this many seconds with no change"
                  hint="Leave at 0 to only record the activity and let the checks below decide."
                >
                  <Input
                    type="number"
                    value={form.maxQuietSeconds}
                    onChange={(e) => setForm({ ...form, maxQuietSeconds: Number(e.target.value) })}
                  />
                </Field>
              </>
            )}

            {form.kind === 'uptime' && (
              <>
                <div className="field-row is-lead-first">
                  <Field label="Of" hint="Read from /proc, so this kind needs a Linux agent.">
                    <select
                      value={form.uptimeOf}
                      onChange={(e) => setForm({ ...form, uptimeOf: e.target.value })}
                      style={SELECT_STYLE}
                    >
                      <option value="machine">The machine</option>
                      <option value="process">One process</option>
                    </select>
                  </Field>
                  {form.uptimeOf === 'process' && (
                    <Field label="Process" hint="The command name, without arguments.">
                      <Input
                        value={form.processName}
                        onChange={(e) => setForm({ ...form, processName: e.target.value })}
                        placeholder="postgres"
                      />
                    </Field>
                  )}
                </div>
                <Field
                  label="Fail below this many seconds of uptime"
                  hint="Set it a little above the interval below, and a restart shows up as one failed check instead of disappearing between two green points."
                >
                  <Input
                    type="number"
                    value={form.minSeconds}
                    onChange={(e) => setForm({ ...form, minSeconds: Number(e.target.value) })}
                  />
                </Field>
              </>
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

            {/*
              What `localhost` means here, said before the check is saved.

              It reads as "this machine" to everyone who types it. To the agent
              that runs the check it means its own container, whose loopback
              holds nothing but the API — so the check fails with a refused
              connection against an address that looks obviously correct, which
              is the hardest kind of wrong to spot.

              Placed under the target fields rather than beside one, because the
              field it belongs to changes with the kind and the sentence does
              not.

              Only shown when it is true: with the agent measuring from the
              machine, `localhost` means what it appears to mean and there is
              nothing to warn about. A notice that fires when it does not apply
              is how people learn to skip the ones that do.
            */}
            {meansThisMachine(targetHost(form)) &&
              agents.data?.some((a) => a.isLocal && a.networkMode === 'service:app') && (
                <Banner tone="down">
                  <strong>This address will not mean this machine.</strong> The agent measures from
                  inside its container, where <code>localhost</code> is the container itself — so
                  this check will fail however right the address looks. Either give the service its
                  address on your network, or switch the agent to measure from the machine — Agents
                  → Agent-local-tern says how.
                </Banner>
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

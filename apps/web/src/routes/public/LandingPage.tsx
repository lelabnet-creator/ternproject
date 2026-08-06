import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { TernWordmark } from '../../components/brand/TernMark'
import { ThemePicker } from '../../components/ThemePicker'
import { forgetPage, recentPages, type RecentPage } from '../../lib/recentPages'
import { SponsorButton } from '../../components/SponsorButton'
import { SiteFooter } from '../../components/SiteFooter'
import { api } from '../../lib/api'

/**
 * What `/` shows.
 *
 * An instance serves one status page — nothing in the API creates a tenant, so
 * the only one that exists is the one provisioning made. So the root asks the
 * API which page that is and goes there: a visitor arriving at the domain has
 * been given the domain, not a slug, and asking them to type one is asking for
 * something they were never handed.
 *
 * The picker below is the fallback, for the two cases where the answer is not
 * unambiguous: a private page, which is never named because the public API
 * answers 404 for it by design, and a database that holds several public ones.
 * In both, a name typed here is navigated to without being checked first —
 * confirming existence would turn this field into an oracle.
 */
export function LandingPage() {
  const [slug, setSlug] = useState('')
  // `null` while the question is still open. Rendering the picker during that
  // moment would flash "which status page?" at someone who is about to be sent
  // to the only one there is.
  const [resolving, setResolving] = useState(true)
  // Read once, into state, because the list is editable from this screen and
  // has to redraw when an entry is dropped.
  const [recent, setRecent] = useState<RecentPage[]>(recentPages)
  const clean = slug
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '')

  useEffect(() => {
    let cancelled = false

    api
      .instance()
      .then((info) => {
        if (cancelled) return
        if (info.tenant) {
          // replace, not assign: Back from the status page should leave the
          // site rather than land here and bounce forward again.
          window.location.replace(`/s/${encodeURIComponent(info.tenant.slug)}`)
          return
        }
        setResolving(false)
      })
      // An unreachable API is not a reason to show nothing at all — the picker
      // still lets someone reach a page they already know the name of.
      .catch(() => {
        if (!cancelled) setResolving(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  // Blank rather than a spinner: this resolves in one request against an API
  // on the same origin, and a spinner that shows for 80ms is a flicker.
  if (resolving) return <main className="landing" aria-busy="true" />

  return (
    <main className="landing">
      {/* The photograph, not a drawn scene: a real tern over real water says
          what the product is called and where the name comes from. It carries
          no text, so nothing depends on which part of it a word lands over. */}
      <div className="landing-image" role="img" aria-label="A tern over the sea" />

      <div className="landing-panel">
        <div
          style={{
            width: '100%',
            maxWidth: '26rem',
            textAlign: 'center',
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-card)',
            padding: 'var(--space-6)',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              marginBottom: 'var(--space-5)',
            }}
          >
            <TernWordmark size={40} />
          </div>

          <h1
            style={{
              margin: '0 0 var(--space-2)',
              fontSize: 'var(--text-xl)',
              color: 'var(--color-fg)',
            }}
          >
            Which status page?
          </h1>
          <p
            style={{
              margin: '0 0 var(--space-5)',
              color: 'var(--color-fg-subtle)',
              fontSize: 'var(--text-sm)',
            }}
          >
            Every page lives at its own address. Enter the one you were given.
          </p>

          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (clean) window.location.assign(`/s/${encodeURIComponent(clean)}`)
            }}
            style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'stretch' }}
          >
            <label style={{ flex: 1, textAlign: 'left' }}>
              <span
                style={{
                  display: 'block',
                  fontSize: 'var(--text-sm)',
                  fontWeight: 600,
                  marginBottom: 'var(--space-1)',
                }}
              >
                Page name
              </span>
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  background: 'var(--color-surface)',
                  border: '1px solid var(--color-border-strong)',
                  borderRadius: 'var(--radius-sm)',
                  minHeight: 48,
                }}
              >
                <input
                  autoFocus
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="acme"
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    background: 'transparent',
                    border: 0,
                    outline: 'none',
                    color: 'var(--color-fg)',
                    // 16px, or iOS zooms the page on focus.
                    fontSize: 'var(--text-base)',
                    fontFamily: 'inherit',
                    padding: 'var(--space-2) var(--space-3)',
                    minHeight: 44,
                  }}
                />
              </span>
            </label>

            <button
              type="submit"
              disabled={!clean}
              style={{
                alignSelf: 'flex-end',
                minHeight: 48,
                padding: '0 var(--space-5)',
                borderRadius: 'var(--radius-sm)',
                border: 0,
                background: 'var(--color-accent)',
                color: 'var(--color-accent-fg)',
                fontFamily: 'inherit',
                fontSize: 'var(--text-sm)',
                fontWeight: 600,
                cursor: clean ? 'pointer' : 'not-allowed',
                opacity: clean ? 1 : 0.5,
              }}
            >
              Go
            </button>
          </form>

          {recent.length > 0 && (
            <Recent
              pages={recent}
              onForget={(forgotten) => {
                forgetPage(forgotten)
                setRecent((pages) => pages.filter((page) => page.slug !== forgotten))
              }}
            />
          )}

          {/* Under the picker rather than in a footer: this is the one place
              where someone has arrived at the product itself rather than at a
              customer's page, and the only place the ask is not an interruption
              of someone checking on an outage. */}
          <div
            style={{
              marginTop: 'var(--space-6)',
              paddingTop: 'var(--space-4)',
              borderTop: '1px solid var(--color-border)',
              display: 'grid',
              justifyItems: 'center',
              gap: 'var(--space-3)',
            }}
          >
            <p
              style={{
                margin: 0,
                fontSize: 'var(--text-xs)',
                color: 'var(--color-fg-subtle)',
                lineHeight: 1.6,
              }}
            >
              TERN is free and open source.
            </p>
            {/* The one place where somebody has arrived at the product itself, so
                the sentence above carries the name and the button need not. */}
            <SponsorButton label="Sponsor" />
          </div>

          {/* The theme picker is a control, not part of the sponsor ask sitting
              above it. It needs more air than the gap inside that block, or the
              two read as one group. */}
          <div
            style={{
              marginTop: 'var(--space-6)',
              display: 'flex',
              justifyContent: 'center',
              gap: 'var(--space-4)',
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <ThemePicker compact />
          </div>
        </div>

        <SiteFooter compact />
      </div>
    </main>
  )
}

/**
 * The pages this browser has already opened.
 *
 * Names, not slugs, because that is what someone recognises — the slug is the
 * address, and it is already visible in the link's target. Each entry can be
 * dropped: a shared machine, or a customer one no longer has, and a history
 * that cannot be edited is one people would rather not be given.
 */
function Recent({ pages, onForget }: { pages: RecentPage[]; onForget: (slug: string) => void }) {
  return (
    <div style={{ marginTop: 'var(--space-5)', textAlign: 'left' }}>
      <h2
        style={{
          margin: '0 0 var(--space-2)',
          fontSize: 'var(--text-xs)',
          fontWeight: 600,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: 'var(--color-fg-subtle)',
        }}
      >
        Pages you have opened
      </h2>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}>
        {pages.map((page) => (
          <li key={page.slug} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <a
              href={`/s/${encodeURIComponent(page.slug)}`}
              style={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                alignItems: 'baseline',
                gap: 'var(--space-2)',
                minHeight: 40,
                padding: 'var(--space-2) var(--space-3)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--color-fg)',
                textDecoration: 'none',
                fontSize: 'var(--text-sm)',
              }}
            >
              <span
                style={{
                  flex: '0 1 auto',
                  fontWeight: 600,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {page.name}
              </span>
              <span
                className="tabular"
                style={{ fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}
              >
                /s/{page.slug}
              </span>
            </a>

            <button
              type="button"
              onClick={() => onForget(page.slug)}
              // The name is in the label, not just beside it: a row of six
              // buttons all called "Forget" tells a screen reader nothing.
              aria-label={`Forget ${page.name}`}
              title={`Forget ${page.name}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 40,
                height: 40,
                flexShrink: 0,
                borderRadius: 'var(--radius-sm)',
                border: 0,
                background: 'transparent',
                color: 'var(--color-fg-subtle)',
                cursor: 'pointer',
              }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

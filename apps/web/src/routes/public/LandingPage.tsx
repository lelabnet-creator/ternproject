import { useState } from 'react'
import { TernWordmark } from '../../components/brand/TernMark'
import { ThemePicker } from '../../components/ThemePicker'

/**
 * What `/` shows.
 *
 * It used to load the demo tenant. On a fresh install that is a page nobody
 * asked for; on a real one it is somebody else's status page served from the
 * root of yours. Neither is defensible, so the root asks which page you want.
 *
 * It does not check the name before navigating, on purpose. A private tenant
 * answers 404 by design — a landing page that said "that one exists but you
 * cannot see it" would undo that in one line, and turn this field into an
 * oracle for enumerating tenants.
 */
export function LandingPage() {
  const [slug, setSlug] = useState('')
  const clean = slug
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '')

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
      </div>
    </main>
  )
}

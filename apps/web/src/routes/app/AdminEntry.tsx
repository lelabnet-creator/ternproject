import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { adminApi } from '../../lib/adminApi'
import { AdminApp } from './AdminApp'
import { FirstRunSetup } from '../../features/onboarding/FirstRunSetup'
import { Banner } from '../../components/ui'

/**
 * What `/app` shows when no page is named in the address.
 *
 * An instance serves one status page, so `/app` has exactly one sensible
 * meaning: the admin of that page. Without this, the address falls through to
 * the landing page and lands the visitor on the *public* page instead — and
 * since an operator only ever sees the slug in the installer's output, "I know
 * the domain but not the slug" is the normal state of someone coming back to
 * their own instance a month later.
 *
 * Setup is asked about *before* the page is resolved, and that order is the
 * whole point: on a fresh instance there is no page yet — the wizard is what
 * creates it — so resolving first would answer "no page" and report an error
 * for the one situation that is entirely normal.
 */
export function AdminEntry() {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'setup'; tenant: { slug: string; name: string } | null }
    | { kind: 'admin'; slug: string }
    | { kind: 'ambiguous' }
  >({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false

    async function resolve() {
      const setup = await adminApi.setupState()
      if (cancelled) return

      if (setup.needsSetup) {
        setState({ kind: 'setup', tenant: setup.tenant })
        return
      }

      // Set up already, so a page exists; `instance()` is what names it.
      const info = await api.instance()
      if (cancelled) return

      setState(info.tenant ? { kind: 'admin', slug: info.tenant.slug } : { kind: 'ambiguous' })
    }

    resolve().catch(() => {
      if (!cancelled) setState({ kind: 'ambiguous' })
    })

    return () => {
      cancelled = true
    }
  }, [])

  if (state.kind === 'admin') return <AdminApp slug={state.slug} />

  if (state.kind === 'setup') {
    return (
      <FirstRunSetup
        tenant={state.tenant}
        // Now the address can name the page, so it should: every later visit,
        // bookmark and shared link carries the slug rather than depending on
        // this resolution running again.
        onReady={(slug) => window.location.replace(`/app/${encodeURIComponent(slug)}`)}
      />
    )
  }

  if (state.kind === 'ambiguous') {
    return (
      <main className="landing">
        <div className="landing-panel">
          {/* Real case: a database holding several pages cannot be resolved from
              an address that names none of them. */}
          <Banner tone="degraded">
            This instance does not serve a single status page, so <code>/app</code> cannot tell
            which admin you want. Open <code>/app/&lt;name&gt;</code> directly.
          </Banner>
        </div>
      </main>
    )
  }

  return <main className="landing" aria-busy="true" />
}

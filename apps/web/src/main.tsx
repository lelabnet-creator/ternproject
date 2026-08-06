import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import { applyStoredTheme } from './components/ThemePicker'
import { initI18n, resolveLocale } from './i18n'
import { AdminApp } from './routes/app/AdminApp'
import { LandingPage } from './routes/public/LandingPage'
import { StatusPage } from './routes/public/StatusPage'
import { ResetPasswordScreen } from './routes/app/ResetPasswordScreen'
import './styles/tokens.css'

/**
 * Entry point.
 *
 * Path matching rather than a router library: there are two destinations, the
 * public page and the admin, and a router would be more machinery than routes.
 * It goes in when nested routes actually appear.
 */
// Before anything renders: a page that appears in the wrong theme and corrects
// itself in front of the reader is worse than one that took a moment longer.
applyStoredTheme()

const i18n = initI18n(resolveLocale('en'))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Status data is worth refetching; nothing here is expensive enough to
      // justify serving something stale to someone checking during an outage.
      staleTime: 10_000,
      retry: 1,
    },
  },
})

const path = window.location.pathname
const adminSlug = path.match(/^\/app\/([^/]+)/)?.[1]
const publicSlug = path.match(/^\/s\/([^/]+)/)?.[1]
// The reset link's token travels in the query string rather than the path: it
// is a credential, and a path segment is what ends up in a referrer header and
// in every proxy access log along the way.
const resetToken =
  path === '/reset-password' ? new URLSearchParams(window.location.search).get('token') : null

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        {resetToken ? (
          <ResetPasswordScreen token={resetToken} />
        ) : adminSlug ? (
          <AdminApp slug={adminSlug} />
        ) : publicSlug ? (
          <StatusPage slug={publicSlug} />
        ) : (
          // No slug, no guess. The root used to load the demo tenant, which on a
          // real installation is somebody else's status page served from yours.
          <LandingPage />
        )}
      </QueryClientProvider>
    </I18nextProvider>
  </StrictMode>,
)

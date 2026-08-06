import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import { initI18n, resolveLocale } from './i18n'
import { AdminApp } from './routes/app/AdminApp'
import { StatusPage } from './routes/public/StatusPage'
import './styles/tokens.css'

/**
 * Entry point.
 *
 * Path matching rather than a router library: there are two destinations, the
 * public page and the admin, and a router would be more machinery than routes.
 * It goes in when nested routes actually appear.
 */
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        {adminSlug ? <AdminApp slug={adminSlug} /> : <StatusPage slug={publicSlug ?? 'acme'} />}
      </QueryClientProvider>
    </I18nextProvider>
  </StrictMode>,
)

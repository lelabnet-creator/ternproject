import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import { initI18n, resolveLocale } from './i18n'
import { StatusPage } from './routes/public/StatusPage'
import './styles/tokens.css'

/**
 * Entry point.
 *
 * Routing is a single path match for now — the public page is the only screen
 * that exists. A router goes in when there is a second destination to route to.
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

const slug = window.location.pathname.match(/^\/s\/([^/]+)/)?.[1] ?? 'acme'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <StatusPage slug={slug} />
      </QueryClientProvider>
    </I18nextProvider>
  </StrictMode>,
)

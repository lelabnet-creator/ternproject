import { useQuery } from '@tanstack/react-query'
import { adminApi } from '../lib/adminApi'

/**
 * Says the numbers are invented, and offers the way out.
 *
 * A demo page that looks exactly like a real one teaches nothing except
 * mistrust the first time someone acts on a figure it made up. This is the
 * whole reason the seeded tenant carries `isDemo`: the alternative was making
 * the demo *look* alive, which would have been the same lie told more
 * convincingly.
 *
 * The offer adapts, because the honest one depends on the instance. First-run
 * setup is open only while there is no account at all — it creates the one that
 * owns the instance. Where that is still available, the button leads there and
 * this page becomes theirs. Where an account already exists, the button would
 * be a door to nowhere, so it points at installing TERN instead.
 */
export function DemoBanner({ variant = 'page' }: { variant?: 'page' | 'admin' }) {
  // Cheap and cached: it is the same query the admin already runs to decide
  // between a sign-in form and the setup screen.
  const setup = useQuery({
    queryKey: ['setup-state'],
    queryFn: adminApi.setupState,
    retry: false,
  })

  const canClaim = setup.data?.needsSetup === true

  return (
    <div className="demo-banner" role="note">
      <div>
        <strong>This is a demonstration.</strong>{' '}
        {variant === 'admin'
          ? 'Everything here is synthetic, and nothing can be changed — every write is refused, whoever is asking.'
          : 'Every component, incident and measurement on this page was generated. None of it reports a real service.'}
      </div>

      {canClaim ? (
        <a className="demo-banner-action" href="/app">
          Make this instance yours
        </a>
      ) : (
        <a
          className="demo-banner-action"
          href="https://github.com/lelabnet-creator/ternproject#readme"
          target="_blank"
          rel="noreferrer noopener"
        >
          Run your own
        </a>
      )}
    </div>
  )
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminApi, ApiError } from '../../lib/adminApi'
import { Banner, Card } from '../../components/ui'

/**
 * Asking for the guided tour again.
 *
 * In the Account tab rather than under the page's settings, and taking no
 * `slug`: like the passkeys beside it, this follows the person across every
 * page they administer. Someone who manages three tenants asked to see the tour
 * once, not three times.
 */
export function TourPanel() {
  const queryClient = useQueryClient()
  const me = useQuery({ queryKey: ['me'], queryFn: adminApi.me })

  const set = useMutation({
    mutationFn: (seen: boolean) => adminApi.setTourSeen(seen),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  })

  const seen = me.data?.user.tourSeenAt ?? null

  return (
    <Card>
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 'var(--text-base)' }}>Guided tour</h2>
          <p
            className="measure"
            style={{
              margin: 'var(--space-1) 0 0',
              fontSize: 'var(--text-sm)',
              color: 'var(--color-fg-subtle)',
            }}
          >
            A short walk through the rail, one step per section, anchored to the real screen. It
            runs once for a new account and can be dismissed at any step.
          </p>
        </div>

        {set.isError && (
          <Banner tone="down">
            {set.error instanceof ApiError ? set.error.message : 'Could not save that.'}
          </Banner>
        )}

        <label style={{ display: 'grid', gap: 'var(--space-1)' }}>
          <span style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            <input
              type="checkbox"
              // The checkbox asks a question the reader would ask — "show it to
              // me" — rather than reporting the timestamp the row happens to
              // store.
              checked={seen === null}
              disabled={me.isPending || set.isPending}
              onChange={(e) => set.mutate(!e.target.checked)}
            />
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>
              Show me the tour next time I open the admin
            </span>
          </span>
          <span
            style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--color-fg-subtle)',
              paddingLeft: 'var(--space-5)',
            }}
          >
            {seen === null
              ? 'It will start the next time you load a page.'
              : `Last dismissed ${new Date(seen).toLocaleString()}. Remembered on your account, so it stays dismissed on every machine you sign in from.`}
          </span>
        </label>
      </div>
    </Card>
  )
}

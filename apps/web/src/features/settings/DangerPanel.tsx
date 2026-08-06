import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminApi, ApiError } from '../../lib/adminApi'
import { Banner, Button, Card } from '../../components/ui'

/**
 * The one screen where friction is the feature.
 *
 * Two gates, and they are different in kind on purpose: a checkbox proves the
 * consequence was read, and typing the tenant's own name proves the *right*
 * tenant is in front of you. A second "are you sure" would only prove the
 * first thing twice — most accidental wipes are the right gesture on the wrong
 * page.
 *
 * Both are re-checked on the server. A confirmation that exists only here is
 * one a stray `curl` walks past.
 */
export function DangerPanel({ slug, canWrite }: { slug: string; canWrite: boolean }) {
  const queryClient = useQueryClient()
  const summary = useQuery({
    queryKey: ['danger', slug],
    queryFn: () => adminApi.dangerSummary(slug),
  })

  const [open, setOpen] = useState(false)
  const [understood, setUnderstood] = useState(false)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<Record<string, number> | null>(null)

  const empty = useMutation({
    mutationFn: () => adminApi.emptyTenant(slug, typed),
    onSuccess: async (result) => {
      setDone(result.deleted)
      setError(null)
      setOpen(false)
      setUnderstood(false)
      setTyped('')
      // Everything on screen is now stale, including the counts above.
      await queryClient.invalidateQueries()
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  })

  const counts = summary.data
  const total =
    (counts?.controls ?? 0) +
    (counts?.agents ?? 0) +
    (counts?.incidents ?? 0) +
    (counts?.maintenances ?? 0) +
    (counts?.subscribers ?? 0) +
    (counts?.receivers ?? 0)

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      {done && (
        <Banner tone="operational">
          Emptied:{' '}
          {Object.entries(done)
            .filter(([, n]) => n > 0)
            .map(([name, n]) => `${n} ${name}`)
            .join(', ') || 'nothing was there'}
          .
        </Banner>
      )}

      <Card style={{ borderColor: 'var(--status-down)' }}>
        <h2
          style={{
            margin: '0 0 var(--space-2)',
            fontSize: 'var(--text-base)',
            color: 'var(--status-down)',
          }}
        >
          Empty this tenant
        </h2>

        <p
          className="measure"
          style={{
            margin: '0 0 var(--space-3)',
            fontSize: 'var(--text-sm)',
            color: 'var(--color-fg-muted)',
          }}
        >
          Deletes everything this page monitors and publishes. <strong>It cannot be undone</strong>,
          and there is no export first — take a database backup if the data matters.
        </p>

        {counts && (
          <div className="facts" style={{ marginBottom: 'var(--space-3)' }}>
            {(
              [
                ['Controls', counts.controls],
                ['Measurements', counts.checks],
                ['Agents', counts.agents],
                ['Incidents', counts.incidents],
                ['Maintenances', counts.maintenances],
                ['Subscribers', counts.subscribers],
                ['Receivers', counts.receivers],
              ] as const
            ).map(([label, n]) => (
              <div key={label}>
                <div
                  className="tabular"
                  style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--color-fg)' }}
                >
                  {n.toLocaleString()}
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}>
                  {label}
                </div>
              </div>
            ))}
          </div>
        )}

        <p
          className="measure"
          style={{
            margin: '0 0 var(--space-3)',
            fontSize: 'var(--text-sm)',
            color: 'var(--color-fg-subtle)',
          }}
        >
          {/* What survives matters as much as what goes, and saying it here
              prevents the wrong operation being chosen for the right reason. */}
          Kept: the page itself, its address, its settings and its members — and the audit trail,
          which will hold the record of this. To remove the tenant entirely, that is a different
          operation and it is not here.
        </p>

        {error && <Banner tone="down">{error}</Banner>}

        {!canWrite ? (
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)' }}>
            Only an administrator can do this.
          </p>
        ) : !open ? (
          <Button variant="danger" onClick={() => setOpen(true)}>
            Empty this tenant…
          </Button>
        ) : (
          <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
            <label style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                checked={understood}
                onChange={(e) => setUnderstood(e.target.checked)}
                style={{ width: 20, height: 20, marginTop: 2 }}
              />
              <span style={{ fontSize: 'var(--text-sm)' }}>
                I understand that {total.toLocaleString()} record
                {total === 1 ? '' : 's'} and {(counts?.checks ?? 0).toLocaleString()} measurements
                will be deleted, and that this cannot be undone.
              </span>
            </label>

            <label style={{ display: 'grid', gap: 'var(--space-1)' }}>
              <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>
                Type <code>{slug}</code> to confirm
              </span>
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                style={{
                  background: 'var(--color-bg)',
                  color: 'var(--color-fg)',
                  border: '1px solid var(--color-border-strong)',
                  borderRadius: 'var(--radius-sm)',
                  padding: 'var(--space-2) var(--space-3)',
                  fontSize: 'var(--text-base)',
                  fontFamily: 'inherit',
                  minHeight: 44,
                  maxWidth: '20rem',
                }}
              />
            </label>

            <div className="form-actions">
              <Button
                onClick={() => {
                  setOpen(false)
                  setUnderstood(false)
                  setTyped('')
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                busy={empty.isPending}
                disabled={!understood || typed !== slug}
                onClick={() => empty.mutate()}
              >
                Empty it
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}

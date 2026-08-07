import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Smartphone, Trash2, Usb } from 'lucide-react'
import { adminApi, ApiError } from '../../lib/adminApi'
import { Banner, Button, Card, EmptyState, Field, Input } from '../../components/ui'
import { PasskeyCancelled, enrolPasskey, passkeysSupported } from '../../lib/passkeys'

/**
 * The passkeys on *your* account.
 *
 * Per user, not per tenant, which is why this sits in its own tab rather than
 * beside the settings that describe a status page. Somebody who administers two
 * tenants has one set of passkeys, and finding them under one page's options
 * would imply otherwise.
 *
 * A passkey is always an addition here: the account keeps its password, so
 * removing the last passkey locks nobody out and this screen never has to
 * refuse a deletion. That is a deliberate consequence of the choice made in the
 * schema — see `packages/db/src/schema/auth.ts`.
 */
export function PasskeysPanel() {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [supported] = useState(passkeysSupported)

  const passkeys = useQuery({ queryKey: ['passkeys'], queryFn: adminApi.passkeys })

  const add = useMutation({
    mutationFn: () => enrolPasskey(name.trim() || defaultName()),
    onSuccess: async () => {
      setName('')
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ['passkeys'] })
    },
    onError: (err) => {
      if (err instanceof PasskeyCancelled) setError(null)
      else setError(err instanceof ApiError || err instanceof Error ? err.message : String(err))
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => adminApi.removePasskey(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['passkeys'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  })

  if (!supported) {
    return (
      <Card>
        <Banner tone="degraded">
          This browser cannot use passkeys. They need a recent browser served over https, or over
          http on localhost.
        </Banner>
      </Card>
    )
  }

  const rows = passkeys.data ?? []

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <Card>
        <h2 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-lg)' }}>Passkeys</h2>
        <p
          className="measure"
          style={{
            margin: '0 0 var(--space-4)',
            color: 'var(--color-fg-subtle)',
            fontSize: 'var(--text-sm)',
          }}
        >
          A passkey signs you in with your device instead of a password — a fingerprint, a face, or
          a security key. There is nothing to type, and nothing a lookalike site can capture. Your
          password keeps working, and stays the way back in if you lose the device.
        </p>

        {error && <Banner tone="down">{error}</Banner>}

        <form
          onSubmit={(event) => {
            event.preventDefault()
            add.mutate()
          }}
          style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end' }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <Field label="Name" hint="For you, so a list of four keys is not four identical rows.">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={defaultName()}
                maxLength={100}
              />
            </Field>
          </div>
          <Button type="submit" variant="primary" busy={add.isPending}>
            Add a passkey
          </Button>
        </form>
      </Card>

      <Card>
        {rows.length === 0 ? (
          <EmptyState
            title="No passkeys yet"
            hint="Add one on each device you sign in from. They are independent — losing one leaves the others working."
          />
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}>
            {rows.map((row) => (
              <li
                key={row.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-3)',
                  padding: 'var(--space-3)',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--color-border)',
                }}
              >
                <DeviceIcon deviceType={row.deviceType} />

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{row.name}</div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}>
                    {describe(row)}
                  </div>
                </div>

                <Button
                  variant="danger"
                  ariaLabel={`Remove ${row.name}`}
                  onClick={() => remove.mutate(row.id)}
                  busy={remove.isPending && remove.variables === row.id}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

/**
 * A name proposed rather than demanded.
 *
 * The platform string is the honest answer to "which device is this?" and it is
 * what the person would have typed anyway. They can overwrite it.
 */
function defaultName(): string {
  const ua = navigator.userAgent
  if (/iPhone|iPad/.test(ua)) return 'iPhone'
  if (/Android/.test(ua)) return 'Android phone'
  if (/Mac OS X/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows PC'
  if (/Linux/.test(ua)) return 'Linux PC'
  return 'This device'
}

function DeviceIcon({ deviceType }: { deviceType: string | null }) {
  const Icon =
    deviceType === 'singleDevice' ? Usb : deviceType === 'multiDevice' ? Smartphone : KeyRound
  return <Icon size={18} aria-hidden="true" style={{ color: 'var(--color-fg-subtle)' }} />
}

function describe(row: {
  backedUp: boolean
  lastUsedAt: string | null
  createdAt: string
}): string {
  const used = row.lastUsedAt
    ? `Last used ${new Date(row.lastUsedAt).toLocaleDateString()}`
    : 'Never used'
  // Whether it is synced matters to the reader: a synced passkey survives the
  // device being lost, and one that is not does not.
  const synced = row.backedUp ? 'synced to your account' : 'this device only'
  return `${used} · ${synced} · added ${new Date(row.createdAt).toLocaleDateString()}`
}

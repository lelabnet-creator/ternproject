import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { adminApi, ApiError } from '../../lib/adminApi'
import { Banner, Button, Card, Field, Input } from '../../components/ui'
import { TernWordmark } from '../../components/brand/TernMark'
import { SiteFooter } from '../../components/SiteFooter'
import { PASSWORD_MIN_LENGTH } from '@tern/shared/password'

/** The server's own floor, so the rejection happens before the round trip. */
const MIN_LENGTH = PASSWORD_MIN_LENGTH

/**
 * What the link in the reset mail opens.
 *
 * The same shell as signing in and as the root, because it is the third door
 * into the product and a door that looks unrelated feels like a different
 * building.
 *
 * It does not check the token before showing the form. Asking the server "is
 * this token good?" on load would answer that question for anyone holding a
 * guess, and would cost the person who actually has a valid link an extra round
 * trip to learn nothing. The token is judged when it is used.
 */
export function ResetPasswordScreen({ token }: { token: string }) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<string | null>(null)

  const tooShort = password.length > 0 && password.length < MIN_LENGTH
  const mismatch = confirmation.length > 0 && confirmation !== password
  const ready = password.length >= MIN_LENGTH && confirmation === password

  const reset = useMutation({
    mutationFn: () => adminApi.resetPassword(token, password),
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  })

  return (
    <main className="landing">
      <div className="landing-image" role="img" aria-label="A tern over the sea" />

      <div className="landing-panel">
        <Card style={{ width: 'min(26rem, 100%)' }}>
          <div style={{ textAlign: 'center', marginBottom: 'var(--space-5)' }}>
            <TernWordmark size={34} />
            <h1
              style={{
                margin: 'var(--space-3) 0 0',
                fontSize: 'var(--text-xl)',
                color: 'var(--color-fg)',
              }}
            >
              Choose a new password
            </h1>
          </div>

          {reset.isSuccess ? (
            <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
              <Banner tone="operational">Your password has been changed.</Banner>
              <p
                style={{
                  margin: 0,
                  fontSize: 'var(--text-sm)',
                  color: 'var(--color-fg-subtle)',
                  lineHeight: 1.6,
                }}
              >
                {/* Said plainly, because both facts surprise people: every other
                    device was signed out, and a second factor is still a second
                    factor — a reset is not a way past it. */}
                Every device that was signed in has been signed out. If this account uses an
                authenticator app, you will still be asked for a code.
              </p>
              <Button variant="primary" onClick={() => window.location.assign('/')}>
                Continue
              </Button>
            </div>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                setError(null)
                reset.mutate()
              }}
              style={{ display: 'grid', gap: 'var(--space-4)' }}
            >
              {error && <Banner tone="down">{error}</Banner>}

              <Field
                label="New password"
                hint={`At least ${MIN_LENGTH} characters.`}
                error={tooShort ? `Use at least ${MIN_LENGTH} characters.` : undefined}
              >
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  autoFocus
                />
              </Field>

              <Field label="Repeat it" error={mismatch ? 'The two do not match.' : undefined}>
                <Input
                  type="password"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  autoComplete="new-password"
                />
              </Field>

              <Button type="submit" variant="primary" busy={reset.isPending} disabled={!ready}>
                Set the password
              </Button>

              <a
                href="/"
                style={{
                  textAlign: 'center',
                  fontSize: 'var(--text-sm)',
                  color: 'var(--color-fg-subtle)',
                }}
              >
                Back
              </a>
            </form>
          )}
        </Card>

        <SiteFooter />
      </div>
    </main>
  )
}

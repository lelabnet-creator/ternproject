import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { adminApi, ApiError } from '../../lib/adminApi'
import { Banner, Button, Card, Field, Input } from '../../components/ui'
import { TernWordmark } from '../../components/brand/TernMark'
import { SiteFooter } from '../../components/SiteFooter'
import { PASSWORD_MIN_LENGTH } from '@tern/shared/password'
import { PasskeyCancelled, enrolPasskey, passkeysSupported } from '../../lib/passkeys'

/**
 * What a freshly installed instance shows instead of a sign-in form.
 *
 * A sign-in form on an instance with no accounts is a door with nothing behind
 * it: there is no password to type, no way to make one, and nothing on screen
 * that says so. This asks for the two things that cannot be guessed — who
 * administers the page, and how it sends mail — and proves the second before
 * calling itself done.
 *
 * Mail is asked here rather than left to the settings screen because of what
 * depends on it. Subscriber double opt-in, incident notifications and password
 * recovery all go through it, and the last one is the trap: an admin who
 * discovers the mail settings are wrong on the day they forget their password
 * discovers it from the wrong side of the door.
 *
 * The steps write through the same endpoints the ordinary screens use —
 * `POST /setup/account`, then `PATCH /:slug/settings` and the existing mail
 * test. Nothing here can configure something an admin could not reach later.
 */

type Step = 'page' | 'account' | 'mail' | 'done'

const ALL_STEPS: { id: Step; label: string }[] = [
  { id: 'page', label: 'Page' },
  { id: 'account', label: 'Account' },
  { id: 'mail', label: 'Mail' },
  { id: 'done', label: 'Done' },
]

/** Slugs travel in URLs. Same rule the API applies, so the preview does not lie. */
function slugify(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      // Diacritics folded rather than stripped: without this, "Réseau" becomes
      // "r-seau" instead of "reseau", and every accented name — which is most of
      // them outside English — gets an address nobody would have chosen.
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
  )
}

export function FirstRunSetup({
  tenant,
  onReady,
}: {
  tenant: { slug: string; name: string } | null
  /** Carries the page's address: at `/app` it is not known until now. */
  onReady: (slug: string) => void
}) {
  // An instance provisioned with TERN_TENANT_SLUG already has its page, and
  // asking again would offer a rename dressed up as a setup question.
  const hasPage = tenant !== null
  const steps = hasPage ? ALL_STEPS.filter((s) => s.id !== 'page') : ALL_STEPS

  const [step, setStep] = useState<Step>(hasPage ? 'account' : 'page')
  const [error, setError] = useState<string | null>(null)

  // Page
  const [createdSlug, setCreatedSlug] = useState('')
  const [createdName, setCreatedName] = useState('')
  const [pageName, setPageName] = useState('')
  const [pageSlug, setPageSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const effectiveSlug = slugTouched ? slugify(pageSlug) : slugify(pageName)

  // Account
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')

  // Mail
  const [host, setHost] = useState('')
  const [port, setPort] = useState('587')
  const [secure, setSecure] = useState(false)
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [from, setFrom] = useState('')
  const [testTo, setTestTo] = useState('')
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null)

  // Before the account exists the page may not either; afterwards the response
  // says what it is called.
  const effectiveTenantSlug = tenant?.slug ?? createdSlug

  const createAccount = useMutation({
    mutationFn: () =>
      adminApi.createFirstAccount({
        email: email.trim().toLowerCase(),
        name: name.trim(),
        password,
        ...(hasPage ? {} : { tenantName: pageName.trim(), tenantSlug: effectiveSlug }),
        // Taken from the browser rather than asked: the machine already knows,
        // and "Europe/Paris" is a thing nobody should have to type.
        locale: navigator.language.slice(0, 2),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    onSuccess: (result) => {
      setError(null)
      // The API normalises the slug, so this is the authoritative one — not the
      // preview computed while typing.
      setCreatedSlug(result.tenant.slug)
      setCreatedName(result.tenant.name)
      // Prefilled from the account just made: it is the address most likely to
      // be watched, and the one whose password recovery depends on this working.
      setTestTo(result.user.email)
      if (!from) setFrom(`${result.tenant.name} <status@example.com>`)
      setStep('mail')
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  })

  /**
   * Saves the settings, then sends through them.
   *
   * In that order, and not the other way round: the test endpoint sends with
   * whatever the tenant has stored, so testing before saving would test the
   * previous settings and report success for a configuration nobody is using.
   */
  const saveAndTest = useMutation({
    mutationFn: async () => {
      await adminApi.updateSettings(effectiveTenantSlug, {
        smtp: {
          host: host.trim(),
          port: Number(port),
          secure,
          user: user.trim() || undefined,
          password: pass || undefined,
          from: from.trim(),
        },
      })
      return adminApi.testMail(effectiveTenantSlug, testTo.trim())
    },
    onSuccess: (result) => {
      setError(null)
      setTestResult({ ok: result.sent, detail: result.detail })
    },
    onError: (err) => {
      setTestResult(null)
      setError(err instanceof ApiError ? err.message : String(err))
    },
  })

  /*
   * Why every step validates into named messages rather than one boolean:
   *
   * a greyed-out button states that something is wrong and refuses to say what.
   * The reader is left comparing their form against a rule nobody wrote down —
   * and the rule that actually blocks them here, the password's minimum length,
   * is invisible until they happen to reach it.
   *
   * So: the buttons stay enabled, pressing one reveals what is missing, and each
   * message sits beside the field it belongs to.
   */
  const PASSWORD_MIN = PASSWORD_MIN_LENGTH

  const pageErrors = {
    pageName: !pageName.trim() ? 'Required.' : null,
    pageSlug: !effectiveSlug ? 'This leaves nothing usable in a URL.' : null,
  }

  const accountErrors = {
    email: !email.trim()
      ? 'Required.'
      : // Deliberately loose: the server decides, and a clever regexp here only
        // rejects addresses that are perfectly valid.
        !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())
        ? 'That does not look like an email address.'
        : null,
    name: !name.trim() ? 'Required.' : null,
    password: !password
      ? 'Required.'
      : password.length < PASSWORD_MIN
        ? `${PASSWORD_MIN - password.length} more character${
            PASSWORD_MIN - password.length === 1 ? '' : 's'
          }.`
        : null,
    confirm: !confirm ? 'Required.' : password !== confirm ? 'These do not match.' : null,
  }

  const mailErrors = {
    host: !host.trim() ? 'Required.' : null,
    port:
      !/^\d+$/.test(port.trim()) || Number(port) < 1 || Number(port) > 65535
        ? 'A port between 1 and 65535.'
        : null,
    from: !from.trim() ? 'Required.' : null,
    testTo: !testTo.trim() ? 'Required — the test has to go somewhere.' : null,
  }

  const firstProblem = (errors: Record<string, string | null>) =>
    Object.values(errors).some(Boolean)

  /**
   * Errors stay hidden until the field is left or the step is submitted.
   * Turning a form red before anything has been typed is not guidance, it is
   * an accusation.
   */
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [submitted, setSubmitted] = useState<Record<Step, boolean>>({
    page: false,
    account: false,
    mail: false,
    done: false,
  })
  const touch = (field: string) => setTouched((t) => ({ ...t, [field]: true }))
  const shown = (field: string, current: Step) =>
    touched[field] || submitted[current] ? true : false

  return (
    <main className="landing">
      <div className="landing-image" role="img" aria-label="A tern over the sea" />

      <div className="landing-panel">
        <Card style={{ width: 'min(30rem, 100%)' }}>
          <div style={{ textAlign: 'center', marginBottom: 'var(--space-4)' }}>
            <TernWordmark size={34} />
            <h1
              style={{
                margin: 'var(--space-3) 0 0',
                fontSize: 'var(--text-xl)',
                color: 'var(--color-fg)',
              }}
            >
              {step === 'done'
                ? 'Ready'
                : `Set up ${(tenant?.name ?? pageName.trim()) || 'this instance'}`}
            </h1>
          </div>

          <Steps current={step} steps={steps} />

          <div style={{ display: 'grid', gap: 'var(--space-4)', marginTop: 'var(--space-5)' }}>
            {error && <Banner tone="down">{error}</Banner>}

            {step === 'page' && (
              <>
                <Explain>
                  Nothing has been named yet. This is the page your users will open — its name
                  appears at the top of it, and the address is where it lives.
                </Explain>

                <Field
                  label="Name"
                  hint="Shown at the top of the public page."
                  error={shown('pageName', 'page') ? (pageErrors.pageName ?? undefined) : undefined}
                >
                  <Input
                    value={pageName}
                    autoFocus
                    placeholder="Acme Corp"
                    onBlur={() => touch('pageName')}
                    onChange={(e) => setPageName(e.target.value)}
                  />
                </Field>

                <Field
                  label="Address"
                  /* Derived from the name until it is edited, then left alone:
                     a field that keeps overwriting what you typed is worse than
                     one that never filled itself in. */
                  hint={
                    effectiveSlug
                      ? `The page will live at /s/${effectiveSlug}`
                      : 'Letters, digits and hyphens.'
                  }
                  error={shown('pageSlug', 'page') ? (pageErrors.pageSlug ?? undefined) : undefined}
                >
                  <Input
                    value={slugTouched ? pageSlug : effectiveSlug}
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                    onBlur={() => touch('pageSlug')}
                    onChange={(e) => {
                      setSlugTouched(true)
                      setPageSlug(e.target.value)
                    }}
                  />
                </Field>

                <Actions>
                  <Button
                    variant="primary"
                    onClick={() => {
                      setError(null)
                      setSubmitted((v) => ({ ...v, page: true }))
                      if (firstProblem(pageErrors)) return
                      setStep('account')
                    }}
                  >
                    Continue
                  </Button>
                </Actions>
              </>
            )}

            {step === 'account' && (
              <>
                <Explain>
                  This is the first account on this instance, and it administers{' '}
                  <strong>{(tenant?.name ?? pageName.trim()) || 'the status page'}</strong>.
                  Creating it closes this screen for good — afterwards this address is a sign-in
                  form.
                </Explain>

                <Field
                  label="Email"
                  hint="Used to sign in, and to recover the password."
                  error={shown('email', 'account') ? (accountErrors.email ?? undefined) : undefined}
                >
                  <Input
                    type="email"
                    value={email}
                    autoFocus
                    autoComplete="username"
                    onBlur={() => touch('email')}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </Field>

                <Field
                  label="Name"
                  hint="Shown beside anything you publish."
                  error={shown('name', 'account') ? (accountErrors.name ?? undefined) : undefined}
                >
                  <Input
                    value={name}
                    onBlur={() => touch('name')}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>

                <Field
                  label="Password"
                  /* The requirement is in the hint before anything is typed, and
                     becomes a countdown once it is. A rule you only meet by
                     failing it is a rule stated too late. */
                  hint={`At least ${PASSWORD_MIN} characters.`}
                  error={
                    shown('password', 'account') ? (accountErrors.password ?? undefined) : undefined
                  }
                >
                  <Input
                    type="password"
                    value={password}
                    autoComplete="new-password"
                    onBlur={() => touch('password')}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>

                <Field
                  label="Confirm password"
                  /* Checked here rather than reported after submitting: a typo in
                     the one credential that opens this instance is worth catching
                     before it is stored, not after. */
                  hint="Once more."
                  error={
                    shown('confirm', 'account') ? (accountErrors.confirm ?? undefined) : undefined
                  }
                >
                  <Input
                    type="password"
                    value={confirm}
                    autoComplete="new-password"
                    onBlur={() => touch('confirm')}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </Field>

                <Actions>
                  {!hasPage && (
                    <Button onClick={() => setStep('page')} disabled={createAccount.isPending}>
                      Back
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    busy={createAccount.isPending}
                    disabled={createAccount.isPending}
                    onClick={() => {
                      setError(null)
                      setSubmitted((v) => ({ ...v, account: true }))
                      if (firstProblem(accountErrors)) return
                      createAccount.mutate()
                    }}
                  >
                    Create account
                  </Button>
                </Actions>
              </>
            )}

            {step === 'mail' && (
              <>
                <Explain>
                  Where this instance sends from. Subscriber confirmations, incident notifications
                  and password recovery all use it — including yours, which is why this asks for a
                  test rather than taking your word for it.
                </Explain>

                <Field
                  label="SMTP server"
                  hint="Host name, without the port."
                  error={shown('host', 'mail') ? (mailErrors.host ?? undefined) : undefined}
                >
                  <Input
                    value={host}
                    autoFocus
                    placeholder="smtp.example.com"
                    onBlur={() => touch('host')}
                    onChange={(e) => setHost(e.target.value)}
                  />
                </Field>

                <div className="facts">
                  <Field
                    label="Port"
                    hint="587 for STARTTLS, 465 for implicit TLS."
                    error={shown('port', 'mail') ? (mailErrors.port ?? undefined) : undefined}
                  >
                    <Input
                      inputMode="numeric"
                      value={port}
                      onBlur={() => touch('port')}
                      onChange={(e) => {
                        setPort(e.target.value)
                        // 465 is implicit TLS and 587 negotiates it. Getting this
                        // pair the wrong way round hangs the connection on a
                        // handshake that never comes, so the port sets it and the
                        // box stays there to be overridden.
                        setSecure(e.target.value.trim() === '465')
                      }}
                    />
                  </Field>
                  <Field label="Implicit TLS" hint="On for 465, off for 587.">
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-2)',
                        minHeight: 44,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={secure}
                        onChange={(e) => setSecure(e.target.checked)}
                      />
                      <span style={{ fontSize: 'var(--text-sm)' }}>{secure ? 'On' : 'Off'}</span>
                    </label>
                  </Field>
                </div>

                <div className="facts">
                  <Field label="Username" hint="Blank if the server needs none.">
                    <Input
                      value={user}
                      autoComplete="off"
                      onChange={(e) => setUser(e.target.value)}
                    />
                  </Field>
                  <Field label="Password" hint="Stored encrypted. Never shown again.">
                    <Input
                      type="password"
                      value={pass}
                      autoComplete="new-password"
                      onChange={(e) => setPass(e.target.value)}
                    />
                  </Field>
                </div>

                <Field
                  label="From"
                  hint='The envelope sender, e.g. "Acme <status@acme.com>".'
                  error={shown('from', 'mail') ? (mailErrors.from ?? undefined) : undefined}
                >
                  <Input
                    value={from}
                    onBlur={() => touch('from')}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </Field>

                <Field
                  label="Send a test to"
                  hint="Saves the settings, then sends through them."
                  error={shown('testTo', 'mail') ? (mailErrors.testTo ?? undefined) : undefined}
                >
                  <Input
                    type="email"
                    value={testTo}
                    onBlur={() => touch('testTo')}
                    onChange={(e) => setTestTo(e.target.value)}
                  />
                </Field>

                {testResult && (
                  <Banner tone={testResult.ok ? 'operational' : 'down'}>
                    {testResult.ok
                      ? `Sent to ${testTo}. Check that it arrived — a server that accepts a message can still fail to deliver it.`
                      : testResult.detail}
                  </Banner>
                )}

                <Actions>
                  {/* Skippable, and deliberately so. An instance with no mail
                      server yet is a real situation, and holding the operator on
                      this screen would only teach them to type something false.
                      What it costs is stated rather than hidden. */}
                  <Button onClick={() => setStep('done')} disabled={saveAndTest.isPending}>
                    Skip for now
                  </Button>
                  <Button
                    variant="primary"
                    busy={saveAndTest.isPending}
                    disabled={saveAndTest.isPending}
                    onClick={() => {
                      setError(null)
                      setSubmitted((v) => ({ ...v, mail: true }))
                      if (firstProblem(mailErrors)) return
                      saveAndTest.mutate()
                    }}
                  >
                    {testResult?.ok ? 'Send again' : 'Save and send test'}
                  </Button>
                  {testResult?.ok && (
                    <Button variant="primary" onClick={() => setStep('done')}>
                      Continue
                    </Button>
                  )}
                </Actions>
              </>
            )}

            {step === 'done' && (
              <>
                <Explain>
                  <Check size={16} aria-hidden="true" style={{ verticalAlign: '-2px' }} /> The
                  instance is yours. You are signed in as an administrator of{' '}
                  <strong>{tenant?.name ?? createdName}</strong>.
                </Explain>

                {/* Offered here rather than made a step of its own. It is the
                    one moment the operator is certainly at the device they will
                    come back on, and a wizard that grows a fifth mandatory
                    screen for something optional is a wizard people click
                    through without reading. */}
                <PasskeyOffer />

                <Explain>
                  Two things worth doing next: enrol a second factor — it is required for admins and
                  the admin will ask on the way in — and add the first control, which is what puts
                  anything on the page.
                </Explain>

                {!testResult?.ok && (
                  <Banner tone="degraded">
                    Mail has not been proven to work. Options → Notifications is where to finish it,
                    and password recovery will not work until you do.
                  </Banner>
                )}

                <Actions>
                  <Button variant="primary" onClick={() => onReady(effectiveTenantSlug)}>
                    Open the admin
                  </Button>
                </Actions>
              </>
            )}
          </div>
        </Card>

        <SiteFooter compact />
      </div>
    </main>
  )
}

/**
 * "Add a passkey to this device", on the last screen of the wizard.
 *
 * Optional and quiet. It disappears entirely where the browser cannot do
 * WebAuthn — an instance reached over plain http by IP, which is a normal way
 * to meet a freshly installed box — rather than offering a button that would
 * throw. The account keeps its password either way, so skipping this costs
 * nothing that cannot be added later from Options → Account.
 */
function PasskeyOffer() {
  const [supported] = useState(passkeysSupported)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const add = useMutation({
    mutationFn: () => enrolPasskey('This device'),
    onSuccess: () => {
      setDone(true)
      setError(null)
    },
    onError: (err) => {
      if (err instanceof PasskeyCancelled) setError(null)
      else setError(err instanceof Error ? err.message : String(err))
    },
  })

  if (!supported) return null

  if (done) {
    return (
      <Explain>
        <Check size={16} aria-hidden="true" style={{ verticalAlign: '-2px' }} /> This device is now
        a passkey. Next time, signing in is a fingerprint rather than a password.
      </Explain>
    )
  }

  return (
    <div
      style={{
        display: 'grid',
        gap: 'var(--space-3)',
        padding: 'var(--space-4)',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--color-border)',
      }}
    >
      <Explain>
        You can sign in from this device without typing a password — a fingerprint, a face, or a
        security key. Your password keeps working, and stays the way back in if you lose the device.
      </Explain>

      {error && <Banner tone="down">{error}</Banner>}

      <div>
        <Button onClick={() => add.mutate()} busy={add.isPending}>
          Add a passkey
        </Button>
      </div>
    </div>
  )
}

function Steps({ current, steps }: { current: Step; steps: typeof ALL_STEPS }) {
  const index = steps.findIndex((s) => s.id === current)

  return (
    <ol
      style={{
        display: 'flex',
        listStyle: 'none',
        margin: 0,
        padding: 0,
        gap: 'var(--space-2)',
        justifyContent: 'center',
      }}
    >
      {steps.map((s, i) => (
        <li
          key={s.id}
          // The state is in the text, not only in the colour: "step 2 of 3,
          // current" is what a screen reader needs, and a filled dot says
          // nothing to one.
          aria-current={i === index ? 'step' : undefined}
          style={{
            fontSize: 'var(--text-xs)',
            fontWeight: i === index ? 600 : 400,
            color: i <= index ? 'var(--color-accent-ink)' : 'var(--color-fg-subtle)',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
          }}
        >
          {i > 0 && <span aria-hidden="true">·</span>}
          {s.label}
        </li>
      ))}
    </ol>
  )
}

function Explain({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="measure"
      style={{
        margin: 0,
        fontSize: 'var(--text-sm)',
        color: 'var(--color-fg-muted)',
        lineHeight: 'var(--leading-normal)',
      }}
    >
      {children}
    </p>
  )
}

function Actions({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 'var(--space-2)',
        justifyContent: 'flex-end',
        flexWrap: 'wrap',
      }}
    >
      {children}
    </div>
  )
}

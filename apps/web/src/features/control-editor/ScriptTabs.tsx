import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminApi, type ScriptBundle } from '../../lib/adminApi'
import { Banner, Button, CodeBlock, CopyButton } from '../../components/ui'

/** The agent sits beside the ten languages, not behind a separate screen. */
const AGENT_TAB = 'agent'

/**
 * Step 4 of the editor: the script, ready to run.
 *
 * All ten languages arrive together and are shown as tabs. Someone who works in
 * Perl should not have to discover that Perl is on offer, and generating on
 * demand would make switching tabs feel like waiting.
 *
 * The agent opens first, and is first in the row. A pushed script is a fine
 * answer for a batch job or a CI step, but the product's answer for "watch this
 * thing" is an agent: it runs the probes, it carries the schedule, it survives a
 * reboot, and it needs no key pasted into a file. Opening on Python made the
 * scripting path look like the intended one and the agent like a footnote at
 * the end of a row of pills.
 */
export function ScriptTabs({
  slug,
  controlId,
  /** A key just minted for this control, if the caller has one. */
  apiKey,
}: {
  slug: string
  controlId: string
  apiKey?: string
}) {
  const bundle = useQuery({
    queryKey: ['scripts', slug, controlId, apiKey],
    queryFn: () => adminApi.scripts(slug, controlId, apiKey),
  })

  const [active, setActive] = useState<string>(AGENT_TAB)

  if (bundle.isPending) return <p style={{ color: 'var(--color-fg-subtle)' }}>Loading scripts…</p>
  if (bundle.isError || !bundle.data) {
    return <Banner tone="down">Could not generate the scripts.</Banner>
  }

  const tabs = [
    { id: AGENT_TAB, label: 'Agent (Rust)', extension: 'toml', syntax: 'toml' },
    ...bundle.data.languages,
  ]

  const script = bundle.data.scripts[active] ?? ''
  const language = bundle.data.languages.find((l) => l.id === active)

  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      {!apiKey && (
        <Banner tone="degraded">
          {/* Being explicit beats letting someone paste a script with a
              placeholder and wonder why nothing arrives. */}
          Existing keys are stored only as hashes and cannot be shown again. The script below
          contains a placeholder — create a key, or pair an agent, and paste the value in.
        </Banner>
      )}

      {/*
        A tab strip rather than a row of pills.

        `role="tablist"` was already here and the keyboard contract that goes
        with it was not: every tab was reachable with Tab, which is exactly what
        a tablist is meant to avoid. One stop for the whole strip, arrows to
        move within it — roving `tabIndex` below — is what the role promises,
        and what a screen reader announces.
      */}
      <div
        role="tablist"
        aria-label="Script language"
        onKeyDown={(event) => {
          const step =
            event.key === 'ArrowRight'
              ? 1
              : event.key === 'ArrowLeft'
                ? -1
                : event.key === 'Home'
                  ? 'first'
                  : event.key === 'End'
                    ? 'last'
                    : null
          if (step === null) return
          event.preventDefault()
          const index = tabs.findIndex((tab) => tab.id === active)
          const next =
            step === 'first'
              ? 0
              : step === 'last'
                ? tabs.length - 1
                : // Wrapping, because a strip this long otherwise ends in a
                  // dead key press at each edge.
                  (index + step + tabs.length) % tabs.length
          const target = tabs[next]
          if (!target) return
          setActive(target.id)
          document.getElementById(`script-tab-${target.id}`)?.focus()
        }}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--space-1)',
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        {tabs.map((lang) => {
          const selected = lang.id === active
          return (
            <button
              key={lang.id}
              id={`script-tab-${lang.id}`}
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(lang.id)}
              style={{
                background: 'transparent',
                color: selected ? 'var(--color-fg)' : 'var(--color-fg-muted)',
                border: 'none',
                // The underline carries the selection, and sits on top of the
                // strip's own border so the two do not stack into a thick line.
                borderBottom: `2px solid ${selected ? 'var(--color-accent)' : 'transparent'}`,
                marginBottom: -1,
                borderRadius: 0,
                padding: '0 var(--space-3)',
                minHeight: 40,
                fontSize: 'var(--text-sm)',
                fontWeight: selected ? 600 : 500,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              {lang.label}
            </button>
          )
        })}
      </div>

      {active === AGENT_TAB ? (
        <AgentPanel slug={slug} controlId={controlId} agent={bundle.data.agent} />
      ) : (
        <>
          <CodeBlock label={`tern_push.${language?.extension ?? 'txt'}`}>{script}</CodeBlock>

          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <CopyButton value={script} variant="primary" />
            <Button
              onClick={() => {
                // A download rather than only a clipboard copy: the target machine
                // is often not the one running the browser.
                const blob = new Blob([script], { type: 'text/plain' })
                const url = URL.createObjectURL(blob)
                const link = document.createElement('a')
                link.href = url
                link.download = `tern_push.${language?.extension ?? 'txt'}`
                link.click()
                URL.revokeObjectURL(url)
              }}
            >
              Download
            </Button>
          </div>

          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)', margin: 0 }}>
            Every script reads <code>TERN_API_KEY</code> from the environment first, so the file
            itself is safe to commit.
          </p>
        </>
      )}
    </div>
  )
}

/**
 * The agent's equivalent of a script: a config file and two commands.
 *
 * The PIN is minted here, on a button, rather than arriving with the rest of the
 * bundle. A pairing code is a credential with a short life; one delivered with
 * every page view would sit in a cache and in a back button, unused and valid.
 */
function AgentPanel({
  slug,
  controlId,
  agent,
}: {
  slug: string
  controlId: string
  agent: ScriptBundle['agent']
}) {
  const pair = useMutation({ mutationFn: () => adminApi.createPairingCode(slug) })
  const queryClient = useQueryClient()

  const assignment = useQuery({
    queryKey: ['assignment', slug, controlId],
    queryFn: () => adminApi.assignment(slug, controlId),
  })

  const save = useMutation({
    mutationFn: (body: { policy: 'single' | 'all'; agentIds: string[] }) =>
      adminApi.setAssignment(slug, controlId, body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['assignment', slug, controlId] })
      await queryClient.invalidateQueries({ queryKey: ['agents', slug] })
    },
  })

  const candidates = assignment.data?.candidates ?? []
  const runners = assignment.data?.runners ?? []
  const policy = assignment.data?.policy ?? 'single'
  const pinned = assignment.data?.pinned ?? []

  const [pairAnyway, setPairAnyway] = useState(false)
  const showPairing = candidates.length === 0 || pairAnyway

  const runnerNames = runners
    .map((id) => candidates.find((c) => c.id === id)?.name ?? id)
    .join(', ')

  const toggle = (agentId: string) => {
    const next = pinned.includes(agentId)
      ? pinned.filter((id) => id !== agentId)
      : [...pinned, agentId]
    save.mutate({ policy, agentIds: next })
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      {candidates.length > 0 && (
        <section>
          <h3 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-sm)' }}>
            Who runs this probe
          </h3>

          <Banner tone={runners.length > 0 ? 'operational' : 'degraded'}>
            {/* The question the old wording could not answer. "11 agents cover
                this control" was true and useless — they were all running it. */}
            {runners.length === 0
              ? 'Nobody is running this probe. Pair an agent, or choose one below.'
              : runners.length === 1
                ? `${runnerNames} runs this probe.`
                : `${runners.length} agents run this probe: ${runnerNames}.`}
            {pinned.length === 0 &&
              runners.length > 0 &&
              ' Chosen automatically — pick one below to fix it.'}
          </Banner>

          <fieldset style={{ border: 0, margin: 'var(--space-3) 0 0', padding: 0 }}>
            <legend style={{ padding: 0, fontSize: 'var(--text-sm)', fontWeight: 600 }}>
              Policy
            </legend>
            <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
              {(
                [
                  [
                    'single',
                    'One agent',
                    'The usual case. Several agents probing the same URL is load, not redundancy.',
                  ],
                  [
                    'all',
                    'Every agent',
                    'Probe from each site, to tell “down” from “unreachable from here”.',
                  ],
                ] as const
              ).map(([id, label, why]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={policy === id}
                  title={why}
                  onClick={() => save.mutate({ policy: id, agentIds: pinned })}
                  style={{
                    minHeight: 44,
                    padding: '0 var(--space-4)',
                    borderRadius: 'var(--radius-sm)',
                    border: `1px solid ${policy === id ? 'var(--color-accent)' : 'var(--color-border)'}`,
                    background: policy === id ? 'var(--color-surface-raised)' : 'transparent',
                    color: 'var(--color-fg)',
                    fontFamily: 'inherit',
                    fontSize: 'var(--text-sm)',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>

          <div style={{ display: 'grid', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
            {candidates.map((candidate) => {
              const isRunner = runners.includes(candidate.id)
              const isPinned = pinned.includes(candidate.id)

              return (
                <label
                  key={candidate.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-3)',
                    minHeight: 44,
                    padding: 'var(--space-2) var(--space-3)',
                    border: `1px solid ${isRunner ? 'var(--color-accent)' : 'var(--color-border)'}`,
                    borderRadius: 'var(--radius-sm)',
                    opacity: candidate.eligible ? 1 : 0.55,
                    cursor: candidate.eligible ? 'pointer' : 'not-allowed',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isPinned}
                    disabled={!candidate.eligible || save.isPending}
                    onChange={() => toggle(candidate.id)}
                    style={{ width: 20, height: 20 }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <strong style={{ fontSize: 'var(--text-sm)' }}>{candidate.name}</strong>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 'var(--text-xs)',
                        color: 'var(--color-fg-subtle)',
                      }}
                    >
                      {candidate.site ?? 'no site'}
                      {/* Shown, not hidden: "cannot run it, and here is why"
                          beats a list that silently omits half the fleet. */}
                      {!candidate.eligible && ' · its key does not cover this control'}
                    </span>
                  </span>
                  {isRunner && (
                    <span
                      style={{
                        fontSize: 'var(--text-xs)',
                        fontWeight: 700,
                        color: 'var(--color-accent-ink)',
                      }}
                    >
                      running
                    </span>
                  )}
                </label>
              )
            })}
          </div>

          {pinned.length > 0 && (
            <div style={{ marginTop: 'var(--space-2)' }}>
              <Button onClick={() => save.mutate({ policy, agentIds: [] })}>
                Choose automatically instead
              </Button>
            </div>
          )}
        </section>
      )}

      <section>
        <h3 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-sm)' }}>
          1 · Pair the agent
        </h3>
        {!showPairing && (
          <Button onClick={() => setPairAnyway(true)}>Pair another agent anyway</Button>
        )}
        {!showPairing ? null : pair.data ? (
          <>
            <CodeBlock label="on the machine being monitored">
              {agent.pairCommand.replace('<PIN>', pair.data.pin)}
            </CodeBlock>
            <p
              className="tabular"
              style={{
                margin: 'var(--space-2) 0 0',
                fontSize: 'var(--text-xs)',
                color: 'var(--color-fg-subtle)',
              }}
            >
              This code expires at {new Date(pair.data.expiresAt).toLocaleTimeString()} and works
              once.
            </p>
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <Button variant="primary" busy={pair.isPending} onClick={() => pair.mutate()}>
              Generate a PIN
            </Button>
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)' }}>
              Short-lived, single use.
            </span>
          </div>
        )}
        {pair.isError && <Banner tone="down">Could not generate a pairing code.</Banner>}
      </section>

      <section>
        <h3 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-sm)' }}>
          2 · What pairing will write
        </h3>
        <p
          style={{
            margin: '0 0 var(--space-2)',
            fontSize: 'var(--text-sm)',
            color: 'var(--color-fg-subtle)',
          }}
        >
          Nothing to copy: the agent asks the server what it is for and writes this itself, with the
          real key in place of the placeholder. It is shown here so you can see what it will run.
        </p>
        <CodeBlock label="agent.toml">{agent.config}</CodeBlock>
      </section>

      <section>
        <h3 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-sm)' }}>3 · Run it</h3>
        <CodeBlock label="once, to check the config">{`${agent.runCommand} --once`}</CodeBlock>
        <div style={{ height: 'var(--space-2)' }} />
        <CodeBlock label="then, as a service">{agent.runCommand}</CodeBlock>
      </section>
    </div>
  )
}

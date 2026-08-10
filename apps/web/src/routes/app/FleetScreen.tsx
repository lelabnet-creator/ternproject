import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminApi, ApiError, type Agent } from '../../lib/adminApi'
import { AgentGalaxy, freshnessOf } from '../../charts/AgentGalaxy'
import {
  Banner,
  Button,
  Card,
  CodeBlock,
  EmptyState,
  Field,
  Input,
  Select,
} from '../../components/ui'

/**
 * The fleet.
 *
 * Two views of the same list, deliberately: a picture for "is anything wrong out
 * there", and a table for everything the picture cannot say — versions,
 * architectures, exact timestamps, and the controls that change them. The
 * picture is never the only way to reach an agent, because a diagram is not
 * something a screen reader or a keyboard can work through.
 */
export function FleetScreen({ slug, canWrite }: { slug: string; canWrite: boolean }) {
  const agents = useQuery({
    queryKey: ['agents', slug],
    queryFn: () => adminApi.agents(slug),
    // A fleet screen left open should not go stale: the whole point is seeing
    // an agent go quiet.
    refetchInterval: 30_000,
  })

  const [selected, setSelected] = useState<string | null>(null)
  const [pairing, setPairing] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [confirmBulk, setConfirmBulk] = useState<'revoke' | 'delete' | null>(null)

  const queryClient = useQueryClient()
  const bulk = useMutation({
    mutationFn: (action: 'revoke' | 'delete') => adminApi.bulkAgents(slug, [...picked], action),
    onSuccess: async () => {
      setPicked(new Set())
      setConfirmBulk(null)
      await queryClient.invalidateQueries({ queryKey: ['agents', slug] })
    },
  })

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  if (agents.isPending) return <p style={{ paddingTop: 'var(--space-6)' }}>Loading the fleet…</p>
  if (agents.isError) return <Banner tone="down">Could not load the agents.</Banner>

  const live = agents.data.filter((a) => a.status !== 'revoked')
  const now = Date.now()
  const quiet = live.filter((a) => freshnessOf(a, now) !== 'fresh')

  return (
    <section style={{ paddingTop: 'var(--space-6)', display: 'grid', gap: 'var(--space-5)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 'var(--text-xl)' }}>Agents</h1>
          <p style={{ margin: 'var(--space-1) 0 0', color: 'var(--color-fg-subtle)' }}>
            {live.length} active
            {agents.data.length > live.length && `, ${agents.data.length - live.length} revoked`}
            {quiet.length > 0 && ` · ${quiet.length} not reporting`}
          </p>
        </div>
        {/* Adding an agent starts here, where the fleet is — not buried in a
            control's Script step, which is where it used to be the only way. */}
        {canWrite && (
          <Button variant="primary" onClick={() => setPairing((v) => !v)}>
            {pairing ? 'Cancel' : 'Add an agent'}
          </Button>
        )}
      </div>

      {pairing && <PairPanel slug={slug} onDone={() => setPairing(false)} />}

      {/* A bar rather than a per-row menu: the whole point of selecting several
          is to act on them once. */}
      {canWrite && picked.size > 0 && (
        <Card>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
              flexWrap: 'wrap',
            }}
          >
            <strong style={{ flex: 1, minWidth: 0 }}>{picked.size} selected</strong>
            <Button onClick={() => setPicked(new Set())}>Clear</Button>
            <Button onClick={() => setConfirmBulk('revoke')}>Revoke</Button>
            <Button variant="danger" onClick={() => setConfirmBulk('delete')}>
              Delete
            </Button>
          </div>

          {confirmBulk && (
            <div style={{ marginTop: 'var(--space-3)' }}>
              <Banner tone="down">
                {/* The two verbs are not the same act, and the difference is
                    what someone needs to know before pressing either. */}
                {confirmBulk === 'revoke'
                  ? `Revoke ${picked.size} agent(s)? Their keys stop working immediately; the records stay, so the fleet still shows they existed.`
                  : `Delete ${picked.size} agent(s)? Their keys are revoked and the records are removed. The audit log keeps which ones — nothing else will.`}
              </Banner>
              <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                <Button
                  variant="danger"
                  busy={bulk.isPending}
                  onClick={() => bulk.mutate(confirmBulk)}
                >
                  {confirmBulk === 'revoke' ? 'Revoke them' : 'Delete them'}
                </Button>
                <Button onClick={() => setConfirmBulk(null)}>Keep them</Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {agents.data.length === 0 ? (
        <EmptyState
          title="No agents yet"
          hint="Press “Add an agent” above for a pairing code. Pairing hands the agent its probes, so there is nothing to copy onto the host and nothing to keep in step by hand."
        />
      ) : (
        <div className="split">
          <div className="split-aside">
            <Card>
              <AgentGalaxy
                agents={agents.data}
                now={now}
                size={320}
                selectedId={selected}
                onSelect={setSelected}
              />
            </Card>
          </div>

          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            {rootsOf(agents.data).map((agent) => (
              <AgentRow
                key={agent.id}
                slug={slug}
                agent={agent}
                zone={zonesOf(agents.data).get(agent.id) ?? []}
                canWrite={canWrite}
                selected={agent.id === selected}
                onSelect={() => setSelected(agent.id)}
                picked={picked.has(agent.id)}
                onPick={() => toggle(agent.id)}
                now={now}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

/**
 * The agents each relay stands in front of, by relay id.
 *
 * The server already says this — an agent the relay declared carries the
 * relay's id — and nothing in the admin read it. "Which machines are behind
 * this proxy" was therefore a question the fleet could not answer, even though
 * the diagram beside it had been drawing the answer for a release.
 */
export function zonesOf(agents: Agent[]): Map<string, Agent[]> {
  const zones = new Map<string, Agent[]>()
  for (const agent of agents) {
    if (!agent.parentAgentId) continue
    const behind = zones.get(agent.parentAgentId) ?? []
    behind.push(agent)
    zones.set(agent.parentAgentId, behind)
  }
  return zones
}

/**
 * The agents that are nobody's zone.
 *
 * Shown once, inside their relay, rather than twice: a zone agent listed at the
 * top level as well would make the fleet look bigger than it is, and would put
 * a row next to Rename and Revoke that neither verb can act on.
 *
 * A relay this server has never seen would orphan its agents — so an agent
 * whose parent is not in the list stays at the top level rather than vanishing.
 * Nothing should be able to make a machine disappear from the fleet screen.
 */
export function rootsOf(agents: Agent[]): Agent[] {
  const present = new Set(agents.map((agent) => agent.id))
  return agents.filter((agent) => !agent.parentAgentId || !present.has(agent.parentAgentId))
}

/**
 * A PIN, and the command it goes in.
 *
 * Minted on the button rather than delivered with the page: a pairing code is a
 * short-lived credential, and one arriving with every page view would sit in a
 * cache and in the back button, unused and valid.
 */
/**
 * The two one-liners, and the single flag between them.
 *
 * Its own component so the pair can be rendered without a mutation, a click or a
 * server — the same reason `matching()` sits apart from the screen that uses it.
 * What it guards is small and easy to get wrong in one direction only: adding
 * `--proxy` to the wrong line installs a relay where somebody wanted an agent,
 * and they find out at the far end of an install.
 */
/**
 * Which relay, and at what address.
 *
 * Its own component for the reason `PairCommands` is: it can then be rendered
 * without a query, a click or a server, which is the only way to hold it to
 * what it claims.
 *
 * Two fields and not one. The name is something this server knows; the address
 * is something it guesses — it holds where each relay paired *from*, which is
 * where it serves on an ordinary single-homed machine and is not on one with
 * two cards. So one is a choice and the other stays typeable.
 */
/**
 * The address to offer for one relay.
 *
 * What the relay says about itself first. `pairedIp` only as a fallback, and it
 * is a poor one: it holds where a connection arrived *from* as this server saw
 * it, which with TERN in a container is a Docker bridge gateway — an address
 * that exists only on that host. Offered as the way to reach the relay, it
 * produced a connection refused on the one machine that could not investigate.
 */
export function relayOrigin(relay: Agent | undefined): string {
  if (!relay) return ''
  if (relay.zoneAddress) return `http://${relay.zoneAddress}`
  return relay.pairedIp ? `http://${relay.pairedIp}:8787` : ''
}

export function RelayPicker({
  relays,
  chosenId,
  origin,
  onPick,
  onAddress,
}: {
  relays: Agent[]
  chosenId: string
  origin: string
  onPick: (id: string) => void
  onAddress: (address: string) => void
}) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <Field label="Through this relay" hint="Which one stands in front of that machine.">
        <Select value={chosenId} onChange={(e) => onPick(e.target.value)}>
          {relays.map((relay) => (
            <option key={relay.id} value={relay.id}>
              {/* The address beside the name: relays are named after their
                  hosts, so two of them can share a name and be told apart only
                  by where they answer. */}
              {relay.name}
              {relay.zoneAddress
                ? ` — ${relay.zoneAddress}`
                : relay.pairedIp
                  ? ` — ${relay.pairedIp} (guessed)`
                  : ' — address unknown'}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="At this address"
        hint="Where the isolated machine reaches it. Taken from where the relay paired — change it if it serves the zone on another card."
      >
        <Input
          value={origin}
          placeholder="http://192.168.10.4:8787"
          onChange={(e) => onAddress(e.target.value)}
        />
      </Field>
    </div>
  )
}

export function PairCommands({
  origin,
  pin,
  relay,
  via,
}: {
  origin: string
  pin: string
  relay: boolean
  /**
   * The relay a zone machine goes through, when it cannot reach this server.
   *
   * Everything moves together when it is set: the script is fetched from the
   * relay, the binary behind it comes from the relay, and the config written
   * names the relay. A machine with no route out cannot get any of those from
   * here — that is what makes it a zone — so a command that changed only one of
   * the three would fail at whichever step it forgot.
   */
  via?: string
}) {
  const from = via ?? origin
  const server = via ? ` --server ${via}` : ''
  const serverPs = via ? ` -Server ${via}` : ''

  return (
    <>
      <CodeBlock label="Linux or macOS">
        {`curl -fsSL ${from}/install.sh | sh -s --${relay ? ' --proxy' : ''}${server} --pin ${pin}`}
      </CodeBlock>

      <div style={{ height: 'var(--space-2)' }} />

      <CodeBlock label="Windows, in PowerShell">
        {/* A param script, so it is invoked as a script block — `| iex` would
            run it with no arguments and never see the PIN. */}
        {`& ([scriptblock]::Create((irm ${from}/install.ps1)))${relay ? ' -Proxy' : ''}${serverPs} -Pin ${pin}`}
      </CodeBlock>
    </>
  )
}

export function PairPanel({ slug, onDone }: { slug: string; onDone: () => void }) {
  const pair = useMutation({ mutationFn: () => adminApi.createPairingCode(slug) })
  // This instance's own address: the installer is served by the same origin the
  // browser is already talking to.
  const origin = window.location.origin

  /*
   * Which of the two is being added.
   *
   * Chosen here rather than baked into the code, because the code does not
   * carry it: the server decides from the version the binary announces when it
   * pairs. So the choice can be changed after a PIN exists and the same PIN
   * still works — which is why the selector stays visible below, instead of
   * disappearing once one is minted.
   */
  const [role, setRole] = useState<'agent' | 'proxy' | 'zone'>('agent')
  const relay = role === 'proxy'
  const zone = role === 'zone'

  /*
   * The relays this server knows, for the third case.
   *
   * A machine with no route out fetches everything through one of them, so the
   * command needs its address — and the address this server has is the one the
   * relay paired from, not the one it listens on. Since 0.1.16 a relay binds
   * the interface it reaches TERN from, so the two agree on an ordinary
   * single-homed machine and differ on one with two cards. Offered as a filled
   * field rather than a fact: it is right often enough to save the typing and
   * wrong often enough that it has to stay editable.
   */
  const fleet = useQuery({
    queryKey: ['agents', slug],
    queryFn: () => adminApi.agents(slug),
    enabled: zone,
  })
  const relays = (fleet.data ?? []).filter((a) => a.role === 'proxy' && a.status !== 'revoked')

  /*
   * Which relay, and at what address.
   *
   * Two states rather than one, because they answer different questions and
   * only the first can be offered as a list: this server knows its relays by
   * name, and knows the address each one paired *from* — which is a good guess
   * at where it serves and not a fact. Picking a relay fills the address;
   * typing over the address does not un-pick the relay.
   */
  const [chosenId, setChosenId] = useState<string | null>(null)
  const [via, setVia] = useState<string | null>(null)
  const chosen = relays.find((r) => r.id === chosenId) ?? relays[0]
  const zoneOrigin = via ?? relayOrigin(chosen)

  const pickRelay = (id: string) => {
    setChosenId(id)
    // The address follows the choice: a field still holding the previous
    // relay's address after picking another is a command that installs into
    // the wrong zone, and it looks right.
    setVia(null)
  }

  return (
    <Card>
      <h2 style={{ margin: '0 0 var(--space-2)', fontSize: 'var(--text-base)' }}>
        Add an agent or a relay
      </h2>

      <div
        role="radiogroup"
        aria-label="What to add"
        style={{ display: 'flex', gap: 'var(--space-2)' }}
      >
        {(
          [
            ['agent', 'An agent'],
            ['proxy', 'A relay'],
            ['zone', 'An agent behind a relay'],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            variant={role === value ? 'primary' : 'secondary'}
            ariaPressed={role === value}
            onClick={() => setRole(value)}
          >
            {label}
          </Button>
        ))}
      </div>

      {/* What the choice means, in one line. Two words on a button do not
          distinguish a thing that measures from a thing that relays, and
          choosing wrong is discovered at the far end of an install. */}
      <p
        className="measure"
        style={{
          margin: 'var(--space-2) 0 var(--space-3)',
          fontSize: 'var(--text-xs)',
          color: 'var(--color-fg-subtle)',
        }}
      >
        {relay
          ? 'A relay serves the agents of a network with no route out, and forwards what they measure.'
          : zone
            ? 'A machine with no route to this server. Everything it needs comes through a relay you have already placed.'
            : 'An agent measures from the machine it runs on, and reports here directly.'}
      </p>

      {/* The relay to go through, asked before the PIN: it is part of the
          command, and a code minted while the field is empty would produce a
          line nobody can run. */}
      {zone && (
        <div style={{ marginBottom: 'var(--space-3)' }}>
          {relays.length === 0 ? (
            <Banner tone="maintenance">
              No relay has paired with this server yet. Add one first — choose “A relay” above and
              run its command on the machine that <em>can</em> reach here.
            </Banner>
          ) : (
            <RelayPicker
              relays={relays}
              chosenId={chosen?.id ?? ''}
              origin={zoneOrigin}
              onPick={pickRelay}
              onAddress={setVia}
            />
          )}
        </div>
      )}

      {pair.data ? (
        <>
          <p
            className="measure"
            style={{
              margin: '0 0 var(--space-3)',
              fontSize: 'var(--text-sm)',
              color: 'var(--color-fg-subtle)',
            }}
          >
            {relay ? (
              <>
                Run this on the machine with a route out — the one the isolated network can reach.
                It fetches the relay from this instance, installs it, pairs, and starts serving.
              </>
            ) : zone ? (
              <>
                Run this on the isolated machine. Nothing in it touches this server: the script, the
                binary and the pairing all go through the relay, which is the only thing that
                machine can reach.
              </>
            ) : (
              <>
                Run this on the machine to monitor. It fetches the agent from this instance,
                installs it, and pairs — the agent receives its key <em>and</em> the probes it is
                meant to run, so there is no config to copy across.
              </>
            )}
          </p>

          <PairCommands
            origin={origin}
            pin={pair.data.pin}
            relay={relay}
            via={zone ? zoneOrigin || undefined : undefined}
          />

          {relay && (
            <p
              className="measure"
              style={{
                margin: 'var(--space-3) 0 0',
                fontSize: 'var(--text-sm)',
                color: 'var(--color-fg-subtle)',
              }}
            >
              {/*
                This paragraph used to say the opposite — that only the relay
                could mint a code for its own network, and that this server
                could not. That was true, and it made the third option above
                impossible: the one value the command needed was the one value
                this screen could not know.

                The relay now redeems a code from here against this server, over
                its own connection. What the zone machine ends up holding is
                unchanged, and that is the part that mattered: a key minted by
                the relay, worth nothing here.
              */}
              Once it is running, add machines behind it with{' '}
              <strong>An agent behind a relay</strong> above. They still never hold a key to this
              server — the relay redeems the code and issues one of its own.
            </p>
          )}

          <details style={{ marginTop: 'var(--space-3)' }}>
            <summary
              style={{
                cursor: 'pointer',
                fontSize: 'var(--text-sm)',
                color: 'var(--color-fg-muted)',
              }}
            >
              {/* Piping a URL into a shell deserves a way out of it. */}
              Rather not pipe a URL into a shell?
            </summary>
            <p
              className="measure"
              style={{
                margin: 'var(--space-2) 0',
                fontSize: 'var(--text-sm)',
                color: 'var(--color-fg-subtle)',
              }}
            >
              Open <code>{origin}/install.sh</code> and read it first — it is short and does nothing
              clever. Or download the binary yourself and pair by hand:
            </p>
            <CodeBlock label="by hand">
              {relay ? pair.data.proxyPairCommand : pair.data.pairCommand}
            </CodeBlock>
          </details>
          <p
            className="tabular"
            style={{
              margin: 'var(--space-2) 0 0',
              fontSize: 'var(--text-xs)',
              color: 'var(--color-fg-subtle)',
            }}
          >
            Single use, expires at {new Date(pair.data.expiresAt).toLocaleTimeString()}.
          </p>
          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
            <Button onClick={() => pair.mutate()}>Another PIN</Button>
            <Button onClick={onDone}>Done</Button>
          </div>
        </>
      ) : (
        <>
          <p
            className="measure"
            style={{
              margin: '0 0 var(--space-3)',
              fontSize: 'var(--text-sm)',
              color: 'var(--color-fg-subtle)',
            }}
          >
            Pairing exchanges a short PIN for a long-lived key, so no credential is ever copied by
            hand onto a host.
          </p>
          <Button variant="primary" busy={pair.isPending} onClick={() => pair.mutate()}>
            Generate a PIN
          </Button>
          {pair.isError && (
            <div style={{ marginTop: 'var(--space-2)' }}>
              <Banner tone="down">Could not generate a pairing code.</Banner>
            </div>
          )}
        </>
      )}
    </Card>
  )
}

/**
 * What the instance's own agent can and cannot see.
 *
 * The question this answers is "why is my check on localhost down", and it is
 * asked by someone who has no reason to know that the agent runs in a container
 * whose loopback is not the machine's. Left unsaid, the check simply fails and
 * the address looks right — the worst combination to debug.
 *
 * Stated, not offered as a control. `network_mode` is fixed when the container
 * is created; this process has no Docker socket to change it with, and giving
 * it one would be root on the host. A button here would be a button that lies.
 *
 * The blind spots are measured rather than assumed: with a shared namespace,
 * outbound to the internet and to the compose network works, `127.0.0.1` means
 * the API's container, and other Docker networks are cut off by bridge
 * isolation.
 */
function Vantage({ mode }: { mode: string }) {
  const host = mode === 'host'

  return (
    <details style={{ marginTop: 'var(--space-1)' }}>
      <summary
        style={{
          fontSize: 'var(--text-xs)',
          color: 'var(--color-fg-subtle)',
          cursor: 'pointer',
        }}
      >
        Measures from {host ? 'this machine' : 'inside its container'}
      </summary>
      <div
        style={{
          marginTop: 'var(--space-2)',
          fontSize: 'var(--text-xs)',
          color: 'var(--color-fg-subtle)',
          lineHeight: 1.6,
        }}
      >
        {host ? (
          <p style={{ margin: 0 }}>
            <strong>Can reach</strong> services on this machine — including those listening only on
            its loopback — its local network, other Docker networks, and the internet.{' '}
            <code>localhost</code> in a check means the machine.
          </p>
        ) : (
          <>
            <p style={{ margin: 0 }}>
              <strong>Can reach</strong> the internet and this instance&rsquo;s own containers.
            </p>
            <p style={{ margin: 'var(--space-2) 0 0' }}>
              <strong>Cannot reach</strong> services listening on this machine&rsquo;s loopback, or
              containers on other Docker networks. In a check, <code>localhost</code> means the
              agent&rsquo;s own container — not this machine — so a check written against it will
              fail however correct the address looks.
            </p>
            <p style={{ margin: 'var(--space-2) 0 0' }}>
              To measure from the machine instead, set these in <code>.env</code> and run{' '}
              <code>docker compose -f docker-compose.prod.yml up -d</code>. Linux only.
            </p>
            <pre
              style={{
                margin: 'var(--space-2) 0 0',
                padding: 'var(--space-2)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--color-bg-subtle)',
                overflowX: 'auto',
              }}
            >
              <code>
                TERN_AGENT_NETWORK_MODE=host{'\n'}
                TERN_LOCAL_AGENT_SERVER=http://127.0.0.1:$TERN_HTTP_PORT
              </code>
            </pre>
          </>
        )}
      </div>
    </details>
  )
}

/**
 * One machine in the fleet — and, for a relay, the machines behind it.
 *
 * Exported for the same reason `PairCommands` is: it can then be rendered
 * without a mutation, a click or a server, which is the only way to hold the
 * zone list to what it claims.
 */
export function AgentRow({
  slug,
  agent,
  zone = [],
  canWrite,
  selected,
  onSelect,
  picked,
  onPick,
  now,
}: {
  slug: string
  agent: Agent
  zone?: Agent[]
  canWrite: boolean
  selected: boolean
  onSelect: () => void
  picked: boolean
  onPick: () => void
  now: number
}) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(agent.name)
  const [site, setSite] = useState(agent.site ?? '')
  const [error, setError] = useState<string | null>(null)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['agents', slug] })

  const save = useMutation({
    mutationFn: () => adminApi.updateAgent(slug, agent.id, { name, site: site.trim() || null }),
    onSuccess: async () => {
      setEditing(false)
      setError(null)
      await invalidate()
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
  })

  const revoke = useMutation({
    mutationFn: () => adminApi.revokeAgent(slug, agent.id),
    onSuccess: () => invalidate(),
  })

  const [confirming, setConfirming] = useState(false)
  const [open, setOpen] = useState(false)
  // Open, unlike the probe list below it, and open even when the zone is empty.
  // Both things it holds are the reason a relay card is worth looking at: which
  // machines are behind this one, and how another is added. The second is
  // needed most precisely when the answer to the first is none — which is the
  // state this product shipped in, with nothing anywhere saying what to do
  // next. It still collapses, for whoever runs several.
  const [zoneOpen, setZoneOpen] = useState(true)
  const freshness = freshnessOf(agent, now)
  const revoked = agent.status === 'revoked'
  const relay = agent.role === 'proxy'

  return (
    <Card
      style={
        selected
          ? { borderColor: 'var(--color-accent)', boxShadow: 'var(--shadow-card)' }
          : undefined
      }
    >
      <div
        onClick={onSelect}
        style={{
          display: 'flex',
          gap: 'var(--space-3)',
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        {/* The instance's own agent is not selectable, because the only two
            bulk actions are revoke and delete and it accepts neither. Offering
            a checkbox that poisons the whole selection with a 409 would be a
            worse way to learn that. */}
        {canWrite && !agent.isLocal && (
          <input
            type="checkbox"
            checked={picked}
            aria-label={`Select ${agent.name}`}
            onClick={(event) => event.stopPropagation()}
            onChange={onPick}
            style={{ width: 20, height: 20, flexShrink: 0 }}
          />
        )}
        {canWrite && agent.isLocal && <span style={{ width: 20, flexShrink: 0 }} />}

        <span
          aria-hidden="true"
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            flexShrink: 0,
            background: revoked
              ? 'var(--color-fg-subtle)'
              : freshness === 'fresh'
                ? 'var(--status-operational)'
                : freshness === 'stale'
                  ? 'var(--status-degraded)'
                  : 'var(--status-down)',
          }}
        />

        <div style={{ minWidth: 0, flex: 1 }}>
          <strong style={{ textDecoration: revoked ? 'line-through' : undefined }}>
            {agent.name}
          </strong>
          {/* Said on the row rather than only in a tooltip on a missing button:
              "why can I not remove this one" is the question, and the answer is
              what it is, not what it lacks. */}
          {agent.isLocal && (
            <span
              title="Provisioned and run by this instance. Set TERN_LOCAL_AGENT=false to turn it off."
              style={{
                marginLeft: 'var(--space-2)',
                padding: '1px var(--space-2)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-fg-subtle)',
                fontSize: 'var(--text-xs)',
                fontWeight: 600,
                whiteSpace: 'nowrap',
              }}
            >
              this instance
            </span>
          )}
          {agent.role === 'proxy' && (
            // Named in the list as well as shaped in the diagram: a picture is
            // not something a screen reader works through, and this is the one
            // fact that changes what the row means.
            <span
              style={{
                marginLeft: 'var(--space-2)',
                fontSize: 'var(--text-xs)',
                padding: '2px var(--space-2)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--color-border-strong)',
                color: 'var(--color-fg-muted)',
              }}
            >
              proxy
            </span>
          )}
          <div
            className="tabular"
            style={{ fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}
          >
            {agent.site ?? 'no site'} · {agent.os ?? 'unknown OS'}
            {agent.arch ? `/${agent.arch}` : ''} · {agent.agentVersion ?? 'version unknown'} ·{' '}
            {/* The address it paired from. Stored since the table existed and
                never shown, which left "which box is this?" to be answered by
                guessing at hostnames. An agent known only through a proxy has
                none here: this server never saw it. */}
            {agent.pairedIp ? `${agent.pairedIp} · ` : ''}
            {lastSeen(agent, now)}
          </div>
          {agent.isLocal && agent.networkMode && <Vantage mode={agent.networkMode} />}
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          {/* The question a fleet screen is actually asked: what is this one
              doing? Answered here rather than by opening every control. */}
          <Button
            ariaLabel={`${open ? 'Hide' : 'Show'} the controls ${agent.name} runs`}
            onClick={() => setOpen((v) => !v)}
            disabled={agent.jobCount === 0}
          >
            {agent.jobCount === 0
              ? 'No probes'
              : `${open ? '▾' : '▸'} ${agent.jobCount} probe${agent.jobCount === 1 ? '' : 's'}`}
          </Button>
          {/* Never disabled, even at zero: an empty zone is the moment somebody
              needs to be told how one is joined, and a dead button says
              nothing. */}
          {relay && (
            <Button
              ariaLabel={`${zoneOpen ? 'Hide' : 'Show'} the agents behind ${agent.name}`}
              onClick={() => setZoneOpen((v) => !v)}
            >
              {zoneOpen ? '▾' : '▸'} {zone.length === 0 ? 'Empty zone' : `${zone.length} in zone`}
            </Button>
          )}
          {canWrite && !revoked && (
            <>
              <Button onClick={() => setEditing((v) => !v)}>{editing ? 'Cancel' : 'Rename'}</Button>
              {/* Renaming stays available — it is a label, and an operator
                  running several instances may well want to say which. Only
                  revoking is refused. */}
              {!agent.isLocal && (
                <Button variant="danger" onClick={() => setConfirming(true)}>
                  Revoke
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {open && agent.controls.length > 0 && (
        <ul
          style={{
            listStyle: 'none',
            margin: 'var(--space-3) 0 0',
            padding: 'var(--space-3) 0 0',
            borderTop: '1px solid var(--color-border)',
            display: 'grid',
            gap: 'var(--space-1)',
          }}
        >
          {agent.controls.map((control) => (
            <li
              key={control.id}
              style={{
                display: 'flex',
                gap: 'var(--space-3)',
                alignItems: 'baseline',
                fontSize: 'var(--text-sm)',
              }}
            >
              <span style={{ fontWeight: 600 }}>{control.name}</span>
              <code
                className="tabular"
                style={{ fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}
              >
                {control.key}
              </code>
            </li>
          ))}
        </ul>
      )}

      {relay && zoneOpen && (
        <div
          style={{
            marginTop: 'var(--space-3)',
            paddingTop: 'var(--space-3)',
            borderTop: '1px solid var(--color-border)',
            display: 'grid',
            gap: 'var(--space-3)',
          }}
        >
          {zone.length > 0 && (
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'grid',
                gap: 'var(--space-2)',
              }}
            >
              {zone.map((behind) => {
                const state = freshnessOf(behind, now)
                return (
                  <li
                    key={behind.id}
                    style={{
                      display: 'flex',
                      gap: 'var(--space-3)',
                      alignItems: 'center',
                      fontSize: 'var(--text-sm)',
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        flexShrink: 0,
                        background:
                          state === 'fresh'
                            ? 'var(--status-operational)'
                            : state === 'stale'
                              ? 'var(--status-degraded)'
                              : 'var(--status-down)',
                      }}
                    />
                    <span style={{ fontWeight: 600, minWidth: 0 }}>{behind.name}</span>
                    <span
                      className="tabular"
                      style={{ fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}
                    >
                      {behind.jobCount === 0
                        ? 'no probes'
                        : `${behind.jobCount} probe${behind.jobCount === 1 ? '' : 's'}`}{' '}
                      · {lastSeen(behind, now)}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}

          {/* Said once, here, rather than left to be discovered: these rows
              carry no Rename and no Revoke, and the reason is the same reason
              the zone is safe. */}
          <p
            style={{
              margin: 0,
              fontSize: 'var(--text-xs)',
              color: 'var(--color-fg-subtle)',
              lineHeight: 1.6,
            }}
          >
            {zone.length > 0 && (
              <>
                This server never paired these, so it holds no key for them and cannot rename or
                revoke them — the relay does, and rewrites this list every time it reports.{' '}
              </>
            )}
            TERN cannot mint a PIN for a zone. The relay issues its own, on its own machine, which
            is what keeps a compromised host in the zone from ever holding a credential for this
            server. To add an agent behind this relay, run there:
          </p>
          <CodeBlock label={`On ${agent.name}`}>
            tern-proxy pin --config /etc/tern/proxy.toml
          </CodeBlock>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 'var(--space-2)' }}>
          <Banner tone="down">{error}</Banner>
        </div>
      )}

      {editing && (
        <div className="field-row" style={{ gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
          <Field label="Name" hint="What the people running it call it.">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Site" hint="Data centre, customer, region — your words.">
            <Input value={site} onChange={(e) => setSite(e.target.value)} />
          </Field>
          <div>
            <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          </div>
        </div>
      )}

      {confirming && (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <Banner tone="down">
            {/* Named, and not undoable — revoking kills the key with the record,
                so the agent stops being able to push at all. */}
            Revoke “{agent.name}”? Its key is revoked too, so it stops reporting immediately and
            must be paired again.
          </Banner>
          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
            <Button variant="danger" busy={revoke.isPending} onClick={() => revoke.mutate()}>
              Revoke it
            </Button>
            <Button onClick={() => setConfirming(false)}>Keep it</Button>
          </div>
        </div>
      )}
    </Card>
  )
}

function lastSeen(agent: Agent, now: number): string {
  if (agent.status === 'revoked') return 'revoked'
  if (!agent.lastSeenAt) return 'never reported'

  const minutes = Math.floor((now - Date.parse(agent.lastSeenAt)) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

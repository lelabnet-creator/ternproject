import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Agent } from '../../lib/adminApi'

Object.defineProperty(globalThis, 'window', {
  value: { location: { origin: 'https://status.example.com' } },
  configurable: true,
})

const { AgentRow, rootsOf, zonesOf } = await import('./FleetScreen')

/**
 * A relay and the machines behind it.
 *
 * The server had been sending this all along — an agent a relay declared
 * carries that relay's id — and the admin never read it. So "which machines are
 * behind this proxy" was a question the fleet screen could not answer, while
 * the diagram beside it drew the answer.
 */

function agent(over: Partial<Agent> & { id: string; name: string }): Agent {
  return {
    hostname: null,
    os: 'linux',
    arch: 'x86_64',
    agentVersion: '0.1.13',
    site: null,
    role: 'agent',
    parentAgentId: null,
    pairedIp: null,
    status: 'active',
    lastSeenAt: new Date().toISOString(),
    pairedAt: new Date().toISOString(),
    jobCount: 0,
    controls: [],
    scopeControlIds: [],
    isLocal: false,
    networkMode: null,
    ...over,
  }
}

const relay = agent({ id: 'r1', name: 'tern-proxy', role: 'proxy', pairedIp: '192.168.64.1' })
const behind = [
  agent({ id: 'a1', name: 'machine-A', parentAgentId: 'r1', jobCount: 6 }),
  agent({ id: 'a2', name: 'machine-B', parentAgentId: 'r1', jobCount: 1 }),
]
const direct = agent({ id: 'd1', name: 'fractal', pairedIp: '10.0.0.4' })

function render(node: Parameters<typeof renderToStaticMarkup>[0]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

describe('grouping the fleet', () => {
  const all = [relay, ...behind, direct]

  it('puts each zone agent under the relay that declared it', () => {
    const zones = zonesOf(all)
    expect(zones.get('r1')?.map((a) => a.name)).toEqual(['machine-A', 'machine-B'])
    expect(zones.has('d1')).toBe(false)
  })

  it('lists a machine once, not twice', () => {
    // Listed at the top level as well, a zone agent would make the fleet look
    // bigger than it is and would sit next to a Rename and a Revoke that
    // neither verb can act on.
    expect(rootsOf(all).map((a) => a.name)).toEqual(['tern-proxy', 'fractal'])
  })

  it('never makes a machine disappear, even with its relay missing', () => {
    // A relay this server has not got — revoked and deleted, say — used to be
    // the whole justification for not nesting at all. An orphan stays visible
    // at the top level instead: nothing should be able to remove a machine from
    // the one screen that says which machines exist.
    const orphaned = [agent({ id: 'a9', name: 'stranded', parentAgentId: 'gone' })]
    expect(rootsOf(orphaned).map((a) => a.name)).toEqual(['stranded'])
  })
})

describe('the relay card', () => {
  const html = render(
    <AgentRow
      slug="acme"
      agent={relay}
      zone={behind}
      canWrite={true}
      selected={false}
      onSelect={() => {}}
      picked={false}
      onPick={() => {}}
      now={Date.now()}
    />,
  )

  it('shows the machines and what each is measuring', () => {
    expect(html).toContain('machine-A')
    expect(html).toContain('machine-B')
    expect(html).toContain('6 probes')
    // Singular, because "1 probes" on a status page is the kind of detail that
    // makes a reader trust the rest of it less.
    expect(html).toContain('1 probe')
    expect(html).not.toContain('1 probes')
  })

  it('says why these rows cannot be renamed or revoked', () => {
    // The buttons are absent by design — this server holds no key for them.
    // An absence with no explanation reads as a bug.
    expect(html).toContain('never paired these')
  })

  it('says where a zone PIN comes from, and why it cannot come from here', () => {
    // The limit that makes the zone safe, and the command that works with it.
    // Without this the screen offers no way at all to add an agent behind a
    // relay, which is what it looked like before.
    expect(html).toContain('cannot mint a PIN for a zone')
    expect(html).toContain('tern-proxy pin')
  })
})

describe('a relay with nobody behind it', () => {
  const html = render(
    <AgentRow
      slug="acme"
      agent={relay}
      zone={[]}
      canWrite={true}
      selected={false}
      onSelect={() => {}}
      picked={false}
      onPick={() => {}}
      now={Date.now()}
    />,
  )

  it('opens on the instructions rather than on nothing', () => {
    // An empty zone is exactly when somebody needs to be told how one is
    // joined, so the button stays live and the explanation is what it holds.
    expect(html).toContain('Empty zone')
    expect(html).toContain('tern-proxy pin')
    expect(html).not.toContain('never paired these')
  })
})

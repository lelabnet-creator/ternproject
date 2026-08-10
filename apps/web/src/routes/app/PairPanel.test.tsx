import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Agent } from '../../lib/adminApi'

/*
 * Two relays, so the picker has something to pick between — and so the case
 * that matters is covered: telling apart two machines whose names came from
 * their hostnames.
 */
const RELAYS: Partial<Agent>[] = [
  { id: 'r1', name: 'dmz-proxy', role: 'proxy', pairedIp: '192.168.10.4', status: 'active' },
  { id: 'r2', name: 'dmz-proxy', role: 'proxy', pairedIp: '192.168.20.9', status: 'active' },
  { id: 'a1', name: 'an-agent', role: 'agent', pairedIp: '10.0.0.2', status: 'active' },
]

/*
 * The panel reads `window.location.origin` — the installer is served by the
 * same instance the browser is already talking to, so the address is not a
 * setting. These tests run in node, which has no window, so it is stubbed
 * before the module is imported. Same shape as the storage stub in
 * `lib/sandbox.test.ts`, for the same reason.
 */
Object.defineProperty(globalThis, 'window', {
  value: { location: { origin: 'https://status.example.com' } },
  configurable: true,
})

const { PairPanel, PairCommands, RelayPicker } = await import('./FleetScreen')

/**
 * Adding a relay from the same panel that adds an agent.
 *
 * Before this, the admin could draw a proxy and offer no way to install one —
 * the only affordance in the whole product was an undocumented `--proxy` flag
 * in the installer, which then refused to finish the job.
 *
 * A static render, which is what this repo tests components with. What it pins
 * is the wording and the commands, which is most of what this panel is.
 */

function render(node: Parameters<typeof renderToStaticMarkup>[0]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

describe('before a PIN exists', () => {
  const html = render(<PairPanel slug="acme" onDone={() => {}} />)

  it('offers both, and says what each one is', () => {
    expect(html).toContain('An agent')
    expect(html).toContain('A relay')
    // Two words on a button do not distinguish a thing that measures from a
    // thing that relays, and choosing wrong is discovered at the far end of an
    // install.
    expect(html).toContain('measures from the machine it runs on')
  })

  it('starts on the agent, which is what nearly everyone is adding', () => {
    expect(html).toContain('aria-pressed="true"')
    expect(html).not.toContain('no route out')
  })
})

/**
 * The commands themselves, rendered without a mutation or a server.
 *
 * This is what the role choice is for, and the failure it guards is one-sided:
 * `--proxy` on the wrong line installs a relay where somebody wanted an agent,
 * and they learn it at the far end of an install rather than here.
 */
describe('the one-liners', () => {
  const agent = renderToStaticMarkup(
    <PairCommands origin="https://status.example.com" pin="4K7Q-92XB" relay={false} />,
  )
  const relay = renderToStaticMarkup(
    <PairCommands origin="https://status.example.com" pin="4K7Q-92XB" relay={true} />,
  )

  it('adds the flag only for a relay', () => {
    expect(agent).not.toContain('--proxy')
    expect(agent).not.toContain('-Proxy')
    expect(relay).toContain('--proxy')
    expect(relay).toContain('-Proxy')
  })

  it('carries the same PIN either way', () => {
    // The code does not choose the role — the server infers it from the version
    // the binary announces. Changing one's mind must cost a click, not a PIN.
    expect(agent).toContain('4K7Q-92XB')
    expect(relay).toContain('4K7Q-92XB')
  })

  it('keeps both platforms in both roles', () => {
    for (const html of [agent, relay]) {
      expect(html).toContain('install.sh')
      expect(html).toContain('install.ps1')
    }
  })

  it('never writes the flag twice, or on the wrong script', () => {
    // `sh -s -- --proxy --pin …` has one `--proxy`; a second would be a paste
    // error nobody reads closely enough to catch.
    expect(relay.match(/--proxy/g)).toHaveLength(1)
    expect(relay.match(/-Proxy/g)).toHaveLength(1)
  })
})

/**
 * The command for a machine that cannot reach this server at all.
 *
 * The one that could not exist until a code minted here could be redeemed by
 * the relay: its only missing value was the one this screen had no way to know.
 */
describe('a machine behind a relay', () => {
  const html = renderToStaticMarkup(
    <PairCommands
      origin="https://status.example.com"
      pin="4K7Q-92XB"
      relay={false}
      via="http://192.168.10.4:8787"
    />,
  )

  it('takes everything from the relay, not from here', () => {
    // All three at once, and that is the point: the script, the binary behind
    // it, and the address written into the config. A command that moved only
    // one of them would fail at whichever step it forgot, on a machine nobody
    // is standing in front of.
    expect(html).toContain('curl -fsSL http://192.168.10.4:8787/install.sh')
    expect(html).toContain('--server http://192.168.10.4:8787')
    expect(html).not.toContain('status.example.com')
  })

  it('carries the PIN this server minted', () => {
    // The whole change in one line: the code comes from here, the key will come
    // from the relay.
    expect(html).toContain('4K7Q-92XB')
  })

  it('installs an agent, never a relay', () => {
    // `--proxy` here would put a second relay inside the zone, which is a
    // mistake found at the far end of an install.
    expect(html).not.toContain('--proxy')
    expect(html).not.toContain('-Proxy')
  })

  it('does the same on Windows', () => {
    expect(html).toContain('irm http://192.168.10.4:8787/install.ps1')
    expect(html).toContain('-Server http://192.168.10.4:8787')
  })

  it('leaves the direct command untouched', () => {
    // No `via`, no `--server`: an ordinary agent is told nothing about relays.
    const direct = renderToStaticMarkup(
      <PairCommands origin="https://status.example.com" pin="4K7Q-92XB" relay={false} />,
    )
    expect(direct).not.toContain('--server')
    expect(direct).toContain('curl -fsSL https://status.example.com/install.sh')
  })
})

/**
 * Choosing the relay from a list rather than typing its address.
 *
 * Rendered directly, because the panel opens on "An agent" and a static render
 * cannot click the third option. A test that could not reach the thing it names
 * would assert nothing — which is what the first version of this did.
 */
describe('picking a relay', () => {
  const html = renderToStaticMarkup(
    <RelayPicker
      relays={RELAYS.filter((r) => r.role === 'proxy') as Agent[]}
      chosenId="r2"
      origin="http://192.168.20.9:8787"
      onPick={() => {}}
      onAddress={() => {}}
    />,
  )

  it('tells apart two relays that share a name', () => {
    // They are named after their hosts, so this is the ordinary case rather
    // than the odd one — and the address is the only thing separating them.
    expect(html).toContain('192.168.10.4')
    expect(html).toContain('192.168.20.9')
    expect(html.match(/dmz-proxy/g)).toHaveLength(2)
  })

  it('shows the one that is chosen, not the first in the list', () => {
    // A picker that displays r1 while the command is built from r2 installs
    // into the wrong zone and looks right doing it.
    expect(html).toContain('value="r2"')
    expect(html).toContain('http://192.168.20.9:8787')
  })

  it('says when it has no address to offer', () => {
    const unknown = renderToStaticMarkup(
      <RelayPicker
        relays={[{ id: 'x', name: 'silent', role: 'proxy', pairedIp: null } as Agent]}
        chosenId="x"
        origin=""
        onPick={() => {}}
        onAddress={() => {}}
      />,
    )
    // Rather than an empty dash, which reads as a rendering fault.
    expect(unknown).toContain('address unknown')
  })
})

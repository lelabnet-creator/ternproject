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

const { PairPanel, PairCommands, RelayPicker, relayOrigins } = await import('./FleetScreen')

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

  /*
   * The two commands are alternatives, not a checklist, so they are tabs. What
   * that must not cost: the one you are not looking at is still in the page —
   * `hidden`, not deleted — so it can be found by searching, and so this file
   * can keep asserting both without driving a click.
   */
  it('offers the two systems as tabs, one of them chosen', () => {
    expect(agent).toContain('role="tablist"')
    expect(agent).toContain('Linux or macOS')
    expect(agent).toContain('Windows')
    expect(agent.match(/aria-selected="true"/g)).toHaveLength(1)
  })

  it('shows the chosen command and hides the other', () => {
    const unix = renderToStaticMarkup(
      <PairCommands origin="https://status.example.com" pin="4K7Q-92XB" relay={false} os="unix" />,
    )
    const windows = renderToStaticMarkup(
      <PairCommands
        origin="https://status.example.com"
        pin="4K7Q-92XB"
        relay={false}
        os="windows"
      />,
    )

    // The hidden attribute lands on the panel holding the command *not* chosen.
    // Anchored on the script name so this reads as "PowerShell is the hidden
    // one", which is the thing that would break.
    expect(unix).toMatch(/<div hidden="">.*install\.ps1/s)
    expect(unix).not.toMatch(/<div hidden="">.*install\.sh.*<\/div>.*install\.ps1/s)
    expect(windows).toMatch(/<div hidden="">.*install\.sh/s)
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
      candidates={['http://192.168.20.9:8787', 'http://10.8.0.3:8787']}
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
        candidates={[]}
        onPick={() => {}}
        onAddress={() => {}}
      />,
    )
    // Rather than an empty dash, which reads as a rendering fault.
    expect(unknown).toContain('address unknown')
  })
})

/**
 * The port a relay serves its zone on.
 *
 * 38787 is the default; another is needed on a machine where it is taken — a second relay on one machine, a host where
 * something already answers there — and the flag has to reach the command or
 * the choice is decorative.
 */
describe('a relay on another port', () => {
  it('carries the port, and only for a relay', () => {
    const relay = renderToStaticMarkup(
      <PairCommands origin="https://s.example" pin="4K7Q-92XB" relay={true} port="9443" />,
    )
    expect(relay).toContain('--port 9443')
    expect(relay).toContain('-Port 9443')

    // An agent serves nothing, so the flag would be refused by the binary.
    const agent = renderToStaticMarkup(
      <PairCommands origin="https://s.example" pin="4K7Q-92XB" relay={false} port="9443" />,
    )
    expect(agent).not.toContain('--port')
  })

  it('says nothing when it is the default', () => {
    // A flag restating a default is one more thing to read on a line already
    // long enough to be pasted wrong.
    const html = renderToStaticMarkup(
      <PairCommands origin="https://s.example" pin="4K7Q-92XB" relay={true} port="38787" />,
    )
    expect(html).not.toContain('--port')
  })
})

/**
 * Which addresses a relay is offered at.
 *
 * The whole point is that this stopped being a guess: the relay says where it
 * can be dialled, and `pairedIp` — where a connection arrived from, as this
 * server saw it — is a last resort that is wrong on a containerised instance.
 */
describe('the addresses offered for a relay', () => {
  const at = (over: Partial<Agent>) =>
    relayOrigins({ zoneAddress: null, zoneAddresses: [], pairedIp: null, ...over } as Agent)

  it('puts where it binds first, then everywhere else it answers', () => {
    expect(
      at({ zoneAddress: '192.168.1.170:38787', zoneAddresses: ['192.168.1.170', '10.8.0.3'] }),
    ).toEqual(['http://192.168.1.170:38787', 'http://10.8.0.3:38787'])
  })

  it('keeps the port it actually binds', () => {
    // A relay moved off 8787 must not be offered at 8787.
    expect(at({ zoneAddress: '10.0.0.5:9443', zoneAddresses: ['10.0.0.5'] })).toEqual([
      'http://10.0.0.5:9443',
    ])
  })

  it('offers real addresses when it binds every interface', () => {
    // `0.0.0.0` is not something anybody can dial, so it is never offered.
    expect(at({ zoneAddress: '0.0.0.0:38787', zoneAddresses: ['192.168.1.170'] })).toEqual([
      'http://192.168.1.170:38787',
    ])
  })

  it('falls back to the paired address only when it has nothing else', () => {
    // The case that caused this: a Docker bridge gateway, offered as the way to
    // reach a relay, on the one machine that could not investigate.
    expect(at({ pairedIp: '192.168.64.1' })).toEqual(['http://192.168.64.1:38787'])
    expect(at({ zoneAddresses: ['10.0.0.9'], pairedIp: '192.168.64.1' })).toEqual([
      'http://10.0.0.9:38787',
    ])
  })
})

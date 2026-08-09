import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

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

const { PairPanel, PairCommands } = await import('./FleetScreen')

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

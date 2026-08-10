import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { defaultBlocks, type Block } from '@tern/shared/blocks'
import { initI18n } from '../../i18n'
import type { StatusSummary } from '../../lib/api'
import { StatusPage } from './StatusPage'

/**
 * The page reads two globals while it renders — the query string, for the
 * editor's preview, and `navigator.onLine`, for the offline banner. Neither
 * exists in a node environment, and a missing `onLine` reads as offline, which
 * would put a banner in every expectation below.
 *
 * At module scope rather than in `beforeAll`: the renders below happen while
 * the suites are being collected, which is earlier than any hook runs.
 */
Object.defineProperty(globalThis, 'window', {
  value: { location: { search: '' } },
  configurable: true,
  writable: true,
})
Object.defineProperty(globalThis, 'navigator', {
  value: { onLine: true },
  configurable: true,
  writable: true,
})

// The real strings, so the assertions below read like the page rather than like
// its translation keys.
initI18n('en')

/**
 * What `custom` means, asserted on the page rather than on the schema.
 *
 * The complaint this answers: choosing Custom used to leave TERN's page in
 * place — header, ring, subscribe box, card frame — with a hole cut in the
 * middle for the tenant. The arrangement was a sub-element of the page. So the
 * load-bearing assertions here are about what is *absent* from the custom
 * shell, which is the half a schema test cannot see.
 *
 * Rendered rather than reasoned about, and rendered through the real component:
 * a test that re-derived the shell would agree with itself no matter what the
 * page did.
 */

const SLUG = 'acme'

const summary = {
  tenant: {
    slug: SLUG,
    name: 'Acme Corp',
    retentionMode: 'historical',
    retentionDays: 90,
    defaultLocale: 'en',
    defaultTimezone: 'UTC',
    subscriberDisclaimer: null,
    layout: 'list',
    isDemo: false,
    readOnly: false,
    custom: null,
    customBlocks: [],
    branding: {},
  },
  overall: { status: 'operational', affectedCount: 0 },
  groups: [],
  components: [
    {
      id: 'c1',
      key: 'api',
      name: 'Public API',
      description: null,
      groupId: null,
      status: 'operational',
      widget: 'uptime-ribbon',
      widgetOptions: {},
      latencyMs: 12,
      value: null,
      valueUnit: null,
      valueLabel: null,
      lastCheckAt: '2026-08-10T12:00:00.000Z',
    },
  ],
  incidents: [],
  maintenances: [],
  generatedAt: '2026-08-10T12:00:00.000Z',
} as unknown as StatusSummary

function render(tenant: Partial<StatusSummary['tenant']>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const data = { ...summary, tenant: { ...summary.tenant, ...tenant } }
  // Seeded rather than fetched: this asserts the shell, not the transport.
  client.setQueryData(['summary', SLUG], data)

  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <StatusPage slug={SLUG} />
    </QueryClientProvider>,
  )
}

const arranged = (blocks: Block[]) => render({ layout: 'custom', customBlocks: blocks })

describe('the default page', () => {
  const html = render({ layout: 'list' })

  it('draws TERN’s card around everything it reports', () => {
    expect(html).toContain('page-card')
  })

  it('keeps the theme control and the way back inside its header', () => {
    // Where they have always been. The custom shell moves them out; this is the
    // page they moved out of.
    expect(html).toContain('Manage this page')
    expect(html.indexOf('Manage this page')).toBeLessThan(html.indexOf('data-tern="components"'))
  })

  it('names the page and shows a component', () => {
    expect(html).toContain('Acme Corp')
    expect(html).toContain('Public API')
  })
})

describe('the custom page', () => {
  const html = arranged(defaultBlocks())

  it('is the arrangement, with no card of ours around it', () => {
    // The whole complaint, in one assertion: `custom` is not a panel inside
    // TERN's page. If this card comes back, so does the hole in the middle.
    expect(html).not.toContain('page-card')
    expect(html).toContain('data-tern="arrangement"')
  })

  it('draws the header from a block rather than above the arrangement', () => {
    const header = html.indexOf('data-tern="header"')
    expect(header).toBeGreaterThan(html.indexOf('data-tern="arrangement"'))
    expect(html).toContain('Acme Corp')
  })

  it('still gives the reader a theme control and a way back', () => {
    // Outside the arrangement on purpose: a header dragged to the foot of the
    // page would otherwise take the theme toggle with it.
    expect(html).toContain('data-tern="utility"')
    expect(html).toContain('Manage this page')
  })

  it('still says who built it', () => {
    expect(html).toContain('data-tern-guard')
  })

  it('carries the tenant’s stylesheet when there is one', () => {
    const styled = render({
      layout: 'custom',
      customBlocks: defaultBlocks(),
      custom: { css: '[data-tern="page"]{--color-accent:#f0f}' },
    })
    expect(styled).toContain('data-tern-tenant-style')
    expect(styled).toContain('--color-accent:#f0f')
    // And the guard after it, or the stylesheet could hide what it is not
    // allowed to hide.
    expect(styled.indexOf('data-tern-tenant-style')).toBeLessThan(
      styled.indexOf('data-tern-guard-style'),
    )
  })

  it('adds no stylesheet element for a tenant who wrote none', () => {
    expect(html).not.toContain('data-tern-tenant-style')
  })
})

describe('what an arrangement cannot take away', () => {
  const decorationOnly: Block[] = [
    { type: 'text', id: 't', body: 'Hello', style: 'body', x: 0, y: 0, w: 12, h: 1 },
  ]

  it('draws the components when no block claims them', () => {
    // A status page that reports no status is not one. Absence of the block is
    // what brings them back — the same rule the incidents have always had.
    expect(arranged(decorationOnly)).toContain('Public API')
  })

  it('draws them once when a block does claim them', () => {
    const html = arranged(defaultBlocks())
    expect(html.split('Public API')).toHaveLength(2)
  })

  it('falls back to the default page when nothing was ever arranged', () => {
    // Pages that were `custom` before any of this existed. Drawing nothing for
    // them would lose the header, the ring and the components at once.
    const html = arranged([])
    expect(html).toContain('data-tern="header"')
    expect(html).toContain('Public API')
  })
})

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ImportScreen, IssueList, Preview } from './ImportScreen'
import type { IssueRow } from './issues'

/**
 * What the screen says before anything is typed, and what it says about a file
 * it has refused.
 *
 * A static render, because the repo has no DOM in tests — so what is checked
 * here is the wording and the shape, which is most of what this screen is. The
 * behaviour that needs a browser (paste, debounce, preview, import) is covered
 * end to end in `e2e/controls.spec.ts`.
 */

function render(node: Parameters<typeof renderToStaticMarkup>[0]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

describe('ImportScreen, empty', () => {
  const html = render(<ImportScreen slug="acme" onCancel={() => {}} onImported={() => {}} />)

  it('offers both ways in — a file, or the box', () => {
    expect(html).toContain('type="file"')
    expect(html).toContain('<textarea')
  })

  it('refuses to send nothing', () => {
    // Both actions are disabled until there is something to act on; an empty
    // import would answer 400 for a reason nobody needed to be told.
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2)
    expect(html).toContain('Nothing to import yet.')
  })

  it('says what an import does before it is asked to do it', () => {
    // Idempotence and leaving-alone are the two properties somebody has to
    // believe before pasting a file over a live estate.
    expect(html).toContain('changes nothing the second time')
    expect(html).toContain('is left alone')
  })
})

const rows: IssueRow[] = [
  {
    line: 6,
    path: 'controls[0].config.timeout_ms',
    key: 'api',
    message: 'Unknown field "timeout_ms"',
    expected: 'one of url, method, timeoutMs',
  },
  {
    line: 12,
    path: 'controls[1].degradedThresholdMs',
    key: 'db',
    message: 'Must be below downThresholdMs (3000)',
    received: '5000',
  },
]

describe('IssueList', () => {
  it('gives every problem its own line number and path', () => {
    const html = renderToStaticMarkup(<IssueList rows={rows} fromServer={false} />)
    expect(html).toContain('line 6')
    expect(html).toContain('controls[0].config.timeout_ms')
    expect(html).toContain('line 12')
    expect(html).toContain('2 problems in the file.')
  })

  it('says found and expected only where there is one', () => {
    const html = renderToStaticMarkup(<IssueList rows={rows} fromServer={false} />)
    expect(html).toContain('expected one of url, method, timeoutMs')
    expect(html).toContain('found 5000')
    expect(html).not.toContain('found undefined')
  })

  it('distinguishes a refusal that happened from one that would', () => {
    // The server has already declined to write; the local check is a warning
    // about a request not yet made, and saying "nothing was imported" there
    // would claim an attempt nobody made.
    expect(renderToStaticMarkup(<IssueList rows={rows} fromServer={true} />)).toContain(
      'Nothing was imported.',
    )
    expect(renderToStaticMarkup(<IssueList rows={rows} fromServer={false} />)).toContain(
      'Fix these before importing.',
    )
  })

  it('counts one problem in the singular', () => {
    const html = renderToStaticMarkup(<IssueList rows={[rows[0]!]} fromServer={true} />)
    expect(html).toContain('One problem in the file.')
  })
})

describe('Preview', () => {
  const html = renderToStaticMarkup(
    <Preview
      outcome={{
        dryRun: true,
        created: 2,
        updated: 1,
        groupsCreated: 1,
        controls: [
          { key: 'api.gateway', action: 'created' },
          { key: 'api.auth', action: 'created' },
          { key: 'db.primary', action: 'updated' },
        ],
      }}
    />,
  )

  it('says plainly that nothing happened', () => {
    expect(html).toContain('nothing was written')
  })

  it('counts what would, and names each one', () => {
    expect(html).toContain('2 created')
    expect(html).toContain('1 updated')
    expect(html).toContain('1 folder created')
    expect(html).toContain('db.primary')
  })
})

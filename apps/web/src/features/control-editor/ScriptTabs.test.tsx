import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ScriptTabs } from './ScriptTabs'

/**
 * Step 4 of the control editor.
 *
 * What is pinned here is an ordering decision, which is the kind that gets
 * undone by accident: the agent opens first. A pushed script suits a batch job
 * or a CI step, but the product's answer to "watch this thing" is an agent, and
 * opening on Python made the scripting path look like the intended one.
 *
 * A static render, which is how this repo tests components. The query cache is
 * seeded rather than fetched — `renderToStaticMarkup` gives an effect no chance
 * to resolve, so an unseeded render only ever reaches "Loading scripts…".
 */

const BUNDLE = {
  languages: [
    { id: 'python', label: 'Python', extension: 'py', syntax: 'python' },
    { id: 'powershell', label: 'PowerShell', extension: 'ps1', syntax: 'powershell' },
    { id: 'bash', label: 'Bash', extension: 'sh', syntax: 'bash' },
  ],
  scripts: { python: 'print("hi")', powershell: 'Write-Host', bash: 'echo hi' },
  agent: { toml: '[[probes]]\ntype = "http"' },
}

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['scripts', 'acme', 'c1', undefined], BUNDLE)
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ScriptTabs slug="acme" controlId="c1" />
    </QueryClientProvider>,
  )
}

describe('the script step', () => {
  const html = render()

  it('opens on the agent, and puts it first', () => {
    expect(html).toContain('Agent (Rust)')

    // First in the strip, not merely present. The previous layout had it last,
    // after six languages, where it read as an afterthought.
    const agentAt = html.indexOf('Agent (Rust)')
    const pythonAt = html.indexOf('>Python<')
    expect(agentAt).toBeGreaterThan(-1)
    expect(pythonAt).toBeGreaterThan(-1)
    expect(agentAt).toBeLessThan(pythonAt)
  })

  it('marks the agent tab selected and every other one not', () => {
    // The assertion that would catch "moved to the front but still opens on
    // Python", which looks correct in a screenshot.
    const selected = html.match(/aria-selected="true"/g) ?? []
    expect(selected).toHaveLength(1)

    const agentTab = html.slice(html.indexOf('id="script-tab-agent"'))
    expect(agentTab.slice(0, 200)).toContain('aria-selected="true"')
  })

  it('gives the strip one tab stop rather than one per language', () => {
    /*
     * The keyboard contract `role="tablist"` promises. It was declared before
     * this change and not honoured: every tab was reachable with Tab, which is
     * precisely what the role exists to avoid. One stop, arrows within.
     */
    const stops = html.match(/tabindex="0"/gi) ?? []
    const skipped = html.match(/tabindex="-1"/gi) ?? []
    expect(stops).toHaveLength(1)
    expect(skipped).toHaveLength(BUNDLE.languages.length)
  })
})

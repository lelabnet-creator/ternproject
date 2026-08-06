import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { adminApi } from '../../lib/adminApi'
import { Banner, Button, CodeBlock } from '../../components/ui'

/**
 * Step 4 of the editor: the script, ready to run.
 *
 * All ten languages arrive together and are shown as tabs. Someone who works in
 * Perl should not have to discover that Perl is on offer, and generating on
 * demand would make switching tabs feel like waiting.
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

  const [active, setActive] = useState<string>('python')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  if (bundle.isPending) return <p style={{ color: 'var(--color-fg-subtle)' }}>Loading scripts…</p>
  if (bundle.isError || !bundle.data) {
    return <Banner tone="down">Could not generate the scripts.</Banner>
  }

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

      <div
        role="tablist"
        aria-label="Script language"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}
      >
        {bundle.data.languages.map((lang) => {
          const selected = lang.id === active
          return (
            <button
              key={lang.id}
              role="tab"
              aria-selected={selected}
              onClick={() => setActive(lang.id)}
              style={{
                background: selected ? 'var(--color-accent)' : 'transparent',
                color: selected ? 'var(--color-accent-fg)' : 'var(--color-fg-muted)',
                border: `1px solid ${selected ? 'transparent' : 'var(--color-border)'}`,
                borderRadius: 'var(--radius-full)',
                padding: '0 var(--space-3)',
                minHeight: 36,
                fontSize: 'var(--text-sm)',
                fontWeight: 600,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              {lang.label}
            </button>
          )
        })}
      </div>

      <CodeBlock label={`tern_push.${language?.extension ?? 'txt'}`}>{script}</CodeBlock>

      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <Button
          variant="primary"
          onClick={() => {
            void navigator.clipboard.writeText(script).then(() => setCopied(true))
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
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
        Every script reads <code>TERN_API_KEY</code> from the environment first, so the file itself
        is safe to commit.
      </p>
    </div>
  )
}

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BADGE_STYLES, BADGE_STYLE_INFO, type BadgeStyle } from '@tern/shared/badges'
import { adminApi } from '../../lib/adminApi'
import { Banner, Button, Card, CodeBlock, CopyButton, Field, Input } from '../../components/ui'

/**
 * The badges, offered rather than merely served.
 *
 * The renderer has always been there; nothing in the admin said so, showed a
 * URL, or previewed one. Every preview here is an `<img>` pointed at the real
 * endpoint, so what an operator picks from is what the badge will actually look
 * like on their page — a hand-drawn imitation is a second renderer free to
 * drift from the first.
 */
export function BadgesPanel({ slug }: { slug: string }) {
  const controls = useQuery({
    queryKey: ['controls', slug],
    queryFn: () => adminApi.controls(slug),
  })

  const [style, setStyle] = useState<BadgeStyle>('flat')
  const [target, setTarget] = useState<'overall' | string>('overall')
  const [label, setLabel] = useState('')

  // Only public controls: a badge is embedded on a page anyone can read, and
  // offering one for an internal component invites publishing it by accident.
  const publicControls = (controls.data ?? []).filter((c) => c.isPublic)
  const control = publicControls.find((c) => c.key === target)

  const path =
    target === 'overall'
      ? `/badge/${encodeURIComponent(slug)}.svg`
      : `/badge/${encodeURIComponent(slug)}/${encodeURIComponent(target)}.svg`

  const query = new URLSearchParams({ style })
  if (label.trim() !== '') query.set('label', label.trim())

  const relative = `${path}?${query.toString()}`
  const absolute = `${window.location.origin}${relative}`
  const alt = `${label.trim() || control?.name || slug} status`
  // `/s/<slug>`, which is the address the router matches. Without the `/s`
  // every snippet this panel hands out linked to the landing page instead of
  // the status page it was advertising.
  const pageUrl = `${window.location.origin}/s/${encodeURIComponent(slug)}`

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <Card>
        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <h2 style={{ margin: 0, fontSize: 'var(--text-base)' }}>Status badges</h2>
          <p className="measure" style={{ margin: 0, color: 'var(--color-fg-subtle)' }}>
            An SVG served from this instance, for a README, a docs page or an intranet. It needs no
            JavaScript on the host page, it cannot run anything there, and it is readable to a
            screen reader — every style spells the status out rather than leaving it to the colour.
          </p>
        </div>
      </Card>

      <Card>
        <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
          <h3 style={{ margin: 0, fontSize: 'var(--text-sm)' }}>What it reports</h3>

          <fieldset
            style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 'var(--space-2)' }}
          >
            <legend style={{ fontSize: 'var(--text-sm)', fontWeight: 600, padding: 0 }}>
              Subject
            </legend>
            <label style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <input
                type="radio"
                name="badge-target"
                checked={target === 'overall'}
                onChange={() => setTarget('overall')}
              />
              <span>The whole page — the worst status across every public control</span>
            </label>
            {publicControls.map((c) => (
              <label
                key={c.id}
                style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}
              >
                <input
                  type="radio"
                  name="badge-target"
                  checked={target === c.key}
                  onChange={() => setTarget(c.key)}
                />
                <span>{c.name}</span>
              </label>
            ))}
          </fieldset>

          {controls.data !== undefined && publicControls.length === 0 && (
            <Banner tone="degraded">
              No public controls yet, so only the whole-page badge has anything to report.
            </Banner>
          )}

          <Field
            label="Label"
            hint={
              target === 'overall'
                ? 'The left-hand word. Defaults to “status”.'
                : `Defaults to the control's own name.`
            }
          >
            <Input
              value={label}
              placeholder={target === 'overall' ? 'status' : (control?.name.toLowerCase() ?? '')}
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
        </div>
      </Card>

      <Card>
        <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
          <h3 style={{ margin: 0, fontSize: 'var(--text-sm)' }}>Style</h3>

          <fieldset
            style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 'var(--space-3)' }}
          >
            {/* The visible heading above already names this group, so the
                legend is for the screen reader that has no heading in its
                path through the fieldset. */}
            <legend className="visually-hidden">Badge style</legend>
            {BADGE_STYLES.map((id) => {
              const info = BADGE_STYLE_INFO[id]
              const preview = new URLSearchParams({ style: id })
              if (label.trim() !== '') preview.set('label', label.trim())

              return (
                <label
                  key={id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'auto 1fr',
                    gap: 'var(--space-2) var(--space-3)',
                    alignItems: 'start',
                    padding: 'var(--space-3)',
                    border: `1px solid ${id === style ? 'var(--color-accent)' : 'var(--color-border)'}`,
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  <input
                    type="radio"
                    name="badge-style"
                    checked={id === style}
                    onChange={() => setStyle(id)}
                    style={{ marginTop: 3 }}
                  />
                  <div style={{ display: 'grid', gap: 'var(--space-2)', minWidth: 0 }}>
                    <div>
                      <span style={{ fontWeight: 600 }}>{info.label}</span>
                      <span
                        style={{
                          display: 'block',
                          fontSize: 'var(--text-xs)',
                          color: 'var(--color-fg-subtle)',
                        }}
                      >
                        {info.hint}
                      </span>
                    </div>
                    {/* The endpoint itself, at its natural size. A wide style
                        scrolls in its own box rather than widening the page. */}
                    <div style={{ overflowX: 'auto' }}>
                      <img src={`${path}?${preview.toString()}`} alt={`${info.label} preview`} />
                    </div>
                  </div>
                </label>
              )
            })}
          </fieldset>
        </div>
      </Card>

      <Card>
        <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
          <h3 style={{ margin: 0, fontSize: 'var(--text-sm)' }}>Take it away</h3>

          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            <CodeBlock label="URL">{absolute}</CodeBlock>
            <div>
              <CopyButton value={absolute} label="Copy the URL" />
            </div>
          </div>

          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            <CodeBlock label="Markdown">{`[![${alt}](${absolute})](${pageUrl})`}</CodeBlock>
            <div>
              <CopyButton
                value={`[![${alt}](${absolute})](${pageUrl})`}
                label="Copy the Markdown"
              />
            </div>
          </div>

          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            <CodeBlock label="HTML">
              {`<a href="${pageUrl}"><img src="${absolute}" alt="${alt}"></a>`}
            </CodeBlock>
            <div>
              <CopyButton
                value={`<a href="${pageUrl}"><img src="${absolute}" alt="${alt}"></a>`}
                label="Copy the HTML"
              />
            </div>
          </div>

          <p
            className="measure"
            style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-fg-subtle)' }}
          >
            Both snippets link the badge to the page, so a reader who notices something is wrong can
            reach the detail in one click. The badge is cached for a minute, and keeps serving the
            last good render while it refreshes — an embedded badge should never become a broken
            image.
          </p>

          <div>
            <Button onClick={() => window.open(relative, '_blank', 'noopener')}>
              Open the badge on its own
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}

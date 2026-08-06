import { Github, Heart } from 'lucide-react'
import { SPONSORS_URL } from './SponsorButton'

const LAB_URL = 'https://le-lab.net'
const REPO_URL = 'https://github.com/lelabnet-creator/ternproject'

/**
 * Who made this, and where the code is.
 *
 * One component for every surface — the root, the sign-in, the admin, the
 * public page — because a credit that is worded three different ways reads as
 * three different products.
 *
 * The flags are text, not images. A country flag emoji is one or two regional
 * indicator characters, so it needs no asset, survives an install with no route
 * to the internet, and scales with the type. They are marked `aria-hidden` and
 * the words "France" and "Europe" are what actually gets announced — a screen
 * reader saying "regional indicator F, regional indicator R" is noise.
 */
export function SiteFooter({ compact = false }: { compact?: boolean }) {
  return (
    <footer
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'center',
        gap: compact ? 'var(--space-2)' : 'var(--space-3)',
        padding: compact ? 'var(--space-3) 0 0' : 'var(--space-4) 0',
        fontSize: 'var(--text-xs)',
        color: 'var(--color-fg-subtle)',
        lineHeight: 1.6,
        textAlign: 'center',
      }}
    >
      <span>
        TERN — developed by{' '}
        <a href={LAB_URL} target="_blank" rel="noopener noreferrer" style={LINK}>
          le-lab.net
        </a>{' '}
        <span aria-hidden="true" style={{ letterSpacing: '0.1em' }}>
          🇫🇷&nbsp;🇪🇺
        </span>
        <span className="visually-hidden"> in France, in Europe</span>
      </span>

      <span aria-hidden="true">·</span>

      <a href={REPO_URL} target="_blank" rel="noopener noreferrer" style={{ ...LINK, ...ROW }}>
        <Github size={12} aria-hidden="true" />
        Source
      </a>

      <span aria-hidden="true">·</span>

      <a href={SPONSORS_URL} target="_blank" rel="noopener noreferrer" style={{ ...LINK, ...ROW }}>
        <Heart size={12} aria-hidden="true" style={{ color: 'var(--status-down)' }} />
        Sponsor
      </a>
    </footer>
  )
}

const LINK: React.CSSProperties = {
  color: 'var(--color-fg-muted)',
  fontWeight: 600,
  textDecoration: 'none',
}

const ROW: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--space-1)',
  whiteSpace: 'nowrap',
}

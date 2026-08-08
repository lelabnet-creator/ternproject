import { Github, Heart } from 'lucide-react'

/** Where the code signing certificates come from. */
export const SPONSORS_URL = 'https://github.com/sponsors/lelabnet-creator'

/**
 * The sponsor button.
 *
 * Drawn here rather than framed from github.com, and the reason is not taste:
 * `/sponsors/<account>/button` answers 404 while Sponsors is not enabled on the
 * account, and `/sponsors/<account>` redirects to the profile. A frame pointed
 * at a 404 renders a broken box, and a cross-origin frame reports `load` for an
 * error page exactly as it does for a real one — so no amount of fallback logic
 * can tell the two apart from the outside.
 *
 * Drawing it locally also means one fewer third-party request from a page a
 * customer serves under their own name, on an install that may have no route
 * out at all. When Sponsors is enabled on the account, the official frame
 * becomes an option again; until then, this is the button that actually
 * appears.
 *
 * The label names TERN by default, because this button also sits on pages that
 * belong to somebody else — a bare "Sponsor" in a customer's header reads as an
 * ask on that customer's behalf.
 */
export function SponsorButton({ label = 'Sponsor TERN' }: { label?: string }) {
  return (
    <a
      href={SPONSORS_URL}
      // Named explicitly, because the label is hidden in the admin's app bar
      // and the two marks beside it are decorative — without this the link
      // would announce itself as its own URL.
      aria-label={label}
      target="_blank"
      // noreferrer as well as noopener: the sponsor page has no need to learn
      // which status page the visitor came from.
      rel="noopener noreferrer"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-2)',
        // GitHub's own metrics, so the two are interchangeable if the frame
        // ever comes back.
        height: 32,
        padding: '0 var(--space-3)',
        borderRadius: 6,
        border: '1px solid var(--color-border-strong)',
        background: 'var(--color-surface-raised)',
        color: 'var(--color-fg)',
        fontSize: 'var(--text-xs)',
        fontWeight: 600,
        textDecoration: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      <Github size={14} aria-hidden="true" />
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}>
        {/* The heart is what the ask is; the mark only says where it leads. */}
        <Heart size={12} aria-hidden="true" style={{ color: 'var(--status-down)' }} />
        <span className="chrome-label">{label}</span>
      </span>
    </a>
  )
}

interface TernMarkProps {
  size?: number
  className?: string
  /** Decorative next to the wordmark; labelled when it stands alone. */
  title?: string
}

/**
 * The TERN mark as a component, so it inherits `currentColor` and the icon
 * sizing scale instead of being an <img> the theme cannot reach.
 */
export function TernMark({ size = 24, className, title }: TernMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <path d="M3 8.5c3.2-.4 6-.1 8.4 1.1" />
      <path d="M11.4 9.6c1.9 1 3.2 2.3 4 3.9l1.9-.9-.7 1.9 2.4-.3-1.6 1.7" />
      <path d="M21 7.6c-2.6 1.5-4.9 3-6.7 4.6" />
      <path d="M15.4 13.5 8.6 19m6.8-5.5-1.1 6.4" />
    </svg>
  )
}

/**
 * Mark plus name. The wordmark is live text rather than outlined paths: it stays
 * selectable, searchable and readable to a screen reader, and the type scale
 * already loads Fira Code.
 */
export function TernWordmark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        color: 'var(--color-fg)',
      }}
    >
      <TernMark size={size} />
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontWeight: 600,
          // Slight positive tracking: at small sizes an all-caps monospace
          // wordmark reads as cramped without it.
          letterSpacing: '0.08em',
          fontSize: `${size * 0.72}px`,
        }}
      >
        TERN
      </span>
    </span>
  )
}

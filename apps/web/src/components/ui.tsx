import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

/**
 * The small set of primitives every admin screen is built from.
 *
 * Deliberately minimal and token-driven: a status page's admin is a handful of
 * forms and tables, and pulling in a component library for that is more
 * surface than the product has.
 */

export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-4)',
        boxShadow: 'var(--shadow-card)',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  type = 'button',
  disabled,
  busy,
  ariaLabel,
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'secondary' | 'danger'
  type?: 'button' | 'submit'
  disabled?: boolean
  busy?: boolean
  /** Required when the visible content is a glyph — a screen reader reads this instead. */
  ariaLabel?: string
}) {
  const palette = {
    primary: { bg: 'var(--color-accent)', fg: 'var(--color-accent-fg)', border: 'transparent' },
    secondary: { bg: 'transparent', fg: 'var(--color-fg)', border: 'var(--color-border-strong)' },
    danger: { bg: 'transparent', fg: 'var(--status-down)', border: 'var(--status-down)' },
  }[variant]

  return (
    <button
      type={type}
      onClick={onClick}
      // Busy counts as disabled: a second click on a submitting form is the
      // classic way to create two of something.
      disabled={disabled || busy}
      aria-busy={busy}
      aria-label={ariaLabel}
      title={ariaLabel}
      style={{
        background: palette.bg,
        color: palette.fg,
        border: `1px solid ${palette.border}`,
        borderRadius: 'var(--radius-sm)',
        padding: '0 var(--space-4)',
        fontSize: 'var(--text-sm)',
        fontWeight: 600,
        fontFamily: 'inherit',
        opacity: disabled || busy ? 0.5 : 1,
        cursor: disabled || busy ? 'not-allowed' : 'pointer',
        transition: 'opacity var(--duration-fast) var(--ease-out)',
      }}
    >
      {busy ? '…' : children}
    </button>
  )
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: ReactNode
}) {
  return (
    <label
      style={{
        display: 'grid',
        gap: 'var(--space-1)',
        /*
         * Rows keep their natural height instead of sharing out the spare.
         *
         * Fields sit side by side in a grid row, so every one is as tall as the
         * tallest. A field with no hint has two rows rather than three, and the
         * default `stretch` handed that field's leftover height to its input —
         * so "Host", alone in lacking a hint, rendered a visibly taller box than
         * "Port" beside it. Aligning to the start lets the spare height fall to
         * the bottom, where nothing is drawn.
         */
        alignContent: 'start',
      }}
    >
      {/* A visible label, never a placeholder standing in for one: the
          placeholder disappears the moment someone starts typing. */}
      <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{label}</span>
      {children}
      {hint && !error && (
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-fg-subtle)' }}>{hint}</span>
      )}
      {error && (
        // Beside the field it belongs to, and announced — an error summary at
        // the top of a long form is a scavenger hunt.
        <span
          role="alert"
          style={{ fontSize: 'var(--text-xs)', color: 'var(--status-down)', fontWeight: 600 }}
        >
          {error}
        </span>
      )}
    </label>
  )
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        background: 'var(--color-bg)',
        color: 'var(--color-fg)',
        border: '1px solid var(--color-border-strong)',
        borderRadius: 'var(--radius-sm)',
        padding: 'var(--space-2) var(--space-3)',
        // 16px minimum, or iOS zooms the whole page on focus.
        fontSize: 'var(--text-base)',
        fontFamily: 'inherit',
        minHeight: 44,
        width: '100%',
        ...props.style,
      }}
    />
  )
}

/**
 * The same box as `Input`, for the two elements that inherit none of its
 * styling.
 *
 * A `<select>` and a `<textarea>` are different elements, so every screen that
 * needed one restated the whole declaration block — three of them do, and they
 * have already drifted on `minHeight`. One definition here is the fix.
 */
const BOX: CSSProperties = {
  background: 'var(--color-bg)',
  color: 'var(--color-fg)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 'var(--radius-sm)',
  padding: 'var(--space-2) var(--space-3)',
  // 16px minimum, or iOS zooms the whole page on focus.
  fontSize: 'var(--text-base)',
  fontFamily: 'inherit',
  width: '100%',
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} style={{ ...BOX, minHeight: 44, ...props.style }} />
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} style={{ ...BOX, ...props.style }} />
}

/**
 * A checkbox with its own label and a reason underneath.
 *
 * The reason is not optional: every one of these switches something the reader
 * cannot see the consequence of — whether mail goes out, whether alerting stays
 * quiet — and a bare label leaves them guessing.
 */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  hint: string
  disabled?: boolean
}) {
  return (
    <label style={{ display: 'grid', gap: 'var(--space-1)', opacity: disabled ? 0.6 : 1 }}>
      <span style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{label}</span>
      </span>
      <span
        style={{
          fontSize: 'var(--text-xs)',
          color: 'var(--color-fg-subtle)',
          paddingLeft: 'var(--space-5)',
        }}
      >
        {hint}
      </span>
    </label>
  )
}

export function Banner({
  tone,
  children,
}: {
  tone: 'operational' | 'degraded' | 'down' | 'maintenance'
  children: ReactNode
}) {
  return (
    <div
      role={tone === 'down' ? 'alert' : 'status'}
      style={{
        padding: 'var(--space-3) var(--space-4)',
        borderRadius: 'var(--radius-sm)',
        background: `var(--status-${tone}-soft)`,
        borderLeft: `3px solid var(--status-${tone})`,
        color: 'var(--color-fg)',
        fontSize: 'var(--text-sm)',
      }}
    >
      {children}
    </div>
  )
}

/** Monospace block for generated scripts and PINs. */
export function CodeBlock({ children, label }: { children: string; label?: string }) {
  return (
    <div style={{ position: 'relative' }}>
      {label && (
        <div
          style={{
            fontSize: 'var(--text-xs)',
            color: 'var(--color-fg-subtle)',
            marginBottom: 'var(--space-1)',
          }}
        >
          {label}
        </div>
      )}
      <pre
        style={{
          margin: 0,
          padding: 'var(--space-3)',
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-sm)',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--text-xs)',
          lineHeight: 1.5,
          // Wide content scrolls inside its own box; the page must never
          // scroll sideways.
          overflowX: 'auto',
          maxHeight: '28rem',
        }}
      >
        <code>{children}</code>
      </pre>
    </div>
  )
}

/**
 * Copy, then say so.
 *
 * The confirmation is the whole point: a clipboard write is silent, and without
 * a reply the only way to know it worked is to paste somewhere and look. It
 * reverts after two seconds so the button does not sit there claiming a copy
 * from five minutes ago.
 */
export function CopyButton({
  value,
  label = 'Copy',
  variant = 'secondary',
}: {
  value: string
  label?: string
  variant?: 'primary' | 'secondary'
}) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <Button
      variant={variant}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => setCopied(true))
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  )
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div
      style={{
        textAlign: 'center',
        padding: 'var(--space-12) var(--space-4)',
        color: 'var(--color-fg-subtle)',
      }}
    >
      <p style={{ margin: 0, fontWeight: 600, color: 'var(--color-fg-muted)' }}>{title}</p>
      {/* An empty state says what to do next, not just that there is nothing. */}
      {hint && <p style={{ margin: 'var(--space-2) 0 var(--space-4)' }}>{hint}</p>}
      {action}
    </div>
  )
}

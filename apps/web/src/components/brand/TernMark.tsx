/**
 * The TERN mark, and the reduction rules the logo system specifies.
 *
 * The system sheet (`public/brand/sterne-monoligne-systeme.svg`) does not just
 * give artwork — it gives an optical correction: at smaller sizes the stroke
 * thickens and, at 24px, the eye is dropped entirely. A monoline mark scaled
 * naively goes thin and muddy, and a 4.5-unit dot at 24px is a smudge rather
 * than an eye.
 *
 * Encoding that here means every call site gets it right without knowing it
 * exists.
 */

/**
 * The smallest size the system sheet draws. Below it the head profile stops
 * reading as a bird and becomes a comma — the mark is not designed to go there,
 * and rendering it anyway makes the brand look broken rather than small.
 */
export const MIN_MARK_SIZE = 24

interface Geometry {
  strokeWidth: number
  eyeRadius: number | null
}

/** The three steps the system sheet draws, applied by rendered size. */
function geometryFor(size: number): Geometry {
  if (size >= 40) return { strokeWidth: 9, eyeRadius: 4.5 }
  if (size >= 28) return { strokeWidth: 10, eyeRadius: 5 }
  // At 24 and below the eye is removed, not shrunk.
  return { strokeWidth: 12, eyeRadius: null }
}

interface TernMarkProps {
  size?: number
  className?: string
  /** Labelled when it stands alone; decorative beside the wordmark. */
  title?: string
}

/**
 * The mark alone, inheriting `currentColor`.
 *
 * The viewBox stays on the system's 160 grid rather than being rescaled to 24:
 * the coordinates then match the source exactly and nothing drifts through
 * rounding.
 */
export function TernMark({ size = 32, className, title }: TernMarkProps) {
  const rendered = Math.max(size, MIN_MARK_SIZE)
  const { strokeWidth, eyeRadius } = geometryFor(rendered)

  return (
    <svg
      width={rendered}
      height={rendered}
      viewBox="0 0 160 160"
      fill="none"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <path
        d="M30 112 C19 86 30 50 62 44 C84 40 96 50 98 60 L130 66 L98 72"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {eyeRadius !== null && <circle cx="76" cy="59" r={eyeRadius} fill="currentColor" />}
    </svg>
  )
}

/**
 * The mark in its rounded container.
 *
 * Used where the logo lands on a surface it does not control — an app icon, an
 * avatar, a third-party page. The container carries its own contrast.
 */
export function TernBadge({ size = 40, className }: { size?: number; className?: string }) {
  const { strokeWidth, eyeRadius } = geometryFor(size)

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 160 160"
      className={className}
      role="img"
      aria-label="TERN"
    >
      <rect width="160" height="160" rx="40" fill="var(--brand-ink)" />
      <path
        d="M30 112 C19 86 30 50 62 44 C84 40 96 50 98 60 L130 66 L98 72"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {eyeRadius !== null && <circle cx="76" cy="59" r={eyeRadius} fill="#FFFFFF" />}
    </svg>
  )
}

/**
 * Mark plus name.
 *
 * The wordmark is lowercase `tern` in a neutral grotesque with slightly tight
 * tracking, exactly as the lockup on the system sheet sets it — not the
 * interface's monospace, which belongs to numbers and timestamps rather than to
 * the name.
 *
 * Live text rather than outlined paths, so it stays selectable, searchable and
 * readable to a screen reader.
 */
export function TernWordmark({
  size = 32,
  className,
  /** Badge lockup for dark placements; bare mark otherwise. */
  variant = 'mark',
}: {
  size?: number
  className?: string
  variant?: 'mark' | 'badge'
}) {
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: `${size * 0.28}px`,
        color: 'var(--color-fg)',
      }}
    >
      {variant === 'badge' ? <TernBadge size={size} /> : <TernMark size={size} />}
      <span
        style={{
          fontFamily: 'Helvetica, Arial, system-ui, sans-serif',
          fontWeight: 500,
          // -0.6 at 34px in the source lockup, expressed relatively so it
          // holds at every size.
          letterSpacing: '-0.018em',
          fontSize: `${size * 0.85}px`,
          lineHeight: 1,
        }}
      >
        tern
      </span>
    </span>
  )
}

export const __testables = { geometryFor }

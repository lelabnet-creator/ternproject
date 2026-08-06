import { useEffect, useState } from 'react'

/**
 * Light, dark, or whatever the system says.
 *
 * Three states rather than a toggle, because "follow the system" is a real
 * preference and not the absence of one — a two-way switch forces a reader who
 * changes their laptop to dark at sunset to come back and change this too.
 *
 * Stored, because a preference that resets on reload was never a preference.
 * Applied from `applyStoredTheme()` before React mounts, so the page does not
 * render in the wrong theme and correct itself in front of the reader.
 */

export type ThemeChoice = 'system' | 'light' | 'dark'

const KEY = 'tern.theme'

export function storedTheme(): ThemeChoice {
  const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY)
  return raw === 'light' || raw === 'dark' ? raw : 'system'
}

/** Call once, as early as possible. */
export function applyStoredTheme(): void {
  apply(storedTheme())
}

function apply(choice: ThemeChoice): void {
  const root = document.documentElement
  if (choice === 'system') {
    // Removed, not set to a value: the tokens' media query is the system
    // behaviour, and an explicit attribute would freeze whatever it resolved to
    // at the moment of the click.
    delete root.dataset.theme
  } else {
    root.dataset.theme = choice
  }
}

const OPTIONS: { id: ThemeChoice; label: string }[] = [
  { id: 'system', label: 'Auto' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
]

export function ThemePicker({ compact = false }: { compact?: boolean }) {
  const [choice, setChoice] = useState<ThemeChoice>(storedTheme)

  useEffect(() => {
    apply(choice)
    localStorage.setItem(KEY, choice)
  }, [choice])

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      style={{
        display: 'inline-flex',
        gap: 2,
        padding: 2,
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--color-border)',
        background: 'var(--color-surface)',
      }}
    >
      {OPTIONS.map((option) => {
        const selected = option.id === choice
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setChoice(option.id)}
            style={{
              // 32px rather than 44 in the compact case: this sits in a header
              // beside other chrome, and three 44px targets there would push
              // the page's own content down for a control used twice a year.
              minHeight: compact ? 32 : 36,
              padding: `0 ${compact ? 'var(--space-2)' : 'var(--space-3)'}`,
              borderRadius: 'calc(var(--radius-sm) - 2px)',
              border: 0,
              background: selected ? 'var(--color-accent-soft)' : 'transparent',
              color: selected ? 'var(--color-accent-ink)' : 'var(--color-fg-subtle)',
              fontFamily: 'inherit',
              fontSize: 'var(--text-xs)',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

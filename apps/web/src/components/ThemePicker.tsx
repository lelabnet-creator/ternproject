import { useEffect, useState } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'

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

/*
 * The glyph is not decoration: in the admin's app bar the label is hidden below
 * the rail's breakpoint, and this is what is left to tell the three apart. The
 * accessible name comes from `aria-label` either way, so the control reads the
 * same to a screen reader in both shapes.
 */
const OPTIONS: { id: ThemeChoice; label: string; Icon: typeof Monitor }[] = [
  { id: 'system', label: 'Auto', Icon: Monitor },
  { id: 'light', label: 'Light', Icon: Sun },
  { id: 'dark', label: 'Dark', Icon: Moon },
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
            aria-label={option.label}
            // Sized from CSS, not from here: in the admin's app bar these
            // become square 44px targets, and an inline height cannot be
            // overridden by a media query.
            className={compact ? 'theme-option is-compact' : 'theme-option'}
            onClick={() => setChoice(option.id)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 'var(--space-1)',
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
            <option.Icon size={14} aria-hidden="true" />
            {/* Dropped in the admin's app bar, where three labelled segments
                would leave no room for the tenant's name. */}
            <span className="chrome-label">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}

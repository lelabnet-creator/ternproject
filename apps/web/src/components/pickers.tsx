import { useMemo } from 'react'
import { LOCALES } from '../i18n'

/**
 * The two settings that were free-text fields and should never have been.
 *
 * A locale typed by hand accepts `fr-FR`, `french` and `FR`, none of which the
 * app resolves to anything but English — a wrong answer it gives silently. A
 * time zone typed by hand is worse: `Paris` or `GMT+1` is not an IANA name, and
 * what it breaks is every timestamp on the page, hours later, for readers who
 * were not the one typing.
 *
 * Two different answers because the lists are two different sizes. Two
 * languages is a `select`. Four hundred-odd zones is not — that is a list you
 * filter, not one you scroll, so it is an input with suggestions attached.
 */

const SELECT_STYLE = {
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
} as const

export function LocaleSelect({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <select
      value={LOCALES.some((l) => l.id === value) ? value : 'en'}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      style={SELECT_STYLE}
    >
      {LOCALES.map((locale) => (
        <option key={locale.id} value={locale.id}>
          {locale.label}
        </option>
      ))}
    </select>
  )
}

/**
 * Every zone the browser knows, offered as suggestions.
 *
 * `Intl.supportedValuesOf` is the browser's own IANA database — 418 entries on
 * a current one — so the list needs no shipping, no updating, and cannot drift
 * from the rules the page will use to format a date.
 *
 * Where it is missing, the field stays a plain text input rather than becoming
 * a short list of guesses: an operator in a zone we failed to guess would be
 * unable to enter it at all, which is worse than typing it.
 */
function zones(): string[] {
  try {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf?.('timeZone')
    return supported ?? []
  } catch {
    return []
  }
}

export function TimeZoneInput({
  value,
  onChange,
  disabled,
  id = 'tern-timezones',
}: {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  id?: string
}) {
  // Read once: the browser's zone list does not change while somebody is
  // looking at a form, and it is four hundred strings.
  const all = useMemo(zones, [])

  return (
    <>
      <input
        list={all.length > 0 ? id : undefined}
        value={value}
        disabled={disabled}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        onChange={(event) => onChange(event.target.value)}
        style={SELECT_STYLE}
      />
      {all.length > 0 && (
        <datalist id={id}>
          {all.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
      )}
    </>
  )
}

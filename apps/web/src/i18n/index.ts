import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './en.json'
import fr from './fr.json'

/**
 * French and English from the start, rather than "add i18n later".
 *
 * Retrofitting it means hunting every hard-coded string in the codebase, and
 * the strings on a status page are the ones a customer reads during an outage —
 * exactly when the wrong language costs the most.
 */
export function initI18n(locale: string) {
  void i18next.use(initReactI18next).init({
    resources: { en: { translation: en }, fr: { translation: fr } },
    lng: normaliseLocale(locale),
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  })
  return i18next
}

/** `fr-CA` and `fr` both resolve to French; anything unknown falls back. */
export function normaliseLocale(locale: string): string {
  const base = locale.split('-')[0]?.toLowerCase()
  return base === 'fr' ? 'fr' : 'en'
}

/**
 * The viewer's own locale wins over the tenant's, because the person reading is
 * the one who has to understand it. The tenant default is the fallback for a
 * browser that reports nothing useful.
 */
export function resolveLocale(tenantDefault: string): string {
  const fromBrowser = typeof navigator !== 'undefined' ? navigator.language : undefined
  return normaliseLocale(fromBrowser ?? tenantDefault)
}

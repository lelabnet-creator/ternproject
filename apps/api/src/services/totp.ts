import { authenticator } from 'otplib'
import { decryptSecret, encryptSecret, generateToken, hashToken } from '@tern/shared'
import { config } from '../config.js'

/**
 * TOTP second factor.
 *
 * A one-step window (±30 s) rather than the library default: clock skew on a
 * phone is real, but every extra step widens the window an intercepted code
 * stays usable in.
 */
authenticator.options = { window: 1 }

export interface TotpEnrolment {
  /** Encrypted, ready to store. */
  secretEnc: string
  /** Shown once, as a QR code and as text for manual entry. */
  otpauthUrl: string
  secret: string
}

export function beginEnrolment(email: string, issuer = 'TERN'): TotpEnrolment {
  const secret = authenticator.generateSecret()
  return {
    secret,
    secretEnc: encryptSecret(secret, config.APP_SECRET),
    otpauthUrl: authenticator.keyuri(email, issuer, secret),
  }
}

export function verifyTotp(secretEnc: string, token: string): boolean {
  try {
    return authenticator.verify({ token: token.replace(/\s/g, ''), secret: decrypt(secretEnc) })
  } catch {
    // A malformed secret or token reads as "wrong code" — never as an error that
    // distinguishes this account from another.
    return false
  }
}

function decrypt(secretEnc: string): string {
  return decryptSecret(secretEnc, config.APP_SECRET)
}

// ── Recovery codes ──────────────────────────────────────────────────────────

/**
 * Ten single-use codes, shown once at enrolment and stored only as hashes.
 *
 * Without these, losing a phone means losing the account — and the usual
 * workaround (an admin who can disable MFA) is a social-engineering path
 * straight past the second factor.
 */
export function generateBackupCodes(count = 10): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: count }, () => {
    const raw = generateToken(6)
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 10)
      .toUpperCase()
    return `${raw.slice(0, 5)}-${raw.slice(5)}`
  })
  return { codes, hashes: codes.map((c) => hashToken(normaliseBackupCode(c))) }
}

export function normaliseBackupCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
}

/**
 * Returns the remaining hashes if the code matched, or null if it did not.
 * Consuming the code is the caller's job — it must happen in the same
 * transaction as the login, or a code could be replayed.
 */
export function consumeBackupCode(hashes: string[], code: string): string[] | null {
  const target = hashToken(normaliseBackupCode(code))
  const index = hashes.indexOf(target)
  if (index === -1) return null
  return hashes.filter((_, i) => i !== index)
}

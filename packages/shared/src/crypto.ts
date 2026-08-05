import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

// ── Passwords ───────────────────────────────────────────────────────────────

/**
 * Argon2id with OWASP's 2024 baseline: 19 MiB, 2 iterations, 1 lane.
 * Memory cost is the parameter that actually hurts GPU attackers, so it is the
 * one not to trim when logins feel slow.
 */
const ARGON_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const

export function hashPassword(password: string): Promise<string> {
  return argonHash(password, ARGON_OPTIONS)
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hash, password)
  } catch {
    // A malformed stored hash must read as "wrong password", never as a crash
    // that distinguishes this account from others.
    return false
  }
}

// ── Opaque tokens ───────────────────────────────────────────────────────────

/**
 * Session cookies, API keys, viewer tokens and unsubscribe links are all
 * high-entropy random strings stored only as a SHA-256 digest.
 *
 * SHA-256 rather than Argon2 here on purpose: these are 256-bit random values,
 * not human-chosen secrets, so there is nothing to brute-force and the lookup
 * has to be fast enough to run on every request.
 */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

// ── Symmetric encryption at rest ────────────────────────────────────────────

/**
 * AES-256-GCM for values the application must be able to read back: TOTP
 * secrets, subscriber addresses, probe authentication headers.
 *
 * Format is `v1.<iv>.<tag>.<ciphertext>`, all base64url. The version prefix is
 * there so a future algorithm change can decrypt old values instead of
 * orphaning them.
 */
const ENCRYPTION_VERSION = 'v1'

function deriveKey(appSecret: string): Buffer {
  return createHash('sha256').update(appSecret).digest()
}

export function encryptSecret(plaintext: string, appSecret: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(appSecret), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    ENCRYPTION_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.')
}

export function decryptSecret(payload: string, appSecret: string): string {
  const [version, ivPart, tagPart, dataPart] = payload.split('.')
  if (version !== ENCRYPTION_VERSION || !ivPart || !tagPart || !dataPart) {
    throw new Error('Unrecognised encrypted payload format')
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(appSecret),
    Buffer.from(ivPart, 'base64url'),
  )
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

/**
 * Deterministic keyed digest, used as a blind index so duplicate subscriber
 * addresses can be detected without decrypting the whole table.
 */
export function blindIndex(value: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(value.trim().toLowerCase()).digest('hex')
}

/**
 * A reproducible capability reference for a subscriber's unsubscribe link.
 *
 * Derived rather than stored: the plaintext issued at signup exists only in that
 * one confirmation email, so a later notification cannot reproduce it. Deriving
 * from the id lets every message carry a working link with nothing extra kept in
 * the database and nothing guessable without APP_SECRET.
 *
 * Kept deliberately compact — the id as raw base64url bytes and the HMAC
 * truncated to 128 bits — because the resulting URL goes in a List-Unsubscribe
 * header. A long value there is silently dropped during header folding, which
 * produced mail advertising one-click unsubscribe with no address to use.
 * 128 bits is far beyond what an unguessable capability needs.
 */
const UNSUBSCRIBE_TOKEN_BYTES = 16

function uuidToCompact(uuid: string): string {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex').toString('base64url')
}

function compactToUuid(compact: string): string | null {
  const bytes = Buffer.from(compact, 'base64url')
  if (bytes.length !== 16) return null
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}

export function deriveUnsubscribeToken(subscriberId: string, appSecret: string): string {
  return createHmac('sha256', appSecret)
    .update(`unsubscribe:${subscriberId}`)
    .digest()
    .subarray(0, UNSUBSCRIBE_TOKEN_BYTES)
    .toString('base64url')
}

export function buildUnsubscribeRef(subscriberId: string, appSecret: string): string {
  return `${uuidToCompact(subscriberId)}${deriveUnsubscribeToken(subscriberId, appSecret)}`
}

/** Returns the subscriber id if the reference verifies, or null. */
export function parseUnsubscribeRef(ref: string, appSecret: string): string | null {
  // 16 bytes of id and 16 of token both encode to 22 base64url characters.
  if (ref.length !== 44) return null

  const id = compactToUuid(ref.slice(0, 22))
  if (!id) return null

  return constantTimeEqual(ref.slice(22), deriveUnsubscribeToken(id, appSecret)) ? id : null
}

// ── Webhook signatures ──────────────────────────────────────────────────────

/**
 * Signs `<timestamp>.<body>` rather than the body alone: without the timestamp
 * in the signed material, a captured payload can be replayed forever.
 */
export function signWebhook(body: string, secret: string, timestamp: number): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

// ── Pairing PINs ────────────────────────────────────────────────────────────

/**
 * Crockford base32 minus I, L, O and U: no character pair a human can confuse
 * when reading a code off a screen or dictating it over the phone.
 */
const PIN_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Eight characters ≈ 40 bits, shown as `K7F2-9RQX`. */
export function generatePin(length = 8): string {
  const bytes = randomBytes(length)
  let pin = ''
  for (let i = 0; i < length; i++) {
    // `bytes[i]` is defined for i < length; the check satisfies
    // noUncheckedIndexedAccess without pretending the index can be missing.
    const byte = bytes[i] ?? 0
    pin += PIN_ALPHABET[byte % PIN_ALPHABET.length]
  }
  return `${pin.slice(0, 4)}-${pin.slice(4)}`
}

/** Accepts the code with or without its separator, in any case. */
export function normalisePin(pin: string): string {
  return pin.replace(/[^0-9A-Za-z]/g, '').toUpperCase()
}

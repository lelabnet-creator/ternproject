import { and, eq, gt, isNull, lt, or } from 'drizzle-orm'
import type { Database } from '@tern/db'
import { schema } from '@tern/db'
import { generateToken, hashToken } from '@tern/shared'
import { isProduction } from '../config.js'

export const SESSION_COOKIE = 'tern_session'

/**
 * Sessions last a week; a session still awaiting its TOTP code lasts five
 * minutes. The short window matters: between password and second factor the
 * cookie is a partially-authenticated credential, and leaving those lying
 * around for a week defeats the point of the second factor.
 */
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000
const PENDING_MFA_TTL_MS = 5 * 60 * 1000

export interface CreateSessionInput {
  userId?: string
  tenantId?: string
  viewerTokenId?: string
  mfaSatisfied: boolean
  ip?: string | null
  userAgent?: string | null
}

export interface IssuedSession {
  token: string
  expiresAt: Date
}

export async function createSession(
  db: Database,
  input: CreateSessionInput,
): Promise<IssuedSession> {
  const token = generateToken(32)
  const expiresAt = new Date(
    Date.now() + (input.mfaSatisfied ? SESSION_TTL_MS : PENDING_MFA_TTL_MS),
  )

  await db.insert(schema.sessions).values({
    userId: input.userId ?? null,
    tenantId: input.tenantId ?? null,
    viewerTokenId: input.viewerTokenId ?? null,
    tokenHash: hashToken(token),
    mfaSatisfied: input.mfaSatisfied,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    expiresAt,
  })

  return { token, expiresAt }
}

export async function findSession(db: Database, token: string) {
  const [session] = await db
    .select()
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.tokenHash, hashToken(token)),
        gt(schema.sessions.expiresAt, new Date()),
      ),
    )
    .limit(1)
  return session ?? null
}

/** Promotes a pending session once the second factor has been verified. */
export async function markMfaSatisfied(db: Database, sessionId: string): Promise<void> {
  await db
    .update(schema.sessions)
    .set({ mfaSatisfied: true, expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
    .where(eq(schema.sessions.id, sessionId))
}

export async function destroySession(db: Database, token: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, hashToken(token)))
}

/** Called when an account is disabled — every device must lose access at once. */
export async function destroyUserSessions(db: Database, userId: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId))
}

export async function purgeExpiredSessions(db: Database): Promise<void> {
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date()))
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    // Lax rather than Strict: a QR pairing link and an emailed status link both
    // arrive as top-level navigations, and Strict would drop the session on
    // exactly those entry points.
    sameSite: 'lax' as const,
    secure: isProduction,
    path: '/',
    expires: expiresAt,
  }
}

/**
 * Viewer devices are revocable individually, so a session bound to one must be
 * re-checked against the device and its parent token on every request rather
 * than trusted for its whole lifetime.
 */
export async function viewerSessionIsLive(db: Database, viewerTokenId: string): Promise<boolean> {
  const [token] = await db
    .select({ id: schema.viewerTokens.id })
    .from(schema.viewerTokens)
    .where(
      and(
        eq(schema.viewerTokens.id, viewerTokenId),
        isNull(schema.viewerTokens.revokedAt),
        or(isNull(schema.viewerTokens.expiresAt), gt(schema.viewerTokens.expiresAt, new Date())),
      ),
    )
    .limit(1)
  return Boolean(token)
}

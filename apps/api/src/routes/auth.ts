import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import { hashPassword, verifyPassword } from '@tern/shared'
import { config } from '../config.js'
import {
  SESSION_COOKIE,
  createSession,
  destroySession,
  destroyUserSessions,
  markMfaSatisfied,
  sessionCookieOptions,
} from '../services/sessions.js'
import {
  beginEnrolment,
  consumeBackupCode,
  generateBackupCodes,
  verifyTotp,
} from '../services/totp.js'
import { audit } from '../services/audit.js'

/**
 * Local login with a TOTP second factor.
 *
 * The whole route file is rate-limited hard: these endpoints are the ones an
 * attacker actually reaches for, and a correct Argon2 verify is worth nothing
 * if it can be attempted ten thousand times a minute.
 */
const routes: FastifyPluginAsyncZod = async (app) => {
  await app.register(import('@fastify/rate-limit'), {
    max: config.AUTH_RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
  })

  app.post(
    '/login',
    {
      schema: {
        body: z.object({
          email: z.string().email(),
          password: z.string().min(1),
        }),
        response: {
          200: z.object({
            mfaRequired: z.boolean(),
            user: z.object({ id: z.string(), email: z.string(), name: z.string() }).nullable(),
          }),
        },
      },
    },
    async (req, reply) => {
      const [user] = await app.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, req.body.email.toLowerCase()))
        .limit(1)

      // The same generic message and the same work either way. Verifying
      // against a dummy hash when the account does not exist keeps the response
      // time from revealing which addresses are registered.
      const ok = user
        ? await verifyPassword(user.passwordHash, req.body.password)
        : await verifyPassword(await dummyHash(), req.body.password)

      if (!user || !ok || user.disabledAt) {
        await audit(app, {
          action: 'auth.login.failed',
          actorLabel: req.body.email,
          ip: req.ip,
        })
        throw app.httpErrors.unauthorized('Invalid email or password')
      }

      const session = await createSession(app.db, {
        userId: user.id,
        mfaSatisfied: !user.mfaEnabled,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      })

      reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt))

      if (!user.mfaEnabled) {
        await app.db
          .update(schema.users)
          .set({ lastLoginAt: new Date() })
          .where(eq(schema.users.id, user.id))
      }

      await audit(app, {
        action: user.mfaEnabled ? 'auth.login.mfa_pending' : 'auth.login.success',
        actorId: user.id,
        ip: req.ip,
      })

      return {
        mfaRequired: user.mfaEnabled,
        // Nothing about the account is returned until the second factor is
        // satisfied — a stolen password should not even confirm the name.
        user: user.mfaEnabled ? null : { id: user.id, email: user.email, name: user.name },
      }
    },
  )

  app.post(
    '/mfa/verify',
    {
      schema: {
        body: z.object({
          code: z.string().min(6).max(16),
          /** Set when presenting a recovery code rather than a TOTP code. */
          backupCode: z.boolean().default(false),
        }),
        response: {
          200: z.object({
            user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
            backupCodesRemaining: z.number(),
          }),
        },
      },
    },
    async (req) => {
      const actor = req.actor
      if (actor.kind !== 'user' || !actor.userId || !actor.sessionId) {
        throw app.httpErrors.unauthorized('No pending session')
      }
      if (actor.mfaSatisfied) throw app.httpErrors.badRequest('Second factor already satisfied')

      const [user] = await app.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, actor.userId))
        .limit(1)
      if (!user?.mfaSecretEnc) throw app.httpErrors.unauthorized('MFA is not configured')

      let remaining = user.mfaBackupCodes

      if (req.body.backupCode) {
        const left = consumeBackupCode(user.mfaBackupCodes, req.body.code)
        if (!left) {
          await audit(app, { action: 'auth.mfa.failed', actorId: user.id, ip: req.ip })
          throw app.httpErrors.unauthorized('Invalid code')
        }
        // Consumed immediately, in the same request that accepted it: a
        // recovery code that survives its own use is not single-use.
        remaining = left
        await app.db
          .update(schema.users)
          .set({ mfaBackupCodes: left })
          .where(eq(schema.users.id, user.id))
      } else if (!verifyTotp(user.mfaSecretEnc, req.body.code)) {
        await audit(app, { action: 'auth.mfa.failed', actorId: user.id, ip: req.ip })
        throw app.httpErrors.unauthorized('Invalid code')
      }

      await markMfaSatisfied(app.db, actor.sessionId)
      await app.db
        .update(schema.users)
        .set({ lastLoginAt: new Date() })
        .where(eq(schema.users.id, user.id))

      await audit(app, {
        action: req.body.backupCode ? 'auth.mfa.backup_used' : 'auth.mfa.success',
        actorId: user.id,
        ip: req.ip,
      })

      return {
        user: { id: user.id, email: user.email, name: user.name },
        backupCodesRemaining: remaining.length,
      }
    },
  )

  app.post(
    '/mfa/setup',
    {
      schema: {
        response: {
          200: z.object({ otpauthUrl: z.string(), secret: z.string() }),
        },
      },
    },
    async (req) => {
      const user = await requireAuthenticatedUser(app, req)
      if (user.mfaEnabled) throw app.httpErrors.conflict('MFA is already enabled')

      const enrolment = beginEnrolment(user.email)

      // Stored but not yet enabled: the secret only becomes the account's second
      // factor once a code proves the authenticator actually holds it. Enabling
      // first would lock the user out of their own account.
      await app.db
        .update(schema.users)
        .set({ mfaSecretEnc: enrolment.secretEnc })
        .where(eq(schema.users.id, user.id))

      return { otpauthUrl: enrolment.otpauthUrl, secret: enrolment.secret }
    },
  )

  app.post(
    '/mfa/setup/confirm',
    {
      schema: {
        body: z.object({ code: z.string().min(6).max(8) }),
        response: { 200: z.object({ backupCodes: z.array(z.string()) }) },
      },
    },
    async (req) => {
      const user = await requireAuthenticatedUser(app, req)
      if (user.mfaEnabled) throw app.httpErrors.conflict('MFA is already enabled')
      if (!user.mfaSecretEnc) throw app.httpErrors.badRequest('Start enrolment first')
      if (!verifyTotp(user.mfaSecretEnc, req.body.code)) {
        throw app.httpErrors.unauthorized('Invalid code')
      }

      const { codes, hashes } = generateBackupCodes()
      await app.db
        .update(schema.users)
        .set({ mfaEnabled: true, mfaBackupCodes: hashes })
        .where(eq(schema.users.id, user.id))

      await audit(app, { action: 'auth.mfa.enabled', actorId: user.id, ip: req.ip })

      // Shown exactly once — only the hashes are kept.
      return { backupCodes: codes }
    },
  )

  app.post(
    '/logout',
    { schema: { response: { 200: z.object({ ok: z.boolean() }) } } },
    async (req, reply) => {
      const token = req.cookies[SESSION_COOKIE]
      if (token) await destroySession(app.db, token)
      reply.clearCookie(SESSION_COOKIE, { path: '/' })
      return { ok: true }
    },
  )

  app.post(
    '/password',
    {
      schema: {
        body: z.object({
          currentPassword: z.string().min(1),
          newPassword: z.string().min(12, 'Use at least 12 characters'),
        }),
        response: { 200: z.object({ ok: z.boolean() }) },
      },
    },
    async (req, reply) => {
      const user = await requireAuthenticatedUser(app, req)
      if (!(await verifyPassword(user.passwordHash, req.body.currentPassword))) {
        throw app.httpErrors.unauthorized('Current password is incorrect')
      }

      await app.db
        .update(schema.users)
        .set({ passwordHash: await hashPassword(req.body.newPassword) })
        .where(eq(schema.users.id, user.id))

      // Every other device is signed out. A password change is usually a
      // response to suspected compromise, and leaving old sessions alive would
      // defeat the point.
      await destroyUserSessions(app.db, user.id)
      reply.clearCookie(SESSION_COOKIE, { path: '/' })

      await audit(app, { action: 'auth.password.changed', actorId: user.id, ip: req.ip })
      return { ok: true }
    },
  )

  app.get(
    '/me',
    {
      schema: {
        response: {
          200: z.object({
            user: z.object({
              id: z.string(),
              email: z.string(),
              name: z.string(),
              mfaEnabled: z.boolean(),
              locale: z.string(),
              timezone: z.string(),
            }),
            memberships: z.array(
              z.object({
                tenantId: z.string(),
                slug: z.string(),
                name: z.string(),
                role: z.string(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const user = await requireAuthenticatedUser(app, req)
      const memberships = await app.db
        .select({
          tenantId: schema.tenants.id,
          slug: schema.tenants.slug,
          name: schema.tenants.name,
          role: schema.memberships.role,
        })
        .from(schema.memberships)
        .innerJoin(schema.tenants, eq(schema.tenants.id, schema.memberships.tenantId))
        .where(eq(schema.memberships.userId, user.id))

      return {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          mfaEnabled: user.mfaEnabled,
          locale: user.locale,
          timezone: user.timezone,
        },
        memberships,
      }
    },
  )
}

/** A dummy verify keeps the timing of a missing account like that of a wrong password. */
let dummyHashCache: string | undefined
async function dummyHash(): Promise<string> {
  dummyHashCache ??= await hashPassword(`dummy-${config.APP_SECRET}`)
  return dummyHashCache
}

async function requireAuthenticatedUser(
  app: Parameters<FastifyPluginAsyncZod>[0],
  req: { actor: { kind: string; userId?: string; mfaSatisfied: boolean } },
) {
  if (req.actor.kind !== 'user' || !req.actor.userId) {
    throw app.httpErrors.unauthorized('Authentication required')
  }
  if (!req.actor.mfaSatisfied) throw app.httpErrors.unauthorized('Second factor required')

  const [user] = await app.db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.id, req.actor.userId)))
    .limit(1)
  if (!user) throw app.httpErrors.unauthorized('Authentication required')
  return user
}

export default routes

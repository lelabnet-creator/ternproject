import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import { generateToken, hashPassword, hashToken, verifyPassword } from '@tern/shared'
import { PASSWORD_MIN_LENGTH, PASSWORD_MIN_MESSAGE } from '@tern/shared/password'
import { config } from '../config.js'
import { sendEmail } from '../services/transports.js'
import { renderPasswordReset } from '../services/render.js'
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
import { userMailFor } from '../services/tenant-mail.js'
import {
  authenticationOptions,
  credentialsFor,
  registrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from '../services/webauthn.js'

/**
 * How long a reset link lives.
 *
 * Thirty minutes: long enough to survive a mail server queue and someone
 * reading it on another device, short enough that a link left in a mailbox is
 * not a standing key to the account.
 */
const RESET_TTL_MS = 30 * 60 * 1000

/**
 * Local login with a TOTP second factor, and password recovery by email.
 *
 * The whole route file is rate-limited hard: these endpoints are the ones an
 * attacker actually reaches for, and a correct Argon2 verify is worth nothing
 * if it can be attempted ten thousand times a minute. That limiter is also what
 * keeps `/password/forgot` from being turned into a mail cannon.
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
          newPassword: z.string().min(PASSWORD_MIN_LENGTH, PASSWORD_MIN_MESSAGE),
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

  /**
   * Step one of a reset: ask for a link.
   *
   * Answers 202 for every address, always, whether or not an account exists.
   * The whole point of the generic answer on `/login` is undone if this
   * endpoint will happily confirm which addresses are registered — and this one
   * needs no password at all, so it is the cheaper oracle of the two.
   */
  app.post(
    '/password/forgot',
    {
      schema: {
        body: z.object({ email: z.string().email() }),
        response: { 202: z.object({ sent: z.boolean() }) },
      },
    },
    async (req, reply) => {
      const email = req.body.email.toLowerCase().trim()
      const [user] = await app.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1)

      // A disabled account is not a route back in. It is also not told apart
      // from a missing one in the response.
      if (user && !user.disabledAt) {
        const token = generateToken(32)

        // Any link already outstanding stops working. Two live links means a
        // token stolen from an old mail survives the user asking again, which
        // is exactly the case someone asks again *for*.
        await app.db
          .update(schema.passwordResetTokens)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(schema.passwordResetTokens.userId, user.id),
              isNull(schema.passwordResetTokens.usedAt),
            ),
          )

        await app.db.insert(schema.passwordResetTokens).values({
          userId: user.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + RESET_TTL_MS),
          requestedIp: req.ip,
        })

        const resetUrl = `${config.PUBLIC_BASE_URL}/reset-password?token=${token}`

        try {
          await sendEmail(
            user.email,
            renderPasswordReset(user.locale, resetUrl, RESET_TTL_MS / 60_000),
            // Through the tenant's own sender when it has one. Without this the
            // recovery mail goes out over the instance's environment SMTP,
            // which on an installation configured through the first-run wizard
            // is not set at all — and the failure is swallowed just below.
            { tenantMail: await userMailFor(app, user.id) },
          )
        } catch (error) {
          // A mail server that is down must not turn into a 500 here: the
          // difference between "sent" and "failed to send" is the same oracle
          // this endpoint exists to avoid. It is logged, and the caller is told
          // what every caller is told.
          req.log.error({ err: error }, 'password reset mail failed')
        }

        await audit(app, { action: 'auth.password.reset_requested', actorId: user.id, ip: req.ip })
      } else {
        await audit(app, {
          action: 'auth.password.reset_requested.unknown',
          actorLabel: email,
          ip: req.ip,
        })
      }

      return reply.code(202).send({ sent: true })
    },
  )

  /**
   * Step two: redeem the link.
   *
   * It sets a password and nothing else. No session is issued, so a reset does
   * not walk past the second factor — an account with TOTP still has to present
   * a code at the next sign-in. Anything else would make a mailbox a bypass for
   * MFA, which is the one thing MFA is there to prevent.
   */
  app.post(
    '/password/reset',
    {
      schema: {
        body: z.object({
          token: z.string().min(1),
          newPassword: z.string().min(PASSWORD_MIN_LENGTH, PASSWORD_MIN_MESSAGE),
        }),
        response: { 200: z.object({ ok: z.boolean() }) },
      },
    },
    async (req) => {
      const [row] = await app.db
        .select()
        .from(schema.passwordResetTokens)
        .where(eq(schema.passwordResetTokens.tokenHash, hashToken(req.body.token)))
        .limit(1)

      // One message for expired, already used, and never existed. Which of the
      // three it was is information the holder of a bad token has not earned.
      if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) {
        await audit(app, { action: 'auth.password.reset_rejected', ip: req.ip })
        throw app.httpErrors.badRequest('This link is no longer valid. Ask for a new one.')
      }

      const [user] = await app.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, row.userId))
        .limit(1)
      if (!user || user.disabledAt) {
        throw app.httpErrors.badRequest('This link is no longer valid. Ask for a new one.')
      }

      // Marked used before the password is written, and scoped by `usedAt IS
      // NULL`: two requests racing with the same token both read a live row,
      // and only the one whose UPDATE matches gets to continue.
      const claimed = await app.db
        .update(schema.passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(
          and(eq(schema.passwordResetTokens.id, row.id), isNull(schema.passwordResetTokens.usedAt)),
        )
        .returning({ id: schema.passwordResetTokens.id })

      if (claimed.length === 0) {
        throw app.httpErrors.badRequest('This link is no longer valid. Ask for a new one.')
      }

      await app.db
        .update(schema.users)
        .set({ passwordHash: await hashPassword(req.body.newPassword) })
        .where(eq(schema.users.id, user.id))

      // Same reasoning as a deliberate password change: a reset is usually a
      // response to losing control of the account, so every session goes.
      await destroyUserSessions(app.db, user.id)

      await audit(app, { action: 'auth.password.reset', actorId: user.id, ip: req.ip })
      return { ok: true }
    },
  )

  // ── Passkeys ──────────────────────────────────────────────────────────────
  //
  // A passkey is an additional way into an account that already has a password,
  // never a replacement for one. That is what keeps every account recoverable
  // through a channel that does not depend on a physical device — see the note
  // on hostname binding in services/webauthn.ts.

  // No response schema on the two `options` endpoints, unlike every other route
  // here. What they return is `PublicKeyCredentialCreationOptionsJSON` — a shape
  // defined by the WebAuthn spec, produced by the library and handed to the
  // browser verbatim. Restating it in Zod would be a second copy of somebody
  // else's contract, free to drift from the one that actually matters.
  app.post('/passkeys/register/options', async (req) => {
    const user = await requireAuthenticatedUser(app, req)
    return registrationOptions(app.db, user)
  })

  app.post(
    '/passkeys/register',
    {
      schema: {
        body: z.object({
          // The browser's own payload, passed through untouched. It is verified
          // cryptographically against a stored challenge, so validating its
          // shape here would add a second, weaker check of the same thing.
          response: z.looseObject({ id: z.string() }),
          name: z.string().min(1).max(100),
        }),
        response: {
          200: z.object({
            id: z.string(),
            name: z.string(),
            createdAt: z.string(),
          }),
        },
      },
    },
    async (req) => {
      const user = await requireAuthenticatedUser(app, req)

      const credential = await verifyRegistration(
        app.db,
        user,
        req.body.response as never,
        req.body.name.trim(),
      )
      if (!credential) throw app.httpErrors.badRequest('That passkey could not be registered')

      await audit(app, {
        action: 'auth.passkey.registered',
        actorId: user.id,
        meta: { name: credential.name },
        ip: req.ip,
      })

      return {
        id: credential.id,
        name: credential.name,
        createdAt: credential.createdAt.toISOString(),
      }
    },
  )

  app.get(
    '/passkeys',
    {
      schema: {
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              deviceType: z.string().nullable(),
              backedUp: z.boolean(),
              lastUsedAt: z.string().nullable(),
              createdAt: z.string(),
            }),
          ),
        },
      },
    },
    async (req) => {
      const user = await requireAuthenticatedUser(app, req)
      const rows = await credentialsFor(app.db, user.id)

      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        deviceType: row.deviceType,
        backedUp: row.backedUp,
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      }))
    },
  )

  app.delete(
    '/passkeys/:id',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.object({ ok: z.boolean() }) },
      },
    },
    async (req) => {
      const user = await requireAuthenticatedUser(app, req)

      // Scoped to the caller's own rows: the id is a UUID from a list the user
      // was shown, and without this clause it would be a way to remove somebody
      // else's key by guessing.
      const removed = await app.db
        .delete(schema.webauthnCredentials)
        .where(
          and(
            eq(schema.webauthnCredentials.id, req.params.id),
            eq(schema.webauthnCredentials.userId, user.id),
          ),
        )
        .returning({ name: schema.webauthnCredentials.name })

      if (removed.length === 0) throw app.httpErrors.notFound('No such passkey')

      await audit(app, {
        action: 'auth.passkey.removed',
        actorId: user.id,
        meta: { name: removed[0]?.name },
        ip: req.ip,
      })
      return { ok: true }
    },
  )

  app.post('/passkeys/login/options', async () => authenticationOptions(app.db))

  /**
   * Signing in with a passkey.
   *
   * The session it issues is fully authenticated even for an account with TOTP
   * enabled, and that is deliberate rather than an oversight. A passkey is
   * already two factors in one gesture — possession of the authenticator, plus
   * the biometric or PIN the device asks for — and it is phishing-resistant in
   * a way a typed code is not. Demanding a TOTP code after it would add
   * ceremony without adding a factor.
   */
  app.post(
    '/passkeys/login',
    {
      schema: {
        body: z.object({ response: z.looseObject({ id: z.string() }) }),
        response: {
          200: z.object({
            user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
          }),
        },
      },
    },
    async (req, reply) => {
      const outcome = await verifyAuthentication(app.db, req.body.response as never)

      if (!outcome) {
        await audit(app, { action: 'auth.passkey.failed', ip: req.ip })
        throw app.httpErrors.unauthorized('That passkey was not accepted')
      }

      const [user] = await app.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, outcome.userId))
        .limit(1)

      // A disabled account keeps its passkeys as rows; it must not keep them as
      // a way in. Same rule the password path applies.
      if (!user || user.disabledAt) {
        await audit(app, { action: 'auth.passkey.failed', actorId: outcome.userId, ip: req.ip })
        throw app.httpErrors.unauthorized('That passkey was not accepted')
      }

      const session = await createSession(app.db, {
        userId: user.id,
        mfaSatisfied: true,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      })
      reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt))

      await app.db
        .update(schema.users)
        .set({ lastLoginAt: new Date() })
        .where(eq(schema.users.id, user.id))

      await audit(app, { action: 'auth.passkey.success', actorId: user.id, ip: req.ip })

      return { user: { id: user.id, email: user.email, name: user.name } }
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
              /** Null while this person has never been walked through the admin. */
              tourSeenAt: z.string().nullable(),
            }),
            memberships: z.array(
              z.object({
                tenantId: z.string(),
                slug: z.string(),
                name: z.string(),
                role: z.string(),
                /** The instance's own tenant, which supervises the platform. */
                isSystem: z.boolean(),
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
          isSystem: schema.tenants.isSystem,
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
          tourSeenAt: user.tourSeenAt?.toISOString() ?? null,
        },
        memberships,
      }
    },
  )

  /**
   * Whether this person has been walked through the admin.
   *
   * On the account rather than in local storage: someone shown the tour on
   * their laptop has been shown it, and meeting it again on the machine in the
   * operations room is the product forgetting what it was told. `seen: false` is
   * how the checkbox in Options asks to see it again.
   */
  app.put(
    '/me/tour',
    {
      schema: {
        body: z.object({ seen: z.boolean() }),
        response: { 200: z.object({ tourSeenAt: z.string().nullable() }) },
      },
    },
    async (req) => {
      const user = await requireAuthenticatedUser(app, req)
      const tourSeenAt = req.body.seen ? new Date() : null

      await app.db.update(schema.users).set({ tourSeenAt }).where(eq(schema.users.id, user.id))

      return { tourSeenAt: tourSeenAt?.toISOString() ?? null }
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

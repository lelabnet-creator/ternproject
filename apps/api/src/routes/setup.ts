import { count, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import { config } from '../config.js'
import { hashPassword } from '@tern/shared'
import { PASSWORD_MIN_LENGTH, PASSWORD_MIN_MESSAGE } from '@tern/shared/password'
import { audit } from '../services/audit.js'
import { createSession, SESSION_COOKIE, sessionCookieOptions } from '../services/sessions.js'
import { startLocalAgent } from '../services/local-agent.js'

/**
 * First run: creating the account that will own the instance.
 *
 * A freshly installed instance has a status page and nobody who can administer
 * it. Something has to create that first account, and the alternatives are all
 * worse than this one: a password baked into the image is a published
 * credential, and a password printed in the container logs is a secret sitting
 * in whatever aggregates them.
 *
 * ## The window, stated plainly
 *
 * `POST /setup/account` needs no authentication — it cannot, since there is no
 * account to authenticate as. It is open only while the instance holds **zero**
 * users, and the first successful call closes it permanently: from then on
 * every call answers 409, including calls that arrive concurrently, because the
 * insert runs inside a transaction that re-checks the count.
 *
 * That leaves a real window between the container accepting traffic and the
 * operator reaching the page, during which whoever arrives first becomes the
 * administrator. It is the same trade every self-hosted first-run flow makes.
 * It is written down here rather than implied, and it is why the installer
 * tells the operator to open the page now rather than later. An instance that
 * will sit exposed and unattended should be provisioned with `TERN_ADMIN_EMAIL`
 * and `TERN_ADMIN_PASSWORD` instead, which closes the window before the first
 * request is ever served.
 */

/**
 * Slugs travel in URLs (`/s/<slug>`), so the accepted shape is narrow. Same
 * rule as `packages/db/src/provision.ts`, because a page created here and a
 * page created there must be addressable the same way.
 */
function normaliseSlug(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      // Diacritics folded rather than stripped: without this, "Réseau" becomes
      // "r-seau" instead of "reseau", and every accented name — which is most of
      // them outside English — gets an address nobody would have chosen.
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
  )
}

const routes: FastifyPluginAsyncZod = async (app) => {
  // Same limiter as the auth routes, and for a sharper reason: the guard on
  // account creation is a row count, and a bug in it should not also hand out
  // unlimited attempts.
  await app.register(import('@fastify/rate-limit'), {
    max: config.AUTH_RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
  })

  /** Zero users means nobody can sign in, which is the only thing "first run" means. */
  async function userCount(): Promise<number> {
    const [row] = await app.db.select({ n: count() }).from(schema.users)
    return row?.n ?? 0
  }

  app.get(
    '/setup/state.json',
    {
      schema: {
        response: {
          200: z.object({
            needsSetup: z.boolean(),
            tenant: z.object({ slug: z.string(), name: z.string() }).nullable(),
          }),
        },
      },
    },
    async () => {
      const needsSetup = (await userCount()) === 0

      // Only named while setup is still open, and only then because the screen
      // has to say which page the account being created will administer. Once
      // an account exists this is a sign-in page like any other and volunteers
      // nothing.
      if (!needsSetup) return { needsSetup: false, tenant: null }

      const [tenant] = await app.db
        .select({ slug: schema.tenants.slug, name: schema.tenants.name })
        .from(schema.tenants)
        .where(eq(schema.tenants.isSystem, false))
        .limit(1)

      return { needsSetup: true, tenant: tenant ?? null }
    },
  )

  app.post(
    '/setup/account',
    {
      schema: {
        body: z.object({
          email: z.string().email().max(255),
          name: z.string().min(1).max(200),
          // The same floor `provision.ts` applies, from the same constant —
          // this account holds the instance, and the two paths that can create
          // it must not disagree about what they accept.
          password: z.string().min(PASSWORD_MIN_LENGTH, PASSWORD_MIN_MESSAGE).max(200),

          /**
           * The status page, when the instance does not have one yet.
           *
           * Ignored when it does — an instance provisioned with
           * `TERN_TENANT_SLUG` already has its page, and letting this rename it
           * would make the same field mean two different things.
           */
          tenantName: z.string().min(1).max(200).optional(),
          tenantSlug: z.string().min(1).max(100).optional(),

          /** Taken from the browser rather than asked. */
          locale: z.string().min(2).max(10).optional(),
          timezone: z.string().min(1).max(100).optional(),
        }),
        response: {
          200: z.object({
            user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
            tenant: z.object({ slug: z.string(), name: z.string() }),
          }),
        },
      },
    },
    async (req, reply) => {
      const email = req.body.email.toLowerCase()

      const created = await app.db.transaction(async (tx) => {
        // Re-counted inside the transaction, not reused from the GET above: two
        // requests arriving together would both have seen zero.
        const [row] = await tx.select({ n: count() }).from(schema.users)
        if ((row?.n ?? 0) > 0) return null

        const [existing] = await tx
          .select()
          .from(schema.tenants)
          .where(eq(schema.tenants.isSystem, false))
          .limit(1)

        const locale = req.body.locale?.trim() || 'en'
        const timezone = req.body.timezone?.trim() || 'UTC'

        // Created here when provisioning did not: the page and the account that
        // administers it are one decision, made by one person, in one screen.
        let tenant = existing
        if (!tenant) {
          const name = req.body.tenantName?.trim()
          if (!name) throw app.httpErrors.badRequest('This instance has no status page yet')

          const slug = normaliseSlug(req.body.tenantSlug?.trim() || name)
          if (!slug) throw app.httpErrors.badRequest('That name leaves nothing usable in a URL')
          // `system` is the instance's own supervision scope. A page taking that
          // slug would be indistinguishable from it in every URL.
          if (slug === 'system') throw app.httpErrors.badRequest('“system” is reserved')

          const [row] = await tx
            .insert(schema.tenants)
            .values({ slug, name, defaultLocale: locale, defaultTimezone: timezone })
            .returning()
          if (!row) throw new Error('tenant insert returned no row')
          tenant = row
        }

        const [user] = await tx
          .insert(schema.users)
          .values({
            email,
            name: req.body.name.trim(),
            passwordHash: await hashPassword(req.body.password),
            locale: tenant.defaultLocale,
            timezone: tenant.defaultTimezone,
          })
          .returning()
        if (!user) throw new Error('user insert returned no row')

        await tx
          .insert(schema.memberships)
          .values({ userId: user.id, tenantId: tenant.id, role: 'admin' })

        return { user, tenant }
      })

      if (!created) throw app.httpErrors.conflict('This instance is already set up')

      // Signed in immediately. The next two steps of the wizard — mail, and the
      // test that proves it — go through the ordinary authenticated settings
      // endpoints, so this flow configures nothing that an admin could not
      // configure later from the same screens.
      //
      // MFA is not enrolled here and `mfaSatisfied` is true because the account
      // has no second factor yet. Enrolling one is mandatory for admins and is
      // the first thing the wizard sends them to.
      const session = await createSession(app.db, {
        userId: created.user.id,
        mfaSatisfied: true,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      })
      reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt))

      await audit(app, {
        action: 'setup.account_created',
        tenantId: created.tenant.id,
        actorId: created.user.id,
        meta: { email },
        ip: req.ip,
      })

      // The page exists as of this request, so the instance's own agent can be
      // provisioned for it. Not awaited, and failure is logged rather than
      // raised: the account was created, and reporting that as an error would
      // send the operator back to a form whose work is already done. The plugin
      // tries again at every boot.
      startLocalAgent(app).catch((error) => {
        req.log.error({ err: error }, 'could not start the local agent after setup')
      })

      return {
        user: { id: created.user.id, email: created.user.email, name: created.user.name },
        tenant: { slug: created.tenant.slug, name: created.tenant.name },
      }
    },
  )
}

export default routes

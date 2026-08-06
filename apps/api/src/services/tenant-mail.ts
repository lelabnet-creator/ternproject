import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { schema } from '@tern/db'
import { decryptSecret } from '@tern/shared'
import { config } from '../config.js'
import type { TenantMail } from './transports.js'

/**
 * Resolving a tenant's own mail settings, in one place.
 *
 * This exists because the same lookup was written once, inline, for the mail
 * *test* — and nowhere else. Password recovery and subscriber double opt-in
 * both called `sendEmail` without it, so they went out through the instance's
 * environment SMTP whatever the tenant had configured.
 *
 * The consequence was the worst shape a bug can take: the button labelled
 * "send a test" proved the tenant's settings worked, and then the two messages
 * that actually matter were sent through something else. On an installation
 * configured only through the first-run wizard — which is the normal case, and
 * where `SMTP_HOST` is simply unset — those two silently failed, were logged,
 * and were swallowed on purpose so as not to leak whether an address exists.
 *
 * Every path that sends mail to a person now resolves through here.
 */
export async function tenantMailFor(
  app: FastifyInstance,
  tenantId: string,
): Promise<TenantMail | null> {
  const [tenant] = await app.db
    .select()
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .limit(1)

  if (!tenant?.smtp) return null

  return {
    tenantId: tenant.id,
    host: tenant.smtp.host,
    port: tenant.smtp.port,
    secure: tenant.smtp.secure,
    user: tenant.smtp.user,
    password: tenant.smtpPasswordEnc
      ? decryptSecret(tenant.smtpPasswordEnc, config.APP_SECRET)
      : undefined,
    from: tenant.smtp.from,
  }
}

/**
 * The mail settings to use for a message addressed to a *user* rather than to
 * a tenant's audience.
 *
 * Password recovery is not tenant-scoped — it is reached from a sign-in form
 * that has no slug — so the tenant has to be inferred from the account. An
 * instance serves one status page, so in practice there is exactly one
 * membership and no ambiguity.
 *
 * Where there is more than one, the oldest membership wins rather than the
 * request failing: a recovery mail sent through a plausible sender beats no
 * recovery mail at all, and the alternative is asking someone locked out of
 * their account which tenant they meant.
 */
export async function userMailFor(
  app: FastifyInstance,
  userId: string,
): Promise<TenantMail | null> {
  const [membership] = await app.db
    .select({ tenantId: schema.memberships.tenantId })
    .from(schema.memberships)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.memberships.tenantId))
    .where(and(eq(schema.memberships.userId, userId), eq(schema.tenants.isSystem, false)))
    .orderBy(schema.memberships.createdAt)
    .limit(1)

  if (!membership) return null
  return tenantMailFor(app, membership.tenantId)
}

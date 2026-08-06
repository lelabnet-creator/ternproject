import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import { encryptSecret } from '@tern/shared'
import { config } from '../config.js'
import { audit } from '../services/audit.js'

/**
 * The settings a tenant owns.
 *
 * Split from the notification and capacity routes because those answer "does it
 * work" and "is it big enough"; this one answers "what is it". Everything here
 * is per tenant and safe for a tenant admin to get wrong — which is precisely
 * the test for whether a setting belongs on this surface at all.
 */

const smtpSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().max(255).optional(),
  /** Write-only. Absent means "leave the stored one alone". */
  password: z.string().max(255).optional(),
  from: z.string().min(3).max(255),
})

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/:slug/settings',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('tenant:settings')],
      schema: {
        params: z.object({ slug: z.string() }),
        response: {
          200: z.object({
            name: z.string(),
            slug: z.string(),
            visibility: z.enum(['public', 'private']),
            retentionMode: z.enum(['live', 'historical']),
            retentionDays: z.number(),
            rawRetentionHours: z.number(),
            defaultLocale: z.string(),
            defaultTimezone: z.string(),
            subscriberDisclaimer: z.string().nullable(),
            layout: z.enum(['list', 'grid', 'compact']),
            /** Chosen accent, from the measured set in the web app. */
            accent: z.string(),
            sizingAssumptions: z.object({
              intervalS: z.number(),
              concurrentViewers: z.number(),
            }),
            /** Null means "the instance default is used". Never the password. */
            smtp: z
              .object({
                host: z.string(),
                port: z.number(),
                secure: z.boolean(),
                user: z.string().nullable(),
                from: z.string(),
                hasPassword: z.boolean(),
              })
              .nullable(),
            instanceSmtp: z.object({
              host: z.string(),
              port: z.number(),
              secure: z.boolean(),
              from: z.string(),
            }),
          }),
        },
      },
    },
    async (req) => {
      const [tenant] = await app.db
        .select()
        .from(schema.tenants)
        .where(eq(schema.tenants.id, req.tenant!.id))
        .limit(1)
      if (!tenant) throw app.httpErrors.notFound()

      return {
        name: tenant.name,
        slug: tenant.slug,
        visibility: tenant.visibility,
        retentionMode: tenant.retentionMode,
        retentionDays: tenant.retentionDays,
        rawRetentionHours: tenant.rawRetentionHours,
        defaultLocale: tenant.defaultLocale,
        defaultTimezone: tenant.defaultTimezone,
        subscriberDisclaimer: tenant.subscriberDisclaimer,
        layout: tenant.layout,
        accent: String((tenant.branding as Record<string, unknown>)?.accent ?? 'violet'),
        sizingAssumptions: tenant.sizingAssumptions ?? { intervalS: 60, concurrentViewers: 20 },
        smtp: tenant.smtp
          ? {
              host: tenant.smtp.host,
              port: tenant.smtp.port,
              secure: tenant.smtp.secure,
              user: tenant.smtp.user ?? null,
              from: tenant.smtp.from,
              // Whether one is stored, never what it is.
              hasPassword: Boolean(tenant.smtpPasswordEnc),
            }
          : null,
        instanceSmtp: {
          host: config.SMTP_HOST,
          port: config.SMTP_PORT,
          secure: config.SMTP_SECURE,
          from: config.MAIL_FROM,
        },
      }
    },
  )

  app.patch(
    '/:slug/settings',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('tenant:settings')],
      schema: {
        params: z.object({ slug: z.string() }),
        body: z.object({
          name: z.string().min(1).max(200).optional(),
          visibility: z.enum(['public', 'private']).optional(),
          retentionMode: z.enum(['live', 'historical']).optional(),
          retentionDays: z.number().int().min(7).max(730).optional(),
          rawRetentionHours: z.number().int().min(1).max(8760).optional(),
          defaultLocale: z.string().min(2).max(10).optional(),
          defaultTimezone: z.string().min(1).max(60).optional(),
          subscriberDisclaimer: z.string().max(2000).nullable().optional(),
          accent: z.string().max(30).optional(),
          sizingAssumptions: z
            .object({
              intervalS: z.number().int().min(5).max(86_400),
              concurrentViewers: z.number().int().min(0).max(1_000_000),
            })
            .optional(),
          /** `null` clears the override and returns the tenant to instance mail. */
          smtp: smtpSchema.nullable().optional(),
        }),
        response: { 200: z.object({ ok: z.boolean() }) },
      },
    },
    async (req) => {
      const [tenant] = await app.db
        .select()
        .from(schema.tenants)
        .where(eq(schema.tenants.id, req.tenant!.id))
        .limit(1)
      if (!tenant) throw app.httpErrors.notFound()

      const patch: Record<string, unknown> = {}
      for (const key of [
        'name',
        'visibility',
        'retentionMode',
        'retentionDays',
        'rawRetentionHours',
        'defaultLocale',
        'defaultTimezone',
        'subscriberDisclaimer',
        'sizingAssumptions',
      ] as const) {
        if (req.body[key] !== undefined) patch[key] = req.body[key]
      }

      if (req.body.accent !== undefined) {
        // Merged into branding rather than given a column: it is one of several
        // presentation choices and they belong together.
        patch.branding = { ...(tenant.branding ?? {}), accent: req.body.accent }
      }

      if (req.body.smtp !== undefined) {
        if (req.body.smtp === null) {
          patch.smtp = null
          patch.smtpPasswordEnc = null
        } else {
          const { password, ...rest } = req.body.smtp
          patch.smtp = rest

          // Absent password keeps the stored one: a settings form that wipes a
          // credential because the field was left blank is a form that breaks
          // mail every time somebody renames the server.
          if (password) patch.smtpPasswordEnc = encryptSecret(password, config.APP_SECRET)
        }
      }

      if (Object.keys(patch).length === 0) return { ok: true }

      patch.updatedAt = new Date()
      await app.db.update(schema.tenants).set(patch).where(eq(schema.tenants.id, tenant.id))

      await audit(app, {
        action: 'tenant.settings_updated',
        tenantId: tenant.id,
        actorId: req.actor.userId,
        target: tenant.id,
        // The keys changed, never their values: a disclaimer or a mail server is
        // not a secret, but a password patch must not become one in the log.
        meta: { fields: Object.keys(patch).filter((k) => k !== 'smtpPasswordEnc') },
        ip: req.ip,
      })

      return { ok: true }
    },
  )
}

export default routes

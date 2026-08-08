import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import { encryptSecret } from '@tern/shared'
import { config } from '../config.js'
import { audit, forgetCollector } from '../services/audit.js'
import { forgetTenantMailer } from '../services/transports.js'

/**
 * The settings a tenant owns.
 *
 * Split from the notification and capacity routes because those answer "does it
 * work" and "is it big enough"; this one answers "what is it". Everything here
 * is per tenant and safe for a tenant admin to get wrong — which is precisely
 * the test for whether a setting belongs on this surface at all.
 */

/**
 * The typefaces the web app ships, mirrored here because this value is not
 * data.
 *
 * The accent beside it is accepted as any string up to 30 characters, and gets
 * away with it: an unknown accent id matches nothing in `ACCENTS`, the picker
 * falls back to the default, and the string never leaves JSON. A font id does
 * not stop there — it selects a `--font-sans` value, which is a CSS property on
 * the document root of both the admin and the public status page.
 *
 * `fontById` on the client already refuses to pass an unknown id through to
 * CSS, so this is the second of two locks rather than the only one. It is here
 * because the API should not store a value no client can use, and because the
 * next thing to read `branding.font` — a server-rendered page, an export — must
 * not have to rediscover that constraint.
 *
 * Kept in step with FONTS in apps/web/src/lib/fonts.ts by hand. Two entries,
 * changed when a font is added, which is rarely; a shared package for a pair of
 * strings would cost more to read than it saves.
 */
const FONT_IDS = ['comfortaa', 'nunito'] as const

/**
 * Reads the stored typeface, or the one the interface had before this setting
 * existed.
 *
 * The narrowing is not ceremony. This column is JSON written by earlier
 * versions of this route and by the seed, so it can hold a font id that was
 * dropped, or no `font` key at all; the response schema is an enum, and
 * returning anything else fails serialisation — a 500 on the settings screen
 * because of a decorative preference.
 */
function readFont(branding: unknown): (typeof FONT_IDS)[number] {
  const stored = (branding as Record<string, unknown> | null)?.font
  return FONT_IDS.find((id) => id === stored) ?? 'comfortaa'
}

const smtpSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().max(255).optional(),
  /** Write-only. Absent means "leave the stored one alone". */
  password: z.string().max(255).optional(),
  from: z.string().min(3).max(255),
  /**
   * Accept a handshake OpenSSL would refuse as too weak — in practice a relay
   * still offering a 1024-bit Diffie-Hellman group. Off unless asked for; see
   * `weakTlsOptions` in services/transports.ts for what it actually relaxes.
   */
  allowWeakTls: z.boolean().optional(),
})

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/:slug/settings',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('settings:read')],
      schema: {
        params: z.object({ slug: z.string() }),
        response: {
          200: z.object({
            name: z.string(),
            slug: z.string(),
            retentionMode: z.enum(['live', 'historical']),
            retentionDays: z.number(),
            rawRetentionHours: z.number(),
            auditRetentionDays: z.number(),
            defaultLocale: z.string(),
            defaultTimezone: z.string(),
            subscriberDisclaimer: z.string().nullable(),
            layout: z.enum(['list', 'grid', 'compact', 'custom']),
            /** Chosen accent, from the measured set in the web app. */
            accent: z.string(),
            /** Chosen typeface, one of `FONT_IDS`. */
            font: z.enum(FONT_IDS),
            /** The tenant's own logo, shown in its admin rail. */
            logoUrl: z.string().nullable(),
            /**
             * When the setup wizard was answered, or null if it never was.
             *
             * Served here, and not only inside the public summary's `branding`,
             * because the admin decides whether to show that wizard and must
             * read the answer from somewhere authoritative. The summary carries
             * `Cache-Control: public, max-age=5, stale-while-revalidate=30` —
             * so the refetch right after answering came back with the body from
             * before, the wizard concluded it had not been answered, and put
             * itself back on screen over an administrator who had just
             * dismissed it.
             */
            setupCompletedAt: z.string().nullable(),
            sizingAssumptions: z.object({
              intervalS: z.number(),
              concurrentViewers: z.number(),
            }),
            /** Null when nothing is configured. */
            syslog: z
              .object({
                host: z.string(),
                port: z.number(),
                protocol: z.enum(['udp', 'tcp']),
                facility: z.number(),
                format: z.enum(['rfc5424', 'json']),
                appName: z.string(),
              })
              .nullable(),
            /** Null means "the instance default is used". Never the password. */
            smtp: z
              .object({
                host: z.string(),
                port: z.number(),
                secure: z.boolean(),
                user: z.string().nullable(),
                from: z.string(),
                hasPassword: z.boolean(),
                allowWeakTls: z.boolean(),
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

      const demo = req.role === 'demo'

      return {
        name: tenant.name,
        slug: tenant.slug,
        retentionMode: tenant.retentionMode,
        retentionDays: tenant.retentionDays,
        rawRetentionHours: tenant.rawRetentionHours,
        auditRetentionDays: tenant.auditRetentionDays,
        defaultLocale: tenant.defaultLocale,
        defaultTimezone: tenant.defaultTimezone,
        subscriberDisclaimer: tenant.subscriberDisclaimer,
        layout: tenant.layout,
        accent: String((tenant.branding as Record<string, unknown>)?.accent ?? 'violet'),
        font: readFont(tenant.branding),
        logoUrl: ((tenant.branding as Record<string, unknown>)?.logoUrl as string) ?? null,
        setupCompletedAt:
          ((tenant.branding as Record<string, unknown>)?.setupCompletedAt as string) ?? null,
        sizingAssumptions: tenant.sizingAssumptions ?? { intervalS: 60, concurrentViewers: 20 },
        /*
         * A demo visitor sees the shape, never the addresses.
         *
         * These name the instance's own infrastructure — a mail relay, a log
         * collector — and a demo is a page a stranger opens. Redacted here
         * rather than by withholding the whole screen, because the screen is
         * what the demo exists to show and the hostnames are not.
         */
        syslog: demo ? redactSyslog(tenant.syslog) : (tenant.syslog ?? null),
        smtp: demo
          ? !tenant.smtp
            ? null
            : {
                host: 'redacted.example',
                port: tenant.smtp.port,
                secure: tenant.smtp.secure,
                user: null,
                from: 'status@example.com',
                allowWeakTls: Boolean(tenant.smtp.allowWeakTls),
                hasPassword: Boolean(tenant.smtpPasswordEnc),
              }
          : tenant.smtp
            ? {
                host: tenant.smtp.host,
                port: tenant.smtp.port,
                secure: tenant.smtp.secure,
                user: tenant.smtp.user ?? null,
                from: tenant.smtp.from,
                allowWeakTls: Boolean(tenant.smtp.allowWeakTls),
                // Whether one is stored, never what it is.
                hasPassword: Boolean(tenant.smtpPasswordEnc),
              }
            : null,
        instanceSmtp: demo
          ? { host: 'redacted.example', port: 587, secure: true, from: 'status@example.com' }
          : {
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
          retentionMode: z.enum(['live', 'historical']).optional(),
          retentionDays: z.number().int().min(7).max(730).optional(),
          rawRetentionHours: z.number().int().min(1).max(8760).optional(),
          // 30 days is the floor: below that the trail stops covering the
          // period an incident review actually looks back over.
          auditRetentionDays: z.number().int().min(30).max(3650).optional(),
          defaultLocale: z.string().min(2).max(10).optional(),
          defaultTimezone: z.string().min(1).max(60).optional(),
          subscriberDisclaimer: z.string().max(2000).nullable().optional(),
          accent: z.string().max(30).optional(),
          /** An enum, not a bounded string; see `FONT_IDS`. */
          font: z.enum(FONT_IDS).optional(),
          logoUrl: z.string().url().max(500).nullable().optional(),
          /** Set once, by the first-run wizard, to stop it offering itself again. */
          setupCompleted: z.boolean().optional(),
          sizingAssumptions: z
            .object({
              intervalS: z.number().int().min(5).max(86_400),
              concurrentViewers: z.number().int().min(0).max(1_000_000),
            })
            .optional(),
          /** `null` stops mirroring; the local trail is unaffected either way. */
          syslog: z
            .object({
              host: z.string().min(1).max(255),
              port: z.number().int().min(1).max(65535),
              protocol: z.enum(['udp', 'tcp']),
              facility: z.number().int().min(0).max(23),
              format: z.enum(['rfc5424', 'json']),
              appName: z.string().min(1).max(48),
            })
            .nullable()
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
        'retentionMode',
        'retentionDays',
        'rawRetentionHours',
        'auditRetentionDays',
        'defaultLocale',
        'defaultTimezone',
        'subscriberDisclaimer',
        'sizingAssumptions',
        'syslog',
      ] as const) {
        if (req.body[key] !== undefined) patch[key] = req.body[key]
      }

      // Branding is one column holding several choices, so every one of them
      // has to merge into the *same* object. Two separate spreads of
      // `tenant.branding` meant a request carrying both a logo and an accent
      // kept only the accent — the second assignment overwrote the first,
      // starting from the stored value again.
      const branding = { ...(tenant.branding ?? {}) }
      let brandingTouched = false

      if (req.body.logoUrl !== undefined) {
        branding.logoUrl = req.body.logoUrl
        brandingTouched = true
      }

      if (req.body.accent !== undefined) {
        branding.accent = req.body.accent
        brandingTouched = true
      }

      if (req.body.font !== undefined) {
        branding.font = req.body.font
        brandingTouched = true
      }

      if (req.body.setupCompleted) {
        // A timestamp rather than a flag: "when was this tenant set up" is a
        // question an operator asks, and `true` cannot answer it.
        branding.setupCompletedAt = new Date().toISOString()
        brandingTouched = true
      }

      if (brandingTouched) patch.branding = branding

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

      // Otherwise turning forwarding off leaves it on for up to a minute, which
      // is exactly the minute someone is watching to check that it stopped.
      if (req.body.syslog !== undefined) forgetCollector(tenant.id)

      // The same reasoning, and it was missing: `forgetTenantMailer` existed
      // and nothing called it. A transporter is cached per tenant and holds a
      // connection pool, so a changed host, port, password or TLS setting kept
      // being ignored until the process restarted — including the "send a test"
      // button, which is precisely how somebody checks that a change worked.
      if (req.body.smtp !== undefined) forgetTenantMailer(tenant.id)

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

/** Keeps the shape so the screen renders, drops the host that is not ours to give. */
function redactSyslog<T extends { host: string }>(syslog: T | null | undefined): T | null {
  return syslog ? { ...syslog, host: 'redacted.example' } : null
}

export default routes

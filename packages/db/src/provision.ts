import { eq } from 'drizzle-orm'
import { hashPassword } from '@tern/shared'
import { PASSWORD_MIN_LENGTH } from '@tern/shared/password'
import { createDatabase } from './client.js'
import { loadEnv } from './env.js'
import * as s from './schema/index.js'

loadEnv()

/**
 * Creates the status page this instance serves.
 *
 * This is not `seed.ts`. The seed builds a demo tenant with three months of
 * invented history and a password printed on the terminal — useful to look at,
 * ruinous to deploy. Provisioning creates exactly one tenant and nothing else.
 *
 * The administrator is **not** created here by default. It is created on the
 * first visit to the admin, by the person sitting in front of it, so the
 * password is never typed into a shell, written to `.env`, or printed in a
 * container log — see `apps/api/src/routes/setup.ts`.
 *
 * `TERN_ADMIN_EMAIL` and `TERN_ADMIN_PASSWORD` remain honoured for the case
 * that flow does not serve: an instance that will be exposed before anyone
 * opens it. Setting them creates the account here and closes the first-run
 * window before the first request is served.
 *
 * Idempotent, because it runs from the container entrypoint on every boot: a
 * restart must not fail on the unique constraint, and must never reset the
 * password of an account already in use.
 */

/**
 * Slugs travel in URLs (`/s/<slug>`), so the accepted shape is narrow and
 * checked here rather than left to produce a confusing 404 later.
 */
function normaliseSlug(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    // Diacritics folded rather than stripped: without this, "Réseau" becomes
    // "r-seau" instead of "reseau", and every accented name — which is most of
    // them outside English — gets an address nobody would have chosen.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')

  if (!slug) {
    console.error(`✗ TERN_TENANT_SLUG "${raw}" leaves nothing usable in a URL`)
    process.exit(1)
  }
  return slug
}

async function main() {
  const slug = normaliseSlug(process.env.TERN_TENANT_SLUG ?? '')
  const name = process.env.TERN_TENANT_NAME?.trim() || slug
  const locale = process.env.TERN_DEFAULT_LOCALE?.trim() || 'en'
  const timezone = process.env.TERN_DEFAULT_TIMEZONE?.trim() || 'UTC'

  // Optional, and both or neither: an address with no password creates an
  // account nobody can sign into, which looks like success and is not.
  const adminEmail = process.env.TERN_ADMIN_EMAIL?.trim().toLowerCase() || ''
  const adminPassword = process.env.TERN_ADMIN_PASSWORD ?? ''

  if (Boolean(adminEmail) !== Boolean(adminPassword)) {
    console.error('✗ TERN_ADMIN_EMAIL and TERN_ADMIN_PASSWORD must be set together, or neither')
    process.exit(1)
  }
  if (adminPassword && adminPassword.length < PASSWORD_MIN_LENGTH) {
    console.error(`✗ TERN_ADMIN_PASSWORD must be at least ${PASSWORD_MIN_LENGTH} characters`)
    process.exit(1)
  }

  const { db, sql } = createDatabase(undefined, { max: 1 })

  try {
    const [existingTenant] = await db.select().from(s.tenants).where(eq(s.tenants.slug, slug))

    if (existingTenant) {
      console.warn(`· tenant "${slug}" already exists — leaving it untouched`)
      return
    }

    console.warn(`→ creating tenant "${slug}"`)
    const [tenant] = await db
      .insert(s.tenants)
      .values({
        slug,
        name,
        defaultLocale: locale,
        defaultTimezone: timezone,
      })
      .returning()
    if (!tenant) throw new Error('tenant insert returned no row')

    if (adminEmail) {
      // Users are global, not per-tenant: an operator provisioning a second
      // tenant with the same address should get a second membership, not a
      // duplicate-key crash.
      const [existingUser] = await db.select().from(s.users).where(eq(s.users.email, adminEmail))

      let adminId: string
      if (existingUser) {
        console.warn(`· user ${adminEmail} already exists — reusing it, password unchanged`)
        adminId = existingUser.id
      } else {
        console.warn(`→ creating administrator ${adminEmail}`)
        const [admin] = await db
          .insert(s.users)
          .values({
            email: adminEmail,
            name: process.env.TERN_ADMIN_NAME?.trim() || adminEmail.split('@')[0] || adminEmail,
            passwordHash: await hashPassword(adminPassword),
            locale,
            timezone,
          })
          .returning()
        if (!admin) throw new Error('user insert returned no row')
        adminId = admin.id
      }

      await db.insert(s.memberships).values({ userId: adminId, tenantId: tenant.id, role: 'admin' })
    }

    console.warn('✓ provisioning complete')
    console.warn(`  status page   /s/${slug}`)
    console.warn(`  admin         /app/${slug}`)
    if (!adminEmail) {
      console.warn('  no account yet — open the admin to create it')
    }
  } finally {
    await sql.end()
  }
}

main().catch((error) => {
  console.error('✗ provisioning failed:', error)
  process.exit(1)
})

import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { retentionMode, tenantVisibility } from './enums.js'

/**
 * A tenant is one customer and one status page. Every other business table
 * carries `tenant_id`, and the API resolves the current tenant once per request
 * so isolation is enforced in one place rather than remembered at each query.
 */
export const tenants = pgTable(
  'tenants',
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull().unique(),
    name: text().notNull(),
    visibility: tenantVisibility().notNull().default('private'),

    // Display mode. `live` hides the period selector entirely; `historical`
    // unlocks the long-window charts.
    retentionMode: retentionMode().notNull().default('historical'),
    /** How long raw per-check rows are kept. */
    rawRetentionHours: integer().notNull().default(168),
    /** How long aggregated history is kept. Ignored in `live` mode. */
    retentionDays: integer().notNull().default(90),
    rollupsEnabled: boolean().notNull().default(true),

    /** Tenant branding: logo URL, accent colour, footer text. */
    branding: jsonb().$type<Record<string, unknown>>().notNull().default({}),

    defaultLocale: text().notNull().default('en'),
    defaultTimezone: text().notNull().default('UTC'),
    /** Shown on the subscription form — jurisdictions differ, so it is text. */
    subscriberDisclaimer: text(),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('tenants_visibility_idx').on(t.visibility)],
)

/**
 * CIDR ranges allowed to read a private tenant's page without logging in.
 * Complements QR viewer access for internal pages reachable from the corporate
 * network.
 */
export const ipAllowlist = pgTable(
  'ip_allowlist',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    cidr: text().notNull(),
    label: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ip_allowlist_tenant_idx').on(t.tenantId)],
)

/** Custom domains pointed at the instance by CNAME, verified by TXT record. */
export const domains = pgTable(
  'domains',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    hostname: text().notNull().unique(),
    verificationToken: text().notNull(),
    verifiedAt: timestamp({ withTimezone: true }),
    certStatus: text().notNull().default('pending'),
    certExpiresAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('domains_tenant_idx').on(t.tenantId)],
)

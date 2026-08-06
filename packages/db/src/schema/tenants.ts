import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { pageLayout, retentionMode, tenantVisibility } from './enums.js'

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

    /**
     * Marks the tenant whose admins operate the instance itself.
     *
     * A flag rather than a reserved slug: a magic string in the code means a
     * customer signing up as "system" would inherit the whole platform, and
     * that is not a mistake anyone should be able to make by typing.
     *
     * Its members see load and health across every tenant. They do not gain
     * write access to other tenants' data — supervision is not administration,
     * and the audit trail would not survive conflating them.
     */
    isSystem: boolean().notNull().default(false),

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

    /**
     * How densely the public page lays its components out. Ordering lives on
     * `controls.position` and `control_groups.position`, which already exist —
     * this is only the density.
     */
    layout: pageLayout().notNull().default('list'),

    defaultLocale: text().notNull().default('en'),
    defaultTimezone: text().notNull().default('UTC'),
    /** Shown on the subscription form — jurisdictions differ, so it is text. */
    subscriberDisclaimer: text(),

    /**
     * Per-tenant mail, overriding the instance's SMTP.
     *
     * Optional by design: most installations want one sender and one
     * reputation, and the instance default remains the answer when this is
     * null. A tenant that must send as itself — its own domain, its own
     * deliverability — sets it here.
     *
     * The password is not in this object. It is encrypted beside it, because a
     * settings blob gets logged, diffed and exported by things that have no
     * business holding a credential.
     */
    smtp: jsonb().$type<{
      host: string
      port: number
      secure: boolean
      user?: string
      from: string
    } | null>(),
    smtpPasswordEnc: text(),

    /**
     * What the Capacity calculator should assume about this deployment.
     *
     * Saved because the alternative is re-typing the shape of your own fleet
     * every time you open the screen, and because the numbers it produces are
     * only as good as the assumptions behind them — which are worth recording
     * rather than re-guessing.
     */
    sizingAssumptions: jsonb().$type<{ intervalS: number; concurrentViewers: number }>(),

    /**
     * Where this tenant's audit events are mirrored, when it wants them
     * elsewhere.
     *
     * Mirrored rather than moved: the local trail stays whatever happens to the
     * far end, because a log that only exists on a host you cannot reach during
     * an incident is not a log you have.
     */
    /**
     * How long the audit trail is kept, in days.
     *
     * A trail nobody prunes grows without bound and eventually becomes the
     * largest table in the database for the least-read data in it. A year is
     * the default because that is the usual horizon for "who changed this".
     */
    auditRetentionDays: integer().notNull().default(365),

    syslog: jsonb().$type<{
      host: string
      port: number
      protocol: 'udp' | 'tcp'
      facility: number
      format: 'rfc5424' | 'json'
      appName: string
    } | null>(),

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

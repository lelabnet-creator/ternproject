import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { pageLayout, retentionMode } from './enums.js'

/**
 * A tenant is one customer and one status page. Every other business table
 * carries `tenant_id`, and the API resolves the current tenant once per request
 * so isolation is enforced in one place rather than remembered at each query.
 *
 * A status page is readable by anyone who has its address. This edition has no
 * public/private distinction — the page is public, full stop. Gating it behind
 * authentication, and the IP allowlist that softened that gate, belong to the
 * hosted edition.
 */
export const tenants = pgTable(
  'tenants',
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull().unique(),
    name: text().notNull(),

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

    /**
     * The document a `custom` layout renders.
     *
     * Only read when `layout` is `custom`, and stored rather than generated so
     * an operator keeps what they wrote across a change of mind about the mode.
     *
     * Rendered inside a sandboxed iframe with no `allow-same-origin`, so it
     * runs in an opaque origin: no cookies, no session, no parent DOM, and a
     * CSP that denies the network. That is what makes storing raw HTML, CSS and
     * script defensible where injecting it into the page would not be — the
     * document can arrange pixels and nothing else. The status data it draws is
     * handed in by the parent, precisely so it never needs to fetch anything.
     * See `docs/security.md`.
     */
    customHtml: text(),
    customCss: text(),
    customJs: text(),

    /**
     * A page carrying synthetic data, shown as such.
     *
     * The seeded tenant sets it. It changes two things: the public page says
     * plainly that nothing here is real and offers to create a page that is,
     * and the admin becomes reachable without signing in — so the product can
     * be looked at rather than described. Neither is ever true of a tenant an
     * operator provisioned.
     */
    isDemo: boolean().notNull().default(false),

    /**
     * Refuses every write, whoever is asking.
     *
     * Enforced once, in the permission layer, rather than per route: a check
     * repeated at forty call sites is a check missing from the forty-first. It
     * is what makes an unauthenticated demo admin safe to offer — a visitor can
     * open every screen and change nothing.
     */
    readOnly: boolean().notNull().default(false),

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
      /**
       * Accept a TLS handshake OpenSSL would otherwise refuse as too weak.
       *
       * Off unless asked for. It exists because a relay nobody controls — an
       * old corporate Postfix, a hosted box untouched for a decade — commonly
       * still offers a 1024-bit Diffie-Hellman group, which OpenSSL 3 rejects
       * outright. On port 25 the realistic alternative to a weak handshake is
       * not a stronger one, it is cleartext, so this is worth having; it is a
       * decision for whoever owns the relay, which is why it is a per-tenant
       * setting rather than a default.
       *
       * Not a migration: `smtp` is JSONB, so an absent key reads as off.
       */
      allowWeakTls?: boolean
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
  // No secondary index: `slug` is already unique, which is the only lookup this
  // table gets.
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

import {
  boolean,
  index,
  inet,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { memberRole } from './enums.js'
import { tenants } from './tenants.js'

/**
 * A user is global; membership grants a role *per tenant*. The same person can
 * administer one tenant and merely read another, which is what makes a shared
 * instance usable by MSPs.
 */
export const users = pgTable('users', {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique(),
  name: text().notNull(),
  /** Argon2id. Never a hash the application can reverse. */
  passwordHash: text().notNull(),

  // TOTP secret is stored encrypted with APP_SECRET (AES-256-GCM), not plain:
  // a database dump should not hand over everyone's second factor.
  mfaSecretEnc: text(),
  mfaEnabled: boolean().notNull().default(false),
  /** Hashed single-use recovery codes. */
  mfaBackupCodes: jsonb().$type<string[]>().notNull().default([]),

  locale: text().notNull().default('en'),
  timezone: text().notNull().default('UTC'),
  lastLoginAt: timestamp({ withTimezone: true }),
  disabledAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

export const memberships = pgTable(
  'memberships',
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    role: memberRole().notNull().default('visitor'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.tenantId] }),
    index('memberships_tenant_idx').on(t.tenantId),
  ],
)

/**
 * Opaque server-side sessions rather than JWTs: revocation has to be immediate
 * (a revoked viewer device, a disabled admin), and a stateless token cannot do
 * that honestly.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the cookie value; the raw token never touches the database. */
    tokenHash: text().notNull().unique(),

    /**
     * False between password verification and TOTP verification. Admin routes
     * reject the session until this flips, so a stolen password alone is not a
     * session.
     */
    mfaSatisfied: boolean().notNull().default(false),

    /** Set for QR-paired read-only sessions; null for regular logins. */
    viewerTokenId: uuid(),
    tenantId: uuid().references(() => tenants.id, { onDelete: 'cascade' }),

    ip: inet(),
    userAgent: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
)

/**
 * Password reset tokens.
 *
 * A row per request rather than a column on the user, so an unused token from
 * a previous attempt can be invalidated explicitly and the whole history stays
 * auditable. Only the hash is stored: a database dump must not hand out the
 * links needed to take over every account.
 *
 * `usedAt` rather than a delete on redemption — a reset that turns out to be
 * an attack is a thing an administrator needs to be able to see afterwards.
 */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the value in the emailed link. */
    tokenHash: text().notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
    /** Where the request came from, which is the only forensic value here. */
    requestedIp: inet(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('password_reset_user_idx').on(t.userId),
    index('password_reset_expires_idx').on(t.expiresAt),
  ],
)

/** Append-only trail of who did what. Exportable as CSV by admins. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid().references(() => tenants.id, { onDelete: 'cascade' }),
    actorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    /** Free-form actor label for non-user actors: an agent, a receiver, "anonymous". */
    actorLabel: text(),
    action: text().notNull(),
    target: text(),
    meta: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    ip: inet(),
    ts: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_log_tenant_ts_idx').on(t.tenantId, t.ts)],
)

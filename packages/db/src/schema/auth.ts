import {
  bigint,
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

/**
 * Passkeys — WebAuthn credentials, one row per authenticator.
 *
 * Several per account on purpose. A passkey lives in one place: a laptop's
 * secure enclave, a phone, a security key. One row per account would mean
 * losing the device is losing the method, and would make "add my phone too"
 * impossible — which is the ordinary case, not the exotic one.
 *
 * These are additions, never a replacement: `users.passwordHash` stays
 * mandatory, so no account can end up reachable only through a device that can
 * be dropped in a river. That also keeps the recovery path already built —
 * email plus a reset link — meaningful for every account.
 *
 * Nothing here is secret. A public key is public, which is the entire point of
 * WebAuthn: a database dump yields nothing that can be replayed against the
 * account, unlike a password hash, which at least invites cracking.
 */
export const webauthnCredentials = pgTable(
  'webauthn_credentials',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * The authenticator's credential ID, base64url as the browser reports it.
     * Unique across the instance: it is what an assertion arrives carrying, and
     * it has to identify one row without being told which user to look in.
     */
    credentialId: text().notNull().unique(),
    /** COSE public key, base64url. Verifies signatures; secret of nothing. */
    publicKey: text().notNull(),

    /**
     * The authenticator's signature counter.
     *
     * `bigint` because the spec allows a 32-bit unsigned value and `integer`
     * would overflow at half of it. Stored as a number in JS since it never
     * approaches 2^53. A counter that fails to advance is the one clone signal
     * WebAuthn gives — many modern authenticators report a constant 0, so it is
     * recorded and checked, not blindly trusted.
     */
    counter: bigint({ mode: 'number' }).notNull().default(0),

    /** Named by the person, so a list of four keys is not four opaque rows. */
    name: text().notNull(),
    /** `platform` (this device) or `cross-platform` (a key you carry). */
    deviceType: text(),
    /** Whether the authenticator says it syncs across the owner's devices. */
    backedUp: boolean().notNull().default(false),
    transports: jsonb().$type<string[]>().notNull().default([]),

    lastUsedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('webauthn_credentials_user_idx').on(t.userId)],
)

/**
 * Challenges awaiting an answer.
 *
 * Server-side rather than in a cookie or a signed token, because the one thing
 * a challenge must guarantee is single use: a replayed assertion has to fail,
 * and it can only be made to fail by deleting the row that accepted it. They
 * live about two minutes — long enough to find a security key in a drawer,
 * short enough not to accumulate.
 *
 * `userId` is null for a sign-in challenge: at that point nobody has said who
 * they are, and the assertion itself names the credential.
 */
export const webauthnChallenges = pgTable(
  'webauthn_challenges',
  {
    id: uuid().primaryKey().defaultRandom(),
    challenge: text().notNull().unique(),
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    /** `register` or `authenticate` — a registration challenge must not sign anyone in. */
    kind: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('webauthn_challenges_expires_idx').on(t.expiresAt)],
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

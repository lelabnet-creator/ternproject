import { index, inet, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { agentStatus, apiKeyScope } from './enums.js'
import { tenants } from './tenants.js'
import { users } from './auth.js'

/**
 * Long-lived credentials for machines. Only the hash is kept: the plaintext is
 * shown exactly once, at creation, and cannot be recovered afterwards.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    keyHash: text().notNull().unique(),
    /** Displayed in the UI so a key is recognisable without revealing it. */
    keyPrefix: text().notNull(),
    scopes: apiKeyScope().array().notNull().default(['ingest']),
    /** Empty = every control in the tenant. */
    scopeControlIds: uuid().array().notNull().default([]),
    /** Let unknown control keys create controls on first push. */
    autoRegister: jsonb().$type<boolean>().notNull().default(false),

    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    lastUsedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('api_keys_tenant_idx').on(t.tenantId)],
)

/**
 * Short-lived PIN used to pair an agent without anyone copying a 64-character
 * secret onto a remote host. The PIN itself grants nothing: it can only be
 * exchanged for an ingest-scoped API key, once, within minutes.
 */
export const pairingCodes = pgTable(
  'pairing_codes',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    codeHash: text().notNull().unique(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),

    expiresAt: timestamp({ withTimezone: true }).notNull(),
    maxUses: integer().notNull().default(1),
    usedCount: integer().notNull().default(0),
    /** Locks the code after repeated wrong guesses. */
    failedAttempts: integer().notNull().default(0),

    scopeControlIds: uuid().array().notNull().default([]),
    autoRegister: jsonb().$type<boolean>().notNull().default(true),

    consumedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('pairing_codes_tenant_idx').on(t.tenantId, t.expiresAt)],
)

/** A paired agent is a first-class object: listable, revocable, rotatable. */
export const agents = pgTable(
  'agents',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    hostname: text(),
    os: text(),
    arch: text(),
    agentVersion: text(),

    apiKeyId: uuid().references(() => apiKeys.id, { onDelete: 'set null' }),
    pairingCodeId: uuid().references(() => pairingCodes.id, { onDelete: 'set null' }),

    status: agentStatus().notNull().default('active'),
    lastSeenAt: timestamp({ withTimezone: true }),
    pairedIp: inet(),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agents_tenant_idx').on(t.tenantId)],
)

/**
 * Read-only access granted by QR code. Never maps to a real user account — a
 * viewer session carries a virtual `visitor` role and nothing else.
 */
export const viewerTokens = pgTable(
  'viewer_tokens',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    label: text().notNull(),
    tokenHash: text().notNull().unique(),
    /** Empty = every public control in the tenant. */
    scopeControlIds: uuid().array().notNull().default([]),

    expiresAt: timestamp({ withTimezone: true }),
    maxDevices: integer().notNull().default(5),

    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('viewer_tokens_tenant_idx').on(t.tenantId)],
)

/** One row per device that redeemed a viewer token, so each can be revoked alone. */
export const viewerDevices = pgTable(
  'viewer_devices',
  {
    id: uuid().primaryKey().defaultRandom(),
    viewerTokenId: uuid()
      .notNull()
      .references(() => viewerTokens.id, { onDelete: 'cascade' }),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    deviceHash: text().notNull(),
    userAgent: text(),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index('viewer_devices_token_idx').on(t.viewerTokenId)],
)

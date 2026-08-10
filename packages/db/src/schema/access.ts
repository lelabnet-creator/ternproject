import {
  boolean,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { agentRole, agentStatus, apiKeyScope } from './enums.js'
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

    /**
     * Where this agent is, in the operator's own words: a data centre, a
     * customer site, a region. Free text rather than a foreign key to the
     * control group tree — a fleet is organised by geography and ownership,
     * which rarely matches how the status page is grouped.
     */
    site: text(),

    apiKeyId: uuid().references(() => apiKeys.id, { onDelete: 'set null' }),
    pairingCodeId: uuid().references(() => pairingCodes.id, { onDelete: 'set null' }),

    /**
     * The instance's own agent — `Agent-local-tern`.
     *
     * It is not paired: there is no PIN and no `pairing_code_id`, because the
     * server that would issue the code is the server that runs the agent.
     * It provisions the key and writes the config directly, which removes a
     * round trip that could only ever fail against itself.
     *
     * Set on exactly one row per tenant, and it is what makes that row
     * undeletable. Deleting it would leave a config file on disk holding a key
     * for an agent the server no longer knows, and the next reconcile would
     * make a second one. An operator who genuinely does not want it turns it
     * off with `TERN_LOCAL_AGENT=false`, which is a decision about the
     * instance rather than a row to remove.
     */
    isLocal: boolean().notNull().default(false),

    role: agentRole().notNull().default('agent'),
    /**
     * The proxy this agent reports through, when it does not reach TERN itself.
     *
     * Written by the proxy's own inventory push, never by the agent — an agent
     * behind a proxy never talks to this server and could not say. `set null`
     * rather than a cascade: losing the relay must not delete the record of what
     * was behind it, which is exactly what somebody investigates next.
     */
    parentAgentId: uuid(),
    status: agentStatus().notNull().default('active'),
    lastSeenAt: timestamp({ withTimezone: true }),
    pairedIp: inet(),
    /**
     * The `host:port` a relay serves its zone on, as the relay itself reports.
     *
     * Null for anything that is not a relay, and for a relay too old to say.
     *
     * `pairedIp` cannot answer this, and assuming it could was a real mistake:
     * it holds the address a connection *arrived from* as this server saw it,
     * which — with TERN in a container and the relay on the host — is a Docker
     * bridge gateway. The admin offered that as the address to reach the relay
     * on, and it is meaningless anywhere but on that host. The relay is the only
     * thing that knows where it binds, so the relay is what says it.
     */
    zoneAddress: text(),
    /**
     * Every address this relay could be dialled on, as it reports them.
     *
     * A list rather than one value because a relay bound to every interface has
     * no single address, and one with two cards has a right answer and a wrong
     * one that only its operator can tell apart. Offering the choice is what
     * stops this server from guessing — which it did, wrongly, from `pairedIp`.
     */
    zoneAddresses: jsonb().$type<string[]>().notNull().default([]),
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

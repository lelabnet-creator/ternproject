import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { notificationStatus, receiverKind, subscriberChannel } from './enums.js'
import { tenants } from './tenants.js'

/**
 * Someone who asked to hear about this tenant's incidents.
 *
 * Addresses are encrypted at rest: a status page subscriber list is a mailing
 * list of a company's customers, and a database leak should not hand it over.
 */
export const subscribers = pgTable(
  'subscribers',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    channel: subscriberChannel().notNull(),
    /** AES-256-GCM under APP_SECRET. */
    addressEnc: text().notNull(),
    /** Blind index so duplicate signups can be detected without decrypting. */
    addressHash: text().notNull(),

    /** Shared secret for webhook signatures. Null for other channels. */
    webhookSecretEnc: text(),

    /** Empty = every public control. */
    scopeControlIds: uuid().array().notNull().default([]),
    locale: text().notNull().default('en'),

    /**
     * Double opt-in. Nothing is ever sent to an unconfirmed address beyond the
     * single confirmation message, and unconfirmed rows are purged after 7 days.
     */
    confirmedAt: timestamp({ withTimezone: true }),
    confirmTokenHash: text(),
    unsubscribeTokenHash: text().notNull(),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('subscribers_tenant_idx').on(t.tenantId),
    index('subscribers_address_idx').on(t.tenantId, t.addressHash),
    index('subscribers_unconfirmed_idx').on(t.confirmedAt),
  ],
)

/**
 * Outbound delivery queue. Persisted rather than fired inline so a failing SMTP
 * server delays notifications instead of losing them, and so every send is
 * auditable.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    subscriberId: uuid().references(() => subscribers.id, { onDelete: 'cascade' }),

    eventType: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),

    status: notificationStatus().notNull().default('pending'),
    attempts: integer().notNull().default(0),
    /** Exponential backoff target; the worker only picks up rows that are due. */
    nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastError: text(),
    sentAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notifications_pending_idx').on(t.status, t.nextAttemptAt),
    index('notifications_tenant_idx').on(t.tenantId),
  ],
)

/**
 * Inbound webhook endpoint that normalises a third-party alert into a check or
 * an incident. Most teams already run monitoring; this is how they keep it.
 */
export const receivers = pgTable(
  'receivers',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    kind: receiverKind().notNull(),
    tokenHash: text().notNull().unique(),

    /** Source-to-control mapping rules; JSONPath based for `generic`. */
    mapping: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** Open and close incidents automatically from the source's resolved flag. */
    manageIncidents: boolean().notNull().default(false),

    enabled: boolean().notNull().default(true),
    lastReceivedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('receivers_tenant_idx').on(t.tenantId)],
)

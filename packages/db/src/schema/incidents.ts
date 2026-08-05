import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  incidentImpact,
  incidentSeverity,
  incidentStatus,
  maintenanceStatus,
  templateKind,
} from './enums.js'
import { controls } from './controls.js'
import { tenants } from './tenants.js'
import { users } from './auth.js'

export const incidents = pgTable(
  'incidents',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    severity: incidentSeverity().notNull().default('minor'),
    status: incidentStatus().notNull().default('investigating'),

    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp({ withTimezone: true }),

    /** Written after the fact, published separately from resolving the incident. */
    postmortemBody: text(),
    postmortemPublishedAt: timestamp({ withTimezone: true }),

    isPublic: boolean().notNull().default(true),
    /** Set when a receiver opened the incident, so it can also close it. */
    createdByReceiverId: uuid(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('incidents_tenant_started_idx').on(t.tenantId, t.startedAt.desc()),
    index('incidents_status_idx').on(t.status),
  ],
)

/**
 * Impact is recorded per component, not once per incident: a single event
 * usually degrades one thing and takes down another, and collapsing that into
 * one severity is what makes status pages misleading.
 */
export const incidentImpacts = pgTable(
  'incident_impacts',
  {
    incidentId: uuid()
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    controlId: uuid()
      .notNull()
      .references(() => controls.id, { onDelete: 'cascade' }),
    impact: incidentImpact().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.incidentId, t.controlId] }),
    index('incident_impacts_control_idx').on(t.controlId),
  ],
)

export const incidentUpdates = pgTable(
  'incident_updates',
  {
    id: uuid().primaryKey().defaultRandom(),
    incidentId: uuid()
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    authorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    status: incidentStatus().notNull(),
    body: text().notNull(),
    /** Whether this update fanned out to subscribers. */
    notify: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('incident_updates_incident_idx').on(t.incidentId, t.createdAt)],
)

/**
 * Planned work, kept apart from incidents: it is announced in advance, it has a
 * window, and it should silence alerting rather than trigger it.
 */
export const maintenances = pgTable(
  'maintenances',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    body: text(),
    status: maintenanceStatus().notNull().default('scheduled'),

    scheduledStart: timestamp({ withTimezone: true }).notNull(),
    scheduledEnd: timestamp({ withTimezone: true }).notNull(),
    actualStart: timestamp({ withTimezone: true }),
    actualEnd: timestamp({ withTimezone: true }),

    /** Let the scheduler move it to in_progress/completed on its own. */
    autoTransition: boolean().notNull().default(true),
    /** Minutes before the window at which to remind subscribers. */
    remindersBeforeMin: jsonb().$type<number[]>().notNull().default([1440, 60]),
    remindersSentAt: jsonb().$type<number[]>().notNull().default([]),

    /** Suppress status alerts for affected controls during the window. */
    suppressAlerts: boolean().notNull().default(true),
    isPublic: boolean().notNull().default(true),

    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('maintenances_tenant_start_idx').on(t.tenantId, t.scheduledStart)],
)

export const maintenanceControls = pgTable(
  'maintenance_controls',
  {
    maintenanceId: uuid()
      .notNull()
      .references(() => maintenances.id, { onDelete: 'cascade' }),
    controlId: uuid()
      .notNull()
      .references(() => controls.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.maintenanceId, t.controlId] }),
    index('maintenance_controls_control_idx').on(t.controlId),
  ],
)

export const maintenanceUpdates = pgTable(
  'maintenance_updates',
  {
    id: uuid().primaryKey().defaultRandom(),
    maintenanceId: uuid()
      .notNull()
      .references(() => maintenances.id, { onDelete: 'cascade' }),
    authorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    status: maintenanceStatus().notNull(),
    body: text().notNull(),
    notify: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('maintenance_updates_maintenance_idx').on(t.maintenanceId, t.createdAt)],
)

/**
 * Reusable wording. Crisis communication is the one moment nobody has time to
 * write well, so the phrasing is prepared beforehand.
 */
export const templates = pgTable(
  'templates',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    kind: templateKind().notNull(),
    name: text().notNull(),
    /** Supports {{component}}, {{eta}}, {{start}} placeholders. */
    titleTpl: text(),
    bodyTpl: text().notNull(),
    defaultStatus: text(),
    defaultImpact: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('templates_tenant_kind_idx').on(t.tenantId, t.kind)],
)

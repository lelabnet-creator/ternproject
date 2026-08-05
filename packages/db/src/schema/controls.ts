import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { controlKind, statusRollup } from './enums.js'
import { tenants } from './tenants.js'

/**
 * Groups form a tree (depth capped at 3 in the API). This is what lets a tenant
 * model "Europe > Paris > API" or "Platform > Databases" instead of a flat list,
 * and it doubles as the geographic breakdown other status pages ship as a
 * separate "locations" feature.
 */
export const controlGroups = pgTable(
  'control_groups',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    parentId: uuid().references((): AnyPgColumn => controlGroups.id, {
      onDelete: 'cascade',
    }),
    name: text().notNull(),
    description: text(),
    position: integer().notNull().default(0),
    statusRollup: statusRollup().notNull().default('worst'),
    collapsedByDefault: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('control_groups_tenant_idx').on(t.tenantId),
    index('control_groups_parent_idx').on(t.parentId),
  ],
)

/**
 * A control is one monitored thing. `key` is the stable identifier scripts and
 * agents push against — renaming the display name must never break ingestion,
 * which is why the two are separate columns.
 */
export const controls = pgTable(
  'controls',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    groupId: uuid().references(() => controlGroups.id, { onDelete: 'set null' }),

    key: text().notNull(),
    name: text().notNull(),
    description: text(),
    kind: controlKind().notNull().default('push'),

    /** Probe specification (see @tern/shared `probe.ts`). Empty for `push`. */
    config: jsonb().$type<Record<string, unknown>>().notNull().default({}),

    /**
     * For push controls: how often we expect to hear from the source. The
     * sweeper marks a control `unknown` past 2x this interval — silence is
     * reported as silence, not invented as an outage.
     */
    expectedIntervalS: integer(),
    degradedThresholdMs: integer(),
    downThresholdMs: integer(),

    /** Unit and label for controls reporting a numeric value rather than a status. */
    valueUnit: text(),
    valueLabel: text(),

    /** Availability target, used to compute the remaining error budget. */
    slaTarget: integer(),

    /** Visible on the public page. Private controls need `status:read:all`. */
    isPublic: boolean().notNull().default(true),
    enabled: boolean().notNull().default(true),
    position: integer().notNull().default(0),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('controls_tenant_key_uq').on(t.tenantId, t.key),
    index('controls_tenant_idx').on(t.tenantId),
    index('controls_group_idx').on(t.groupId),
  ],
)

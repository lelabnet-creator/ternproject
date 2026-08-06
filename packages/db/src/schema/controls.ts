import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { controlKind, probePolicy, statusRollup } from './enums.js'
import { agents } from './access.js'
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

    /**
     * Which visualisation represents this control on the status page.
     *
     * Resolved against `charts/registry.ts`, which is also what decides the
     * payload shape the generated scripts push — so the widget and the script
     * that feeds it cannot disagree.
     *
     * Defaults to the ribbon, which is what every existing control already
     * renders.
     */
    /** Who runs this probe when several agents could. See `probePolicy`. */
    probePolicy: probePolicy().notNull().default('single'),

    widget: text().notNull().default('uptime-ribbon'),
    widgetOptions: jsonb().$type<Record<string, unknown>>().notNull().default({}),

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

/**
 * Which agents run a control's probe, when it has been decided explicitly.
 *
 * A control with no rows here is assigned automatically — see
 * `apps/api/src/services/jobs.ts`. Pinning is for when the automatic answer is
 * wrong: a probe that must run from inside one network, or from three.
 *
 * Deleting an agent deletes its assignments; the control then falls back to the
 * automatic election rather than silently stopping, because a monitored thing
 * that quietly stops being monitored is the worst outcome available here.
 */
export const controlAgents = pgTable(
  'control_agents',
  {
    controlId: uuid()
      .notNull()
      .references(() => controls.id, { onDelete: 'cascade' }),
    agentId: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.controlId, t.agentId] }),
    index('control_agents_agent_idx').on(t.agentId),
  ],
)

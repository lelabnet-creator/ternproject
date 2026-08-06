import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { checkStatus } from './enums.js'
import { controls } from './controls.js'
import { tenants } from './tenants.js'

/**
 * The measurement stream — converted to a TimescaleDB hypertable by the first
 * SQL migration, with continuous aggregates on top.
 *
 * Deliberately has no primary key. A surrogate key would buy nothing (nothing
 * references a single check) while forcing a unique index that must include the
 * partitioning column, and duplicate-timestamp inserts from a retrying agent are
 * better tolerated than rejected.
 */
export const checks = pgTable(
  'checks',
  {
    ts: timestamp({ withTimezone: true }).notNull().defaultNow(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    controlId: uuid()
      .notNull()
      .references(() => controls.id, { onDelete: 'cascade' }),

    status: checkStatus().notNull(),
    latencyMs: integer(),

    /** Captured numeric value for controls that report a measurement. */
    value: doublePrecision(),

    /**
     * Named measurements beyond the two that have their own columns.
     *
     * `latencyMs` and `value` stay as columns because the continuous aggregates
     * roll them up and a JSONB path cannot be indexed usefully at this volume.
     * Everything else a caller wants to report — queue depth alongside latency,
     * a temperature, an error rate, several at once — lands here, so a control
     * is not limited to the two numbers the schema happened to name first.
     *
     * Values are numbers only. A free-form blob would be a second `meta`, and
     * nothing could chart it.
     */
    metrics: jsonb().$type<Record<string, number>>().notNull().default({}),

    /** Why the status is what it is — cites the failing assertion, not "check failed". */
    message: text(),

    /**
     * Marks rows produced by the indicator editor's simulation. Excluded from
     * SLA figures and removable in one click, so a demo can never quietly become
     * someone's uptime number.
     */
    synthetic: boolean().notNull().default(false),

    meta: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index('checks_control_ts_idx').on(t.controlId, t.ts.desc()),
    index('checks_tenant_ts_idx').on(t.tenantId, t.ts.desc()),
  ],
)

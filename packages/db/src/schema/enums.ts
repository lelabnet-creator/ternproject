import { pgEnum } from 'drizzle-orm/pg-core'

/**
 * Every enum the product reasons about lives here, so the vocabulary is defined
 * once and shared by the API, the web app and the probe conformance fixtures.
 */

/** Whether a tenant's status page is readable without authentication. */
export const tenantVisibility = pgEnum('tenant_visibility', ['public', 'private'])

/**
 * `live` keeps a short raw window and no rollups; `historical` keeps a
 * configurable history backed by continuous aggregates. This single choice is
 * what makes the public page show a streaming view or a period selector.
 */
export const retentionMode = pgEnum('retention_mode', ['live', 'historical'])

export const memberRole = pgEnum('member_role', ['admin', 'user', 'visitor'])

/**
 * Density of the public page.
 *
 * `list` is one component per row with room for a chart; `grid` packs them two
 * or three across; `compact` strips them to a status line for a wall display.
 */
export const pageLayout = pgEnum('page_layout', ['list', 'grid', 'compact'])

/**
 * `unknown` is deliberately distinct from `down`: a control we have stopped
 * hearing from is not the same claim as a control we know is broken, and
 * conflating them turns every network hiccup into a fake outage.
 */
export const checkStatus = pgEnum('check_status', [
  'operational',
  'degraded',
  'partial',
  'down',
  'maintenance',
  'unknown',
])

/** How a control receives data. */
export const controlKind = pgEnum('control_kind', ['push', 'http', 'tcp', 'ping', 'dns', 'cert'])

/**
 * Who runs a probe when several agents could.
 *
 * `single` is the default and the one that matters: without it every agent whose
 * key covers a control runs the same check, so eleven agents make eleven
 * identical requests a minute at the thing being monitored. That is a load
 * generator wearing a monitor's clothes.
 *
 * `all` is a real case, not a loophole: probing one endpoint from several sites
 * is how you tell "the service is down" from "the service is unreachable from
 * Paris". It has to be asked for.
 */
export const probePolicy = pgEnum('probe_policy', ['single', 'all'])

/** How a group derives its status from its children. */
export const statusRollup = pgEnum('status_rollup', ['worst', 'majority', 'manual'])

export const incidentStatus = pgEnum('incident_status', [
  'investigating',
  'identified',
  'monitoring',
  'resolved',
])

export const incidentSeverity = pgEnum('incident_severity', ['minor', 'major', 'critical'])

/** Per-component impact of an incident — carried per control, not per incident. */
export const incidentImpact = pgEnum('incident_impact', ['degraded', 'partial', 'major'])

export const maintenanceStatus = pgEnum('maintenance_status', [
  'scheduled',
  'in_progress',
  'completed',
  'cancelled',
])

export const templateKind = pgEnum('template_kind', ['incident', 'maintenance', 'update'])

export const subscriberChannel = pgEnum('subscriber_channel', [
  'email',
  'webhook',
  'slack',
  'teams',
])

export const notificationStatus = pgEnum('notification_status', ['pending', 'sent', 'failed'])

export const receiverKind = pgEnum('receiver_kind', [
  'alertmanager',
  'grafana',
  'uptimerobot',
  'zabbix',
  'pagerduty',
  'healthchecks',
  'generic',
])

export const apiKeyScope = pgEnum('api_key_scope', ['ingest', 'read'])

export const agentStatus = pgEnum('agent_status', ['active', 'stale', 'revoked'])

export const certStatus = pgEnum('cert_status', ['pending', 'issued', 'failed', 'expired'])

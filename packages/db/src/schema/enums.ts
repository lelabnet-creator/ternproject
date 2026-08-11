import { pgEnum } from 'drizzle-orm/pg-core'

/**
 * Every enum the product reasons about lives here, so the vocabulary is defined
 * once and shared by the API, the web app and the probe conformance fixtures.
 */

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
 *
 * `custom` is none of those: the tenant supplies the document, and the three
 * densities stop applying. It is how a free layout is reached without putting
 * per-breakpoint coordinates in this schema — the operator writes the
 * arrangement they want instead of dragging one out of a grid editor that would
 * then owe a keyboard equivalent.
 */
export const pageLayout = pgEnum('page_layout', ['list', 'grid', 'compact', 'custom'])

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

/**
 * How a control receives data.
 *
 * Appended to, never reordered: PostgreSQL stores an enum by its ordinal, so
 * inserting a value in the middle rewrites the meaning of every row already
 * written. New kinds go on the end.
 *
 * Four of these the server cannot run itself, and they are the last four:
 * `docker` needs a Docker socket, and `file`, `directory` and `uptime` observe
 * the machine they run on. All four are refused by `probe-transport.ts` rather
 * than left unimplemented — see the notes on `dockerProbeSchema` and
 * `fileProbeSchema` in `@tern/shared` for why that refusal is the feature.
 */
export const controlKind = pgEnum('control_kind', [
  'push',
  'http',
  'tcp',
  'ping',
  'dns',
  'cert',
  'websocket',
  'docker',
  'file',
  'directory',
  'uptime',
])

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

/**
 * What a paired agent is, as opposed to how it is doing.
 *
 * A proxy relays for a zone with no route out: it pairs upstream like any agent
 * and speaks TERN's own API downstream, which is what lets the agents behind it
 * be unaware of it. Separate from `agent_status` because the two answer
 * different questions — a proxy can be revoked, an agent can be stale, and the
 * fleet view needs both.
 */
export const agentRole = pgEnum('agent_role', ['agent', 'proxy'])

/**
 * What the console can ask a running agent to do.
 *
 * Asked rather than done: nothing here reaches out to an agent — they poll, and
 * an agent behind a relay has no route back at all — so each of these is picked
 * up on the next poll and answered when it has been carried out.
 *
 * `pause` and `stop` are both "stop measuring" and differ only in what stays
 * listening. A paused agent keeps polling, so the console can resume it. A
 * stopped one polls nothing, which is what makes it final: getting it back
 * needs a shell on the machine (`tern-agent resume`). The console says so
 * before asking.
 */
export const agentCommandKind = pgEnum('agent_command_kind', [
  'pause',
  'resume',
  'stop',
  'restart',
  'logs',
  /**
   * Turn the agent's own page on, and hand back the password it generated.
   *
   * The password is the answer to this instruction, which is the only reason
   * it can be shown at all: it is hashed the moment it is stored, so the agent
   * is the one place it exists in the clear and the reply is the one moment it
   * passes. The console shows it once and never again — the same promise
   * `tern-agent ui` makes on the machine itself.
   */
  'ui-on',
  'ui-off',
])

export const certStatus = pgEnum('cert_status', ['pending', 'issued', 'failed', 'expired'])

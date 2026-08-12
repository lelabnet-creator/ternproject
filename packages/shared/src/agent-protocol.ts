import { z } from 'zod'
import { checkStatusSchema } from './status.js'

/**
 * The agent protocol — every message that crosses the wire between a running
 * `tern-agent` or `tern-proxy` and this server, in one place.
 *
 * These shapes used to live in three places at once: Zod objects inlined in the
 * API routes, serde structs in `clients/agent/src/transport.rs`, and hand-typed
 * interfaces in the web client. Three copies of one contract drift — that is
 * not a risk but a schedule — and the only piece that never drifted was the one
 * that was already shared (`agent-commands.ts`). This file generalises that
 * precedent: the routes import their schemas from here, `gen-schema.ts` emits
 * them as JSON Schema for anyone else, and `schemas/conformance/protocol/`
 * carries fixtures the Rust structs are tested against.
 *
 * ## Conventions, fixed here so they stop being re-decided per endpoint
 *
 * - Envelopes are camelCase. The one exception is the *content* of a job's
 *   `probe` and `assertions`, which stays snake_case because the agent reads
 *   the same shape from TOML — see `agentJobSchema`.
 * - Every timestamp is an ISO 8601 / RFC 3339 string. (`lastSeenUnix`, the one
 *   field that was Unix seconds, died with protocol version 1.)
 * - Success bodies are typed objects, never bare arrays.
 * - Errors are RFC 9457 problem documents — see `problemSchema`.
 */

/**
 * The protocol version both ends assert on every exchange.
 *
 * Sent as the `X-Tern-Protocol` header by the agent and echoed by the server.
 * There is no negotiation: the fleet and the server are upgraded together, and
 * a mismatch is answered loudly (400 `protocol-mismatch` naming both versions)
 * rather than guessed around. Silence was the alternative and silence is how a
 * fleet goes quiet with nothing on screen to say why.
 */
export const PROTOCOL_VERSION = 1

/** Header name, lowercase as Node's `req.headers` reports it. */
export const PROTOCOL_HEADER = 'x-tern-protocol'

/**
 * One probe the agent is to run, as the assignment hands it over.
 *
 * The envelope is camelCase like every other message; `probe` and `assertions`
 * are snake_case inside because the agent parses the identical shape from
 * `agent.toml`, where snake_case is the TOML convention. Loosely typed here on
 * purpose — the authoritative schema for the content is `probeSchema` in
 * `probe.ts`, already exported as `schemas/probe.schema.json`; repeating it
 * would put two sources of truth one import apart.
 */
export const agentJobSchema = z.object({
  controlKey: z.string(),
  intervalS: z.number().nullable(),
  probe: z.record(z.string(), z.unknown()),
  assertions: z.array(z.record(z.string(), z.unknown())),
  payloadShape: z.enum(['status', 'value']),
})

// ── Pairing ────────────────────────────────────────────────────────────────

export const pairRequestSchema = z.object({
  code: z.string().min(4).max(32),
  hostname: z.string().max(255).optional(),
  os: z.string().max(64).optional(),
  arch: z.string().max(32).optional(),
  /**
   * The binary's own version — `0.1.0`, or `proxy/0.1.0` from a relay. The
   * prefix is how a proxy says what it is: the signal already existed and was
   * already sent, so it stays the carrier rather than a new field an old
   * binary would not fill.
   */
  agentVersion: z.string().max(64).optional(),
  /**
   * What this install is, so re-pairing replaces its row instead of growing a
   * twin. Generated and kept by the agent in its own config, never derived
   * from the host.
   */
  installId: z.string().min(8).max(64).optional(),
})

export const pairResponseSchema = z.object({
  /** Returned exactly once, here. Only its hash survives on the server. */
  apiKey: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  tenantSlug: z.string(),
  /**
   * What this agent is to run, resolved from the pairing code's scope, so a
   * paired agent is already configured — the alternative leaves the probe list
   * on the monitored host, where it drifts.
   */
  jobs: z.array(agentJobSchema),
})

// ── Heartbeat ──────────────────────────────────────────────────────────────

/**
 * "I am here", the cheapest and most frequent thing an agent sends.
 *
 * `uiAddress` is where the agent's own page can be reached, as the agent works
 * it out. The field is nullable *and* optional, and the two mean different
 * things: `null` says "there is no page, or it is on loopback" and clears
 * whatever was stored; an absent field says nothing and leaves the stored
 * value alone. The agent always sends the field; the distinction exists for
 * hand-written clients.
 */
export const heartbeatRequestSchema = z
  .object({
    uiAddress: z.string().max(255).nullable().optional(),
  })
  // `nullish`, not `optional`: a bare `POST` with no body at all arrives here
  // as null rather than undefined, and refusing it would take every curl-based
  // client quiet with nothing on screen to say why.
  .nullish()

export const heartbeatResponseSchema = z.object({
  ok: z.boolean(),
  /**
   * Whether something is waiting for this agent to come and get it.
   *
   * A beat is every minute; the assignment poll is every five. This one
   * boolean is what turns "an instruction waits up to five minutes" into "up
   * to one" without a second timer, a socket, or anything held open. True for
   * a relay when the wait is one of its zone's, because it is the relay that
   * must come and fetch it.
   */
  commandsWaiting: z.boolean(),
})

// ── Assignment poll — the only channel instructions travel on ──────────────

/**
 * One instruction for the polling agent itself.
 *
 * `kind` is a plain string rather than an enum of the known kinds: an agent
 * must be able to *receive* an instruction it does not understand and answer
 * "unknown" — failing to parse the whole poll over one new kind would cut it
 * off from every other instruction and from its assignment.
 */
export const agentCommandSchema = z.object({
  id: z.string(),
  kind: z.string(),
})

/**
 * One instruction for a machine behind this relay, named rather than keyed by
 * id because the relay knows its zone by name — it issued those keys itself,
 * and this server never saw them.
 */
export const zoneCommandSchema = z.object({
  id: z.string(),
  kind: z.string(),
  agent: z.string(),
})

export const jobsResponseSchema = z.object({
  tenantSlug: z.string(),
  jobs: z.array(agentJobSchema),
  /**
   * What the console has asked this agent to do since it last asked. Carried
   * on the poll it was already making: nothing here can reach an agent — they
   * poll, and one behind a relay has no route back at all — so this is the
   * only moment an instruction can be handed over. Handing over is also what
   * marks it delivered: at most once, even if the answer never comes.
   */
  commands: z.array(agentCommandSchema),
  /** Instructions for the machines behind this relay. Empty for anything else. */
  zoneCommands: z.array(zoneCommandSchema),
})

// ── Instruction results ────────────────────────────────────────────────────

export const commandResultRequestSchema = z.object({
  // Bounded here as well as at the agent: what protects the server is what it
  // enforces, not what a client promises. 256k covers a `logs` snapshot.
  result: z.string().max(256_000).nullable().optional(),
  error: z.string().max(2_000).nullable().optional(),
})

export const okResponseSchema = z.object({ ok: z.boolean() })

// ── Zone declaration (relay only) ──────────────────────────────────────────

export const zoneAgentSchema = z.object({
  name: z.string().min(1).max(200),
  /** RFC 3339, like every other timestamp in the protocol. Null: never heard. */
  lastSeenAt: z.iso.datetime({ offset: true }).nullable(),
  /** As the relay sees it, inside the zone. */
  ip: z.string().max(64).nullable(),
})

export const zoneDeclarationSchema = z.object({
  /**
   * The zone as the relay currently knows it — a full replacement, not a
   * merge, so a machine removed from the zone disappears here too.
   */
  agents: z.array(zoneAgentSchema).max(500),
  /** Where this relay serves its zone, as it sees itself. */
  listen: z.string().max(255).optional(),
  /**
   * Every address it could be dialled on. `.catch` and not a plain refusal:
   * this is a convenience, and a convenience must never cost the inventory —
   * a Docker host once reported 24 addresses, the whole declaration was
   * refused every five minutes, and the fleet showed an empty zone with
   * nothing to explain it.
   */
  addresses: z.array(z.string().max(64)).max(64).optional().catch(undefined),
})

export const zoneDeclarationResponseSchema = z.object({
  /** How many machines the declaration named. */
  known: z.number(),
})

export const zoneRedeemRequestSchema = z.object({ code: z.string().min(4).max(32) })

/** Never a key: the relay mints its own, and the zone never learns this server. */
export const zoneRedeemResponseSchema = z.object({ tenantSlug: z.string() })

// ── Ingest ─────────────────────────────────────────────────────────────────

export const ingestPointSchema = z
  .object({
    controlKey: z.string().min(1).max(200),
    /**
     * Optional when a `value` is sent: a control that reports a measurement
     * has no status to invent, so the point defaults to `operational` and the
     * widget's thresholds decide how it is drawn.
     */
    status: checkStatusSchema.optional(),
    latencyMs: z.number().int().min(0).max(3_600_000).optional(),
    value: z.number().finite().optional(),
    /**
     * Anything else worth charting, by name. Bounded because names become
     * chart labels and option values, and an unbounded map on the hot ingest
     * path is a way to fill a disk one point at a time.
     */
    metrics: z
      .record(
        z
          .string()
          .min(1)
          .max(60)
          .regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/, 'Metric names start with a letter'),
        z.number().finite(),
      )
      .refine((m) => Object.keys(m).length <= 25, 'At most 25 metrics per point')
      .optional(),
    message: z.string().max(2000).optional(),
    /**
     * When the measurement was taken, not when it arrived. Defaults to now;
     * sent by the agent so a point replayed from its offline queue lands at
     * the time it was measured. The server clamps out-of-window values.
     *
     * A string here, not a coerced Date: this schema describes the wire, and
     * on the wire it is RFC 3339 — which is also what lets it exist in the
     * generated JSON Schema. Offsets allowed for hand-written clients; the
     * agent always sends UTC.
     */
    ts: z.iso.datetime({ offset: true }).optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  // One of the three must be present. A point carrying none says nothing, and
  // silently storing it as `operational` would invent a claim nobody made.
  .refine(
    (point) =>
      point.status !== undefined ||
      point.value !== undefined ||
      (point.metrics !== undefined && Object.keys(point.metrics).length > 0),
    { message: 'Send a status, a value, or at least one metric' },
  )
  .transform((point) => ({
    ...point,
    status: point.status ?? ('operational' as const),
  }))

export const ingestResponseSchema = z.object({
  accepted: z.number(),
  /**
   * Refused individually, never as a batch: one unknown key in a fleet-wide
   * push must not discard everything else.
   */
  rejected: z.array(z.object({ controlKey: z.string(), reason: z.string() })),
})

/** The curl path (`POST /heartbeat/:controlKey`), aligned with ingest's count. */
export const heartbeatIngestResponseSchema = z.object({
  accepted: z.number(),
  controlKey: z.string(),
})

// ── Errors ─────────────────────────────────────────────────────────────────

/**
 * Every error body is an RFC 9457 problem document.
 *
 * `code` is the field a program branches on — stable, kebab-case, and the
 * suffix of `type`. `title`/`detail` are for people and may be reworded
 * freely. `issues` appears on validation failures only, carrying the Zod
 * issue list that used to arrive in a shape all of its own.
 */
export const problemSchema = z.object({
  /** `https://tern.dev/problems/<code>` — a name, not a link that must resolve. */
  type: z.string(),
  title: z.string(),
  status: z.number(),
  code: z.string(),
  detail: z.string().optional(),
  /** The request path, so a log line quoting the body still says where. */
  instance: z.string().optional(),
  issues: z.array(z.record(z.string(), z.unknown())).optional(),
})

export type AgentJob = z.infer<typeof agentJobSchema>
export type PairRequest = z.infer<typeof pairRequestSchema>
export type PairResponse = z.infer<typeof pairResponseSchema>
export type JobsResponse = z.infer<typeof jobsResponseSchema>
export type IngestPoint = z.infer<typeof ingestPointSchema>
export type Problem = z.infer<typeof problemSchema>

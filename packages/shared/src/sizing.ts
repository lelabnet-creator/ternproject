/**
 * What a fleet of this size asks of the HTTP layer.
 *
 * Every limit in TERN has a sensible default and no way to tell whether it fits
 * *your* installation: 600 ingest requests a minute is generous for ten agents
 * and a hard ceiling for four hundred. The numbers below turn a description of
 * the deployment into the values the environment should carry, and — more
 * usefully — into the reason each one matters, so an operator raising a limit
 * knows what they are trading away.
 *
 * Pure arithmetic, deliberately: it is the part worth testing, and it belongs
 * where the API and the admin screen can both reach it.
 */

export interface Deployment {
  /** Paired agents pushing measurements. */
  agents: number
  /** Probes each one runs. */
  probesPerAgent: number
  /** Seconds between runs. */
  intervalS: number
  /** People with a status page open at the same moment. */
  concurrentViewers: number
  /** How long raw points are kept, in days. */
  retentionDays: number
}

export interface Sizing {
  pointsPerMinute: number
  /** Agents batch a run into one request, so this is not points per minute. */
  ingestRequestsPerMinute: number
  /** Public page reads per minute, at the default 30-second refresh. */
  readRequestsPerMinute: number
  rawPointsRetained: number
  /** Rough on-disk size of the raw hypertable, in MB. */
  rawStorageMb: number
  recommended: {
    ingestRateLimitPerMinute: number
    dbPoolMax: number
  }
  notes: string[]
}

/** Bytes per stored point: row overhead, timestamp, ids, status, two numbers. */
const BYTES_PER_POINT = 160

/** How often a public page refetches, in seconds. Matches the web client. */
const PAGE_REFRESH_S = 30

export function sizeDeployment(input: Deployment): Sizing {
  const agents = Math.max(0, input.agents)
  const probes = Math.max(0, input.probesPerAgent)
  const interval = Math.max(5, input.intervalS)
  const viewers = Math.max(0, input.concurrentViewers)
  const retention = Math.max(1, input.retentionDays)

  const runsPerMinute = 60 / interval
  const pointsPerMinute = agents * probes * runsPerMinute

  // One request per agent per run: the agent batches everything it measured in
  // that tick. Sizing on points would over-provision by the probe count.
  const ingestRequestsPerMinute = agents * runsPerMinute
  const readRequestsPerMinute = viewers * (60 / PAGE_REFRESH_S)

  const rawPointsRetained = pointsPerMinute * 60 * 24 * retention
  const rawStorageMb = (rawPointsRetained * BYTES_PER_POINT) / 1024 / 1024

  const notes: string[] = []

  // The rate limit is per key, and a fleet paired from one PIN shares one key
  // only if it was made that way — but the limiter keys on the Authorization
  // header, so a shared key is the case that trips it.
  const ingestHeadroom = Math.ceil(ingestRequestsPerMinute * 2)
  if (agents > 0 && interval < 30) {
    notes.push(
      `An interval of ${interval}s makes each agent ${runsPerMinute.toFixed(1)} requests a minute. Below 30s the ingest limit is usually what gives first.`,
    )
  }

  // Postgres connections are the scarcest resource here: each is a backend
  // process with its own memory, and the pool is per API instance.
  const poolForIngest = Math.ceil(ingestRequestsPerMinute / 60 / 4)
  const poolForReads = Math.ceil(readRequestsPerMinute / 60 / 10)
  const dbPoolMax = clamp(poolForIngest + poolForReads + 4, 5, 50)

  if (dbPoolMax >= 40) {
    notes.push(
      'A pool this large needs PostgreSQL max_connections raised to match, and a connection pooler in front is usually the better answer.',
    )
  }

  if (rawStorageMb > 20_000) {
    notes.push(
      `Roughly ${Math.round(rawStorageMb / 1024)} GB of raw points before compression. Shorten retention, or lengthen the interval — the continuous aggregates keep the history either way.`,
    )
  }

  if (viewers > 500) {
    notes.push(
      'At this many viewers the public summary should be served from a cache or a CDN; it already carries a short max-age for exactly this.',
    )
  }

  if (agents === 0) {
    notes.push('No agents: everything here is driven by page reads alone.')
  }

  return {
    pointsPerMinute: round(pointsPerMinute),
    ingestRequestsPerMinute: round(ingestRequestsPerMinute),
    readRequestsPerMinute: round(readRequestsPerMinute),
    rawPointsRetained: Math.round(rawPointsRetained),
    rawStorageMb: round(rawStorageMb),
    recommended: {
      // A floor of 60: a limit lower than that turns a brief retry storm into an
      // outage of the ingest path, which is the one thing that must not fail.
      ingestRateLimitPerMinute: Math.max(60, ingestHeadroom),
      dbPoolMax,
    },
    notes,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

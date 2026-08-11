import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { schema } from '@tern/db'
import { generateToken, hashToken } from '@tern/shared'

export const API_KEY_PREFIX = 'tern_'

export interface ApiKeyContext {
  id: string
  tenantId: string
  scopes: string[]
  /** Empty means every control in the tenant. */
  scopeControlIds: string[]
  autoRegister: boolean
}

export interface IssuedApiKey {
  /** Shown once, at creation. Only the hash is stored. */
  key: string
  id: string
}

/**
 * Records that the agent behind a key has just been heard from.
 *
 * Until this existed, `agents.last_seen_at` was written exactly once — at
 * pairing — and never again. Everything that asks "is this agent alive?" reads
 * that column, so ten minutes after pairing every agent in the fleet looked
 * dead: ownership election handed its controls elsewhere, `local-probes` took
 * them over and measured them a second time, and the fleet screen showed a red
 * dot beside an agent that was reporting perfectly well.
 *
 * Rate-limited in SQL rather than on every call. Ingest is the hot path — a
 * fleet pushing every ten seconds would otherwise turn one write per agent per
 * minute into one per point — and the predicate makes the update a no-op the
 * rest of the time. A minute is far below the ten-minute staleness window that
 * consumes it, so nothing downstream can tell the difference.
 */
export async function touchAgent(
  app: FastifyInstance,
  apiKeyId: string,
  userAgent?: string,
  /**
   * Where the agent says its own page can be reached, when it has one.
   *
   * Undefined leaves whatever is stored alone — most callers here are not
   * heartbeats and have nothing to say about it. Null is a statement: the page
   * was turned off, or moved to loopback, and the console must stop offering a
   * link to it.
   */
  uiAddress?: string | null,
): Promise<void> {
  await app.db
    .update(schema.agents)
    .set({ lastSeenAt: new Date(), ...versionFrom(userAgent) })
    .where(
      and(
        eq(schema.agents.apiKeyId, apiKeyId),
        or(
          isNull(schema.agents.lastSeenAt),
          lt(schema.agents.lastSeenAt, new Date(Date.now() - 60_000)),
        ),
      ),
    )

  /*
   * The address is written on its own, outside that rate limit.
   *
   * Folding it into the statement above looked tidier and was wrong: the
   * predicate exists to throttle *liveness*, and it silently threw the address
   * away with it. A relay beating every thirty seconds never stored one at all,
   * and any agent whose address changed kept the old one until a beat happened
   * to land more than a minute after the last — which is a link to the wrong
   * machine, arriving at no predictable time.
   *
   * `IS DISTINCT FROM` rather than `<>`, because null is an ordinary value here
   * — "the page is off" — and `<>` is never true against it. That way the write
   * happens when the answer changed and not otherwise, which is what the rate
   * limit was protecting in the first place.
   */
  if (uiAddress !== undefined) {
    await app.db
      .update(schema.agents)
      .set({ uiAddress })
      .where(
        and(
          eq(schema.agents.apiKeyId, apiKeyId),
          sql`${schema.agents.uiAddress} IS DISTINCT FROM ${uiAddress}`,
        ),
      )
  }
}

/**
 * The agent's version, read from the header it already sends.
 *
 * `agent_version` used to be written once, at pairing, and never again — so the
 * fleet showed the version an agent had on the day it was installed, and showed
 * nothing at all for `Agent-local-tern`, which is provisioned rather than paired
 * and so never had a pairing handshake to report it. "version unknown" beside a
 * healthy agent is the kind of small wrongness that makes a screen untrusted.
 *
 * Taken from `User-Agent` rather than asked for in a body: the agent sets
 * `tern-agent/<version>` on every request it makes, so this needs no protocol
 * change and updates itself when the binary is upgraded.
 */
function versionFrom(userAgent?: string): { agentVersion?: string } {
  const match = /^tern-agent\/(\S{1,64})/.exec(userAgent ?? '')
  return match ? { agentVersion: match[1] } : {}
}

export async function issueApiKey(
  app: FastifyInstance,
  input: {
    tenantId: string
    name: string
    scopes?: ('ingest' | 'read')[]
    scopeControlIds?: string[]
    autoRegister?: boolean
    createdBy?: string
  },
): Promise<IssuedApiKey> {
  const key = `${API_KEY_PREFIX}${generateToken(24)}`

  const [row] = await app.db
    .insert(schema.apiKeys)
    .values({
      tenantId: input.tenantId,
      name: input.name,
      keyHash: hashToken(key),
      // A recognisable head, so a key can be identified in a list without
      // storing anything that helps an attacker reconstruct it.
      keyPrefix: key.slice(0, 12),
      scopes: input.scopes ?? ['ingest'],
      scopeControlIds: input.scopeControlIds ?? [],
      autoRegister: input.autoRegister ?? false,
      createdBy: input.createdBy ?? null,
    })
    .returning()

  if (!row) throw new Error('failed to create API key')
  return { key, id: row.id }
}

/**
 * Authenticates a machine caller from the Authorization header.
 *
 * Returns null rather than throwing so routes can decide the status code —
 * ingestion answers 401, but a public endpoint that merely *prefers* a key
 * should not fail because one was absent.
 */
export async function authenticateApiKey(
  app: FastifyInstance,
  req: FastifyRequest,
  requiredScope: 'ingest' | 'read',
): Promise<ApiKeyContext | null> {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null

  const presented = header.slice('Bearer '.length).trim()
  if (!presented) return null

  // Looked up by hash, so the plaintext is never compared or stored. The index
  // on key_hash makes this a single point read.
  const [row] = await app.db
    .select()
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.keyHash, hashToken(presented)), isNull(schema.apiKeys.revokedAt)))
    .limit(1)

  if (!row) return null
  if (!row.scopes.includes(requiredScope)) return null

  // Fire-and-forget: last-used is useful for spotting dead keys, but an
  // ingestion request must not fail or wait because of a bookkeeping write.
  void app.db
    .update(schema.apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.apiKeys.id, row.id))
    .catch((error: unknown) => app.log.warn({ err: error }, 'failed to record api key use'))

  // Tagged on the request so the metrics hook can attribute this call without
  // every ingest route having to remember to report it.
  req.apiKeyId = row.id

  return {
    id: row.id,
    tenantId: row.tenantId,
    scopes: row.scopes,
    scopeControlIds: row.scopeControlIds,
    autoRegister: row.autoRegister,
  }
}

/** Whether a key is allowed to write to a given control. */
export function keyCoversControl(key: ApiKeyContext, controlId: string): boolean {
  return key.scopeControlIds.length === 0 || key.scopeControlIds.includes(controlId)
}

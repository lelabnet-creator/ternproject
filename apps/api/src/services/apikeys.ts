import { and, eq, isNull, lt, or } from 'drizzle-orm'
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
export async function touchAgent(app: FastifyInstance, apiKeyId: string): Promise<void> {
  await app.db
    .update(schema.agents)
    .set({ lastSeenAt: new Date() })
    .where(
      and(
        eq(schema.agents.apiKeyId, apiKeyId),
        or(
          isNull(schema.agents.lastSeenAt),
          lt(schema.agents.lastSeenAt, new Date(Date.now() - 60_000)),
        ),
      ),
    )
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

import { and, eq, isNull } from 'drizzle-orm'
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

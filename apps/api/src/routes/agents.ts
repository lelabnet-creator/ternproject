import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import { generatePin, hashToken, normalisePin } from '@tern/shared'
import { config } from '../config.js'
import { issueApiKey } from '../services/apikeys.js'
import { audit } from '../services/audit.js'

/**
 * PIN-based agent pairing.
 *
 * Copying a 64-character key onto a remote host is the main friction in
 * deploying an agent, and the main way the key leaks — into shell history, a
 * ticket, a screenshot. A short PIN is worthless once consumed; only the
 * long-lived key it is exchanged for matters, and that never passes through a
 * human.
 */

/** Wrong guesses before the code is dead. 40 bits of entropy, but only briefly. */
const MAX_FAILED_ATTEMPTS = 5
const DEFAULT_TTL_MINUTES = 15

/**
 * Redemption lives in its own encapsulated plugin so its strict rate limit
 * applies to that route alone — the management routes below are already behind
 * an authenticated admin session and do not need it.
 */
const redeemRoute: FastifyPluginAsyncZod = async (app) => {
  await app.register(import('@fastify/rate-limit'), {
    max: config.PAIR_RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
  })

  app.post(
    '/pair',
    {
      schema: {
        body: z.object({
          code: z.string().min(4).max(32),
          hostname: z.string().max(255).optional(),
          os: z.string().max(64).optional(),
          arch: z.string().max(32).optional(),
          agentVersion: z.string().max(64).optional(),
        }),
        response: {
          200: z.object({
            apiKey: z.string(),
            agentId: z.string(),
            agentName: z.string(),
            tenantSlug: z.string(),
          }),
        },
      },
    },
    async (req) => {
      const codeHash = hashToken(normalisePin(req.body.code))

      const [pairing] = await app.db
        .select()
        .from(schema.pairingCodes)
        .where(
          and(eq(schema.pairingCodes.codeHash, codeHash), isNull(schema.pairingCodes.revokedAt)),
        )
        .limit(1)

      // Every rejection below answers the same way. Distinguishing "expired"
      // from "wrong" from "used up" would tell a guesser which codes exist.
      const invalid = () => app.httpErrors.unauthorized('Invalid or expired pairing code')

      if (!pairing) {
        await audit(app, { action: 'agent.pair.failed', actorLabel: 'unknown code', ip: req.ip })
        throw invalid()
      }

      if (
        pairing.expiresAt.getTime() < Date.now() ||
        pairing.usedCount >= pairing.maxUses ||
        pairing.failedAttempts >= MAX_FAILED_ATTEMPTS
      ) {
        await audit(app, {
          action: 'agent.pair.failed',
          tenantId: pairing.tenantId,
          target: pairing.id,
          ip: req.ip,
        })
        throw invalid()
      }

      const [tenant] = await app.db
        .select({ slug: schema.tenants.slug })
        .from(schema.tenants)
        .where(eq(schema.tenants.id, pairing.tenantId))
        .limit(1)
      if (!tenant) throw invalid()

      const agentName = req.body.hostname?.trim() || `agent-${pairing.id.slice(0, 8)}`

      // The claim happens first and conditionally. Two agents redeeming a
      // single-use code at the same moment must not both succeed, and the
      // guard belongs in the UPDATE rather than in a read-then-write.
      const claimed = await app.db
        .update(schema.pairingCodes)
        .set({
          usedCount: sql`${schema.pairingCodes.usedCount} + 1`,
          consumedAt: new Date(),
        })
        .where(
          and(
            eq(schema.pairingCodes.id, pairing.id),
            sql`${schema.pairingCodes.usedCount} < ${schema.pairingCodes.maxUses}`,
          ),
        )
        .returning({ id: schema.pairingCodes.id })

      if (claimed.length === 0) throw invalid()

      const issued = await issueApiKey(app, {
        tenantId: pairing.tenantId,
        name: `Agent: ${agentName}`,
        scopes: ['ingest'],
        scopeControlIds: pairing.scopeControlIds,
        autoRegister: pairing.autoRegister,
      })

      const [agent] = await app.db
        .insert(schema.agents)
        .values({
          tenantId: pairing.tenantId,
          name: agentName,
          hostname: req.body.hostname ?? null,
          os: req.body.os ?? null,
          arch: req.body.arch ?? null,
          agentVersion: req.body.agentVersion ?? null,
          apiKeyId: issued.id,
          pairingCodeId: pairing.id,
          pairedIp: req.ip,
          lastSeenAt: new Date(),
        })
        .returning()
      if (!agent) throw app.httpErrors.internalServerError('Failed to register agent')

      await audit(app, {
        action: 'agent.paired',
        tenantId: pairing.tenantId,
        actorLabel: agentName,
        target: agent.id,
        meta: { os: req.body.os, arch: req.body.arch, version: req.body.agentVersion },
        ip: req.ip,
      })

      // The key is returned exactly once, here.
      return {
        apiKey: issued.key,
        agentId: agent.id,
        agentName,
        tenantSlug: tenant.slug,
      }
    },
  )
}

const routes: FastifyPluginAsyncZod = async (app) => {
  await app.register(redeemRoute)

  // ── Management: per tenant, admin only ────────────────────────────────────
  app.post(
    '/:slug/pairing-codes',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('agent:manage')],
      schema: {
        params: z.object({ slug: z.string() }),
        body: z.object({
          ttlMinutes: z.number().int().min(1).max(1440).default(DEFAULT_TTL_MINUTES),
          maxUses: z.number().int().min(1).max(100).default(1),
          scopeControlIds: z.array(z.string().uuid()).default([]),
          autoRegister: z.boolean().default(true),
        }),
        response: {
          200: z.object({
            pin: z.string(),
            expiresAt: z.string(),
            maxUses: z.number(),
            pairCommand: z.string(),
          }),
        },
      },
    },
    async (req) => {
      const tenant = req.tenant!
      const pin = generatePin()
      const expiresAt = new Date(Date.now() + req.body.ttlMinutes * 60_000)

      await app.db.insert(schema.pairingCodes).values({
        tenantId: tenant.id,
        codeHash: hashToken(normalisePin(pin)),
        createdBy: req.actor.userId ?? null,
        expiresAt,
        maxUses: req.body.maxUses,
        scopeControlIds: req.body.scopeControlIds,
        autoRegister: req.body.autoRegister,
      })

      await audit(app, {
        action: 'agent.pairing_code.created',
        tenantId: tenant.id,
        actorId: req.actor.userId,
        meta: { maxUses: req.body.maxUses, ttlMinutes: req.body.ttlMinutes },
        ip: req.ip,
      })

      return {
        pin,
        expiresAt: expiresAt.toISOString(),
        maxUses: req.body.maxUses,
        // Ready to paste on the target machine — the point of the whole flow.
        pairCommand: `tern-agent pair --server ${publicOrigin()} --pin ${pin}`,
      }
    },
  )

  app.get(
    '/:slug/agents',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('agent:manage')],
      schema: {
        params: z.object({ slug: z.string() }),
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              hostname: z.string().nullable(),
              os: z.string().nullable(),
              arch: z.string().nullable(),
              agentVersion: z.string().nullable(),
              status: z.string(),
              lastSeenAt: z.string().nullable(),
            }),
          ),
        },
      },
    },
    async (req) => {
      const rows = await app.db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.tenantId, req.tenant!.id))

      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        hostname: row.hostname,
        os: row.os,
        arch: row.arch,
        agentVersion: row.agentVersion,
        status: row.status,
        lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      }))
    },
  )

  app.delete(
    '/:slug/agents/:agentId',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('agent:manage')],
      schema: {
        params: z.object({ slug: z.string(), agentId: z.string().uuid() }),
        response: { 200: z.object({ ok: z.boolean() }) },
      },
    },
    async (req) => {
      const [agent] = await app.db
        .select()
        .from(schema.agents)
        .where(
          and(eq(schema.agents.id, req.params.agentId), eq(schema.agents.tenantId, req.tenant!.id)),
        )
        .limit(1)
      if (!agent) throw app.httpErrors.notFound('Unknown agent')

      await app.db
        .update(schema.agents)
        .set({ status: 'revoked', revokedAt: new Date() })
        .where(eq(schema.agents.id, agent.id))

      // The key is revoked with the agent. Revoking the record but leaving a
      // working credential behind would be a revocation in name only.
      if (agent.apiKeyId) {
        await app.db
          .update(schema.apiKeys)
          .set({ revokedAt: new Date() })
          .where(eq(schema.apiKeys.id, agent.apiKeyId))
      }

      await audit(app, {
        action: 'agent.revoked',
        tenantId: req.tenant!.id,
        actorId: req.actor.userId,
        target: agent.id,
        ip: req.ip,
      })

      return { ok: true }
    },
  )
}

function publicOrigin(): string {
  return process.env.PUBLIC_BASE_URL ?? 'http://localhost:5173'
}

export default routes

import { and, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import {
  commandResultRequestSchema,
  generatePin,
  hashToken,
  heartbeatRequestSchema,
  heartbeatResponseSchema,
  jobsResponseSchema,
  normalisePin,
  okResponseSchema,
  pairRequestSchema,
  pairResponseSchema,
  renderAgentPairCommand,
  renderProxyInitCommand,
  zoneDeclarationResponseSchema,
  zoneDeclarationSchema,
  zoneRedeemRequestSchema,
  zoneRedeemResponseSchema,
} from '@tern/shared'
import { config } from '../config.js'
import { withCode } from '../plugins/problem-json.js'
import { authenticateApiKey, issueApiKey, touchAgent } from '../services/apikeys.js'
import { assignmentsFor, jobsForAgent } from '../services/jobs.js'
import { audit } from '../services/audit.js'
import { LOCAL_AGENT_NAME } from '../services/local-agent.js'

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
      // The shapes live in @tern/shared/agent-protocol, beside the Rust
      // fixtures that hold the other end to the same contract.
      schema: {
        body: pairRequestSchema,
        response: { 200: pairResponseSchema },
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

      /*
       * The same install pairing again, rather than a new machine.
       *
       * Pairing used to insert unconditionally, because nothing in the request
       * could tell the two apart: a hostname, an OS and an architecture are all
       * shared by any two machines built from one image. So re-running an
       * installer — to take an update, to replace a key — grew a twin in the
       * fleet of a machine that had not moved, and the operator was left to
       * work out which of two identical rows was the live one.
       *
       * Matched on the identifier the agent keeps in its own config, and on
       * nothing else. A hostname match would have been enough to fix the
       * screenshot that prompted this and wrong in the field: two VMs cloned
       * from one image share a hostname, and merging them would silently drop a
       * machine's monitoring while looking like it had worked.
       *
       * Revoked rows are eligible too. Re-pairing a machine that was retired is
       * precisely how it comes back, and leaving the old row revoked beside a
       * new one is the duplicate this removes.
       */
      const [existing] = req.body.installId
        ? await app.db
            .select({ id: schema.agents.id, apiKeyId: schema.agents.apiKeyId })
            .from(schema.agents)
            .where(
              and(
                eq(schema.agents.tenantId, pairing.tenantId),
                eq(schema.agents.installId, req.body.installId),
              ),
            )
            .limit(1)
        : []

      // Typed rather than inferred: pulled out of the call, `role` widens to
      // `string` and stops fitting the column's enum. The annotation is what
      // keeps "proxy or agent, nothing else" a fact the compiler checks.
      const shared: Omit<typeof schema.agents.$inferInsert, 'tenantId'> = {
        name: agentName,
        hostname: req.body.hostname ?? null,
        os: req.body.os ?? null,
        arch: req.body.arch ?? null,
        /*
         * The version, without the prefix that carries the role.
         *
         * `tern-proxy` announces `proxy/0.1.0`, and storing that verbatim put
         * `proxy/0.1.0` in the fleet's version column — beside relays that had
         * heartbeated since, which read `0.1.0`, because the header the
         * heartbeat parses is stripped. The same relay showed two different
         * versions depending on how recently it had spoken. The role is already
         * a column of its own; the version column should hold a version.
         */
        agentVersion: (req.body.agentVersion ?? null)?.replace(/^proxy\//, '') ?? null,
        /*
         * A proxy says so by the version it pairs with.
         *
         * `tern-proxy` announces `proxy/<version>` where an agent announces a
         * bare number — see the pairing call in `clients/agent/src/proxy.rs`.
         * Read here rather than added to the pairing body because the signal
         * already existed and was already sent; a new field would mean an old
         * proxy pairing as an ordinary agent, which is precisely the mistake
         * the fleet view is meant to stop making.
         */
        role: (req.body.agentVersion ?? '').startsWith('proxy/') ? 'proxy' : 'agent',
        apiKeyId: issued.id,
        pairingCodeId: pairing.id,
        pairedIp: req.ip,
        lastSeenAt: new Date(),
      }

      const [agent] = existing
        ? await app.db
            .update(schema.agents)
            .set({
              ...shared,
              // Back to active, and its previous revocation forgotten: a
              // machine that pairs again is a machine that is here again.
              status: 'active',
              revokedAt: null,
              installId: req.body.installId,
            })
            .where(eq(schema.agents.id, existing.id))
            .returning()
        : await app.db
            .insert(schema.agents)
            .values({
              tenantId: pairing.tenantId,
              installId: req.body.installId ?? null,
              ...shared,
            })
            .returning()
      if (!agent) throw app.httpErrors.internalServerError('Failed to register agent')

      /*
       * The key the row used to hold, killed.
       *
       * Only after the row points at the new one. Reversed, a failure between
       * the two steps would leave the agent with no working credential at all —
       * and the reason it was pairing again is often that something already
       * went wrong.
       */
      if (existing?.apiKeyId) {
        await app.db
          .update(schema.apiKeys)
          .set({ revokedAt: new Date() })
          .where(eq(schema.apiKeys.id, existing.apiKeyId))
      }

      await audit(app, {
        action: 'agent.paired',
        tenantId: pairing.tenantId,
        actorLabel: agentName,
        target: agent.id,
        // Whether this was a new machine or one pairing again: the difference
        // is the whole point of the identifier, and the log is where somebody
        // goes to ask why a row changed rather than appeared.
        meta: {
          os: req.body.os,
          arch: req.body.arch,
          version: req.body.agentVersion,
          repaired: Boolean(existing),
        },
        ip: req.ip,
      })

      req.log.info(
        { agentId: agent.id, agent: agentName, repaired: Boolean(existing) },
        'agent paired',
      )

      // The key is returned exactly once, here.
      return {
        apiKey: issued.key,
        agentId: agent.id,
        agentName,
        tenantSlug: tenant.slug,
        // Named, so the newly paired agent gets exactly what the assignment
        // says it should run — not every probe the tenant has.
        jobs: await jobsForAgent(app, pairing.tenantId, pairing.scopeControlIds, agent.id),
      }
    },
  )
}

const routes: FastifyPluginAsyncZod = async (app) => {
  await app.register(redeemRoute)

  /**
   * The same jobs, re-read with the ingest key.
   *
   * Pairing happens once; what is monitored changes. Without this an agent
   * paired last month runs last month's probes, and adding a control means
   * touching every host — which is the thing having a server is meant to avoid.
   */
  /**
   * "I am here."
   *
   * Every other sign of life an agent gives is a side effect of having work: a
   * push proves it, and so does asking for an assignment. An agent whose
   * assignment is empty does neither — it has nothing to send, and under
   * `--no-refresh` nothing to ask — so it fell silent and the fleet drew it as
   * dead. It was not dead; it had nothing to do, and those are worth telling
   * apart.
   *
   * Its own endpoint rather than a reuse of `/agent/jobs`, so liveness costs no
   * assignment download and keeps working when refreshing is switched off. It
   * writes nothing but the timestamp and the version, and it answers the same
   * to every caller holding a valid ingest key.
   */
  app.post(
    '/agent/heartbeat',
    {
      schema: {
        // Shared with the Rust structs; `nullish` because a bare POST with no
        // body arrives as null, and refusing that took a fleet quiet once.
        body: heartbeatRequestSchema,
        response: { 200: heartbeatResponseSchema },
      },
    },
    async (req) => {
      const key = await authenticateApiKey(app, req, 'ingest')
      if (!key) throw app.httpErrors.unauthorized('Invalid or missing API key')

      await touchAgent(app, key.id, req.headers['user-agent'], req.body?.uiAddress)

      const [agent] = await app.db
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(and(eq(schema.agents.apiKeyId, key.id), eq(schema.agents.tenantId, key.tenantId)))
        .limit(1)

      // Its own, and its zone's. `limit(1)` because the only question is
      // whether there is any — the poll that follows is what reads them.
      const waiting = agent
        ? await app.db
            .select({ id: schema.agentCommands.id })
            .from(schema.agentCommands)
            .innerJoin(schema.agents, eq(schema.agents.id, schema.agentCommands.agentId))
            .where(
              and(
                isNull(schema.agentCommands.deliveredAt),
                or(eq(schema.agents.id, agent.id), eq(schema.agents.parentAgentId, agent.id)),
              ),
            )
            .limit(1)
        : []

      // Debug, not info: one line per agent per minute is a log nobody can
      // read at exactly the moment they need to.
      req.log.debug({ agentId: agent?.id ?? null, waiting: waiting.length > 0 }, 'heartbeat')

      return { ok: true, commandsWaiting: waiting.length > 0 }
    },
  )

  /**
   * A proxy declaring the zone it relays for.
   *
   * The agents behind a proxy never reach this server — that is the whole point
   * of the relay — so without this the fleet view showed one dot where there
   * were nine machines, and an operator had to log into the proxy to find out
   * what it was serving.
   *
   * ## What it does and does not carry
   *
   * A name, when it was last heard from, and the address the proxy sees it at.
   * Not its OS, its version or its probes: the proxy does not know them, and
   * inventing a shape it cannot fill would make the view lie in a new way.
   *
   * This is a deliberate widening of what an isolated zone discloses upstream —
   * `docs/security.md` says so. It is the proxy's own choice to send it: an
   * operator who wants the zone opaque runs the proxy without this, and the view
   * shows the proxy alone, which is what it showed before.
   *
   * ## Why it replaces rather than merges
   *
   * The list is the zone as the proxy currently knows it. An agent removed from
   * a proxy must disappear here too, and a merge would leave it on screen for
   * ever — reporting a machine that no longer exists is worse than reporting
   * none.
   */
  /**
   * A relay asking whether a code issued here is good for its zone.
   *
   * ── The problem it solves ───────────────────────────────────────────────
   *
   * A machine with no route to TERN could only be paired with a PIN minted on
   * the relay itself, by `tern-proxy pin`. That is one ssh session and one
   * terminal more than anybody expects, and it meant the admin could never
   * hand out a command that worked as pasted: the one value it needed was the
   * one value it could not know.
   *
   * ── Why this does not give the zone a way in ────────────────────────────
   *
   * The property that makes a zone safe is not where the code comes from, it
   * is what the agent ends up holding: a key issued by the relay, valid at the
   * relay, worth nothing upstream. That is unchanged here. The code is
   * redeemed *by the relay*, over the relay's own authenticated connection,
   * and the answer carries no key at all — the relay mints its own and the
   * agent never learns this server exists.
   *
   * So the request is authenticated as the relay, refused for anything that is
   * not a proxy, and the code is claimed in the same conditional UPDATE the
   * ordinary pairing uses: two machines redeeming one single-use code at the
   * same moment must not both succeed.
   *
   * No agent row is written here. The relay declares its zone on its own
   * schedule through `/agent/zone`, which is the one place a zone agent is
   * created — two writers for the same row is how a machine ends up listed
   * twice.
   */
  app.post(
    '/agent/zone/redeem',
    {
      schema: {
        body: zoneRedeemRequestSchema,
        response: { 200: zoneRedeemResponseSchema },
      },
    },
    async (req) => {
      const key = await authenticateApiKey(app, req, 'ingest')
      if (!key) throw app.httpErrors.unauthorized('Invalid or missing API key')

      const [proxy] = await app.db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.apiKeyId, key.id))
        .limit(1)

      // 403, not 404: the key is real and authenticated — what is refused is
      // what it may do. `key-has-no-agent` is the code the agent branches on,
      // and the same condition answers the same way on every zone route.
      if (!proxy) {
        throw withCode(
          app.httpErrors.forbidden(
            'This key is valid but no agent row holds it; only a paired agent may call this.',
          ),
          'key-has-no-agent',
        )
      }
      if (proxy.role !== 'proxy') {
        throw app.httpErrors.forbidden('Only a proxy redeems a code for a zone')
      }

      const codeHash = hashToken(normalisePin(req.body.code))
      const [pairing] = await app.db
        .select()
        .from(schema.pairingCodes)
        .where(
          and(eq(schema.pairingCodes.codeHash, codeHash), isNull(schema.pairingCodes.revokedAt)),
        )
        .limit(1)

      // The same single answer as everywhere else: wrong, expired and spent
      // are indistinguishable, or a guesser learns which codes exist.
      const invalid = () => app.httpErrors.unauthorized('Invalid or expired pairing code')
      if (!pairing) {
        await audit(app, { action: 'agent.pair.failed', actorLabel: 'unknown code', ip: req.ip })
        throw invalid()
      }

      // A code belongs to one tenant, and a relay to one tenant. Crossing them
      // would let a relay redeem a code minted for somebody else's page.
      if (pairing.tenantId !== proxy.tenantId) throw invalid()

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

      const claimed = await app.db
        .update(schema.pairingCodes)
        .set({ usedCount: sql`${schema.pairingCodes.usedCount} + 1`, consumedAt: new Date() })
        .where(
          and(
            eq(schema.pairingCodes.id, pairing.id),
            sql`${schema.pairingCodes.usedCount} < ${schema.pairingCodes.maxUses}`,
          ),
        )
        .returning({ id: schema.pairingCodes.id })

      if (claimed.length === 0) throw invalid()

      const [tenant] = await app.db
        .select({ slug: schema.tenants.slug })
        .from(schema.tenants)
        .where(eq(schema.tenants.id, pairing.tenantId))
        .limit(1)
      if (!tenant) throw invalid()

      await audit(app, {
        action: 'agent.zone.redeemed',
        tenantId: pairing.tenantId,
        actorLabel: proxy.name,
        target: pairing.id,
        ip: req.ip,
      })

      return { tenantSlug: tenant.slug }
    },
  )

  app.post(
    '/agent/zone',
    {
      schema: {
        body: zoneDeclarationSchema,
        response: { 200: zoneDeclarationResponseSchema },
      },
    },
    async (req) => {
      const key = await authenticateApiKey(app, req, 'ingest')
      if (!key) throw app.httpErrors.unauthorized('Invalid or missing API key')

      const [proxy] = await app.db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.apiKeyId, key.id))
        .limit(1)

      if (!proxy) {
        throw withCode(
          app.httpErrors.forbidden(
            'This key is valid but no agent row holds it; only a paired agent may call this.',
          ),
          'key-has-no-agent',
        )
      }

      // Only a proxy may claim children. An ordinary agent posting here is
      // either a misconfiguration or an attempt to invent machines, and both
      // deserve the same flat refusal.
      if (proxy.role !== 'proxy') {
        throw app.httpErrors.forbidden('Only a proxy declares a zone')
      }

      /*
       * A zone agent is identified by its name *among rows this server never
       * paired* — never by name alone.
       *
       * Found end to end, not by reading: a proxy and a direct agent running on
       * the same machine send the same hostname, so matching on name across the
       * tenant filed the direct agent behind the proxy and overwrote its last
       * contact. The view then showed a relayed machine that was talking to the
       * server itself.
       *
       * `apiKeyId IS NULL` is the discriminator that cannot collide: an agent
       * that paired here holds a key, an agent known only through a proxy never
       * has one. It also survives an agent leaving the zone and coming back —
       * unlinking clears the parent, and a match on parent alone would then
       * create a second row for the same machine.
       */
      if (req.body.listen || req.body.addresses) {
        await app.db
          .update(schema.agents)
          .set({
            ...(req.body.listen && { zoneAddress: req.body.listen }),
            ...(req.body.addresses && { zoneAddresses: req.body.addresses }),
          })
          .where(eq(schema.agents.id, proxy.id))
      }

      await app.db.transaction(async (tx) => {
        const seen = req.body.agents.map((agent) => agent.name)

        // Gone from the zone: unlinked, not deleted. The row keeps its history
        // and stops being drawn behind this proxy.
        await tx
          .update(schema.agents)
          .set({ parentAgentId: null })
          .where(
            and(
              eq(schema.agents.parentAgentId, proxy.id),
              seen.length > 0 ? notInArray(schema.agents.name, seen) : undefined,
            ),
          )

        /*
         * And repairs what the first version of this endpoint got wrong.
         *
         * It matched by name across the tenant, so an agent that had paired
         * here directly could be filed behind a proxy that merely reported the
         * same hostname. Those rows exist in the wild; this clears them on the
         * next declaration rather than leaving an operator to notice a machine
         * drawn in a zone it never belonged to.
         *
         * Safe as an invariant, not only as a repair: an agent holding a key of
         * this server's issuing reaches it directly, by definition, and is
         * therefore behind nothing.
         */
        await tx
          .update(schema.agents)
          .set({ parentAgentId: null })
          .where(and(eq(schema.agents.parentAgentId, proxy.id), isNotNull(schema.agents.apiKeyId)))

        for (const agent of req.body.agents) {
          const values = {
            tenantId: proxy.tenantId,
            name: agent.name,
            site: proxy.site,
            role: 'agent' as const,
            parentAgentId: proxy.id,
            // RFC 3339 on the wire like every other protocol timestamp; the
            // relay formats it with its own 25-line helper rather than a date
            // library.
            lastSeenAt: agent.lastSeenAt === null ? null : new Date(agent.lastSeenAt),
          }

          const [existing] = await tx
            .select({ id: schema.agents.id })
            .from(schema.agents)
            .where(
              and(
                eq(schema.agents.tenantId, proxy.tenantId),
                eq(schema.agents.name, agent.name),
                isNull(schema.agents.apiKeyId),
              ),
            )
            .limit(1)

          if (existing)
            await tx.update(schema.agents).set(values).where(eq(schema.agents.id, existing.id))
          else await tx.insert(schema.agents).values(values)
        }
      })

      await touchAgent(app, key.id, req.headers['user-agent'])

      // Debug: a declaration arrives every refresh, and the interesting ones —
      // refused, or shrinking — are visible from the fleet screen anyway.
      req.log.debug({ proxyId: proxy.id, declared: req.body.agents.length }, 'zone declared')

      return { known: req.body.agents.length }
    },
  )

  app.get(
    '/agent/jobs',
    {
      schema: {
        response: { 200: jobsResponseSchema },
      },
    },
    async (req) => {
      const key = await authenticateApiKey(app, req, 'ingest')
      if (!key) throw app.httpErrors.unauthorized('Invalid or missing API key')

      // An agent asking what to run is alive, even if it has nothing to push
      // yet — which is exactly the state a freshly started one is in.
      await touchAgent(app, key.id, req.headers['user-agent'])

      const [tenant] = await app.db
        .select({ slug: schema.tenants.slug })
        .from(schema.tenants)
        .where(eq(schema.tenants.id, key.tenantId))
        .limit(1)

      // Resolve the agent behind this key: the assignment is per agent, and a
      // key with no agent behind it (one minted by hand) falls back to scope.
      const [agent] = await app.db
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(and(eq(schema.agents.apiKeyId, key.id), eq(schema.agents.tenantId, key.tenantId)))
        .limit(1)

      /*
       * Handed over and marked as handed over, in that order and only once.
       *
       * `deliveredAt` is set as they are read, not when the answer comes back:
       * a restart is carried out by a process that then stops existing, and an
       * instruction still marked undelivered would be handed to it again on the
       * way up. Once is the promise; the result may never arrive, and that is a
       * different thing from never having been asked.
       */
      const commands = agent
        ? await app.db
            .update(schema.agentCommands)
            .set({ deliveredAt: new Date() })
            .where(
              and(
                eq(schema.agentCommands.agentId, agent.id),
                isNull(schema.agentCommands.deliveredAt),
              ),
            )
            .returning({ id: schema.agentCommands.id, kind: schema.agentCommands.kind })
        : []

      /*
       * And everything waiting for the machines behind it.
       *
       * Marked as handed over on the same terms as the relay's own: once. What
       * the relay then does with it is the relay's business — if it dies before
       * passing one on, that instruction is lost rather than repeated, which is
       * the same promise made everywhere else here and the one that keeps a
       * restart from happening twice.
       */
      const zoneCommands = agent
        ? await app.db
            .update(schema.agentCommands)
            .set({ deliveredAt: new Date() })
            .where(
              and(
                isNull(schema.agentCommands.deliveredAt),
                inArray(
                  schema.agentCommands.agentId,
                  app.db
                    .select({ id: schema.agents.id })
                    .from(schema.agents)
                    .where(eq(schema.agents.parentAgentId, agent.id)),
                ),
              ),
            )
            .returning({
              id: schema.agentCommands.id,
              kind: schema.agentCommands.kind,
              agentId: schema.agentCommands.agentId,
            })
        : []

      /*
       * The one log that matters on this route: from here on the instruction
       * is marked delivered and will never be handed over again, so if it
       * vanishes — an agent that dies mid-restart, a relay that drops before
       * passing one on — this line is the last trace the server has of it.
       */
      if (commands.length > 0 || zoneCommands.length > 0) {
        req.log.info(
          {
            agentId: agent?.id,
            commands: commands.map((c) => ({ id: c.id, kind: c.kind })),
            zoneCommands: zoneCommands.map((c) => ({ id: c.id, kind: c.kind })),
          },
          'instructions delivered',
        )
      }

      // Turned into names, because that is what a relay knows its zone by.
      const names = new Map(
        zoneCommands.length > 0
          ? (
              await app.db
                .select({ id: schema.agents.id, name: schema.agents.name })
                .from(schema.agents)
                .where(
                  inArray(
                    schema.agents.id,
                    zoneCommands.map((c) => c.agentId),
                  ),
                )
            ).map((row) => [row.id, row.name] as const)
          : [],
      )

      return {
        tenantSlug: tenant?.slug ?? '',
        jobs: await jobsForAgent(app, key.tenantId, key.scopeControlIds ?? null, agent?.id),
        commands,
        zoneCommands: zoneCommands.map((c) => ({
          id: c.id,
          kind: c.kind,
          agent: names.get(c.agentId) ?? '',
        })),
      }
    },
  )

  /**
   * What an agent did with an instruction.
   *
   * Its own route rather than a field on the next poll: a `logs` answer is the
   * agent's recent output, which is far larger than anything else it sends, and
   * putting it on the heartbeat would make every beat carry the shape of the
   * one call that occasionally needs it.
   */
  app.post(
    '/agent/commands/:commandId/result',
    {
      schema: {
        params: z.object({ commandId: z.string().uuid() }),
        body: commandResultRequestSchema,
        response: { 200: okResponseSchema },
      },
    },
    async (req) => {
      const key = await authenticateApiKey(app, req, 'ingest')
      if (!key) throw app.httpErrors.unauthorized('Invalid or missing API key')

      const [agent] = await app.db
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(and(eq(schema.agents.apiKeyId, key.id), eq(schema.agents.tenantId, key.tenantId)))
        .limit(1)
      // The same answer as the zone routes for the same condition: the key is
      // real, what is missing is the agent behind it. It used to be a 401 here
      // and a 404 there, and the agent could not tell "re-pair" from "retry".
      if (!agent) {
        throw withCode(
          app.httpErrors.forbidden(
            'This key is valid but no agent row holds it; only a paired agent may call this.',
          ),
          'key-has-no-agent',
        )
      }

      /*
       * Scoped to what this key legitimately speaks for.
       *
       * Its own agent, and — when it is a relay — the machines behind it. That
       * second case is not a loosening: a zone agent has no key on this server
       * and never will, so its answer can only arrive through the relay that
       * issued its key. Everything else is still refused, so one ordinary agent
       * cannot answer for another.
       */
      const spokenFor = await app.db
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(eq(schema.agents.parentAgentId, agent.id))

      const updated = await app.db
        .update(schema.agentCommands)
        .set({
          completedAt: new Date(),
          result: req.body.result ?? null,
          error: req.body.error ?? null,
        })
        .where(
          and(
            eq(schema.agentCommands.id, req.params.commandId),
            inArray(schema.agentCommands.agentId, [agent.id, ...spokenFor.map((a) => a.id)]),
          ),
        )
        .returning({ id: schema.agentCommands.id })

      if (updated.length === 0) throw app.httpErrors.notFound('Unknown command')

      // The other end of the 'instructions delivered' line: between the two,
      // an instruction that never came back is visible from the server alone.
      req.log.info(
        {
          agentId: agent.id,
          commandId: req.params.commandId,
          failed: Boolean(req.body.error),
        },
        'instruction answered',
      )

      return { ok: true }
    },
  )

  /**
   * Ask an agent to do something, and read what came of it.
   *
   * Two routes because they answer at different times: asking is instant and
   * getting an answer is not — the instruction waits for the agent's next poll,
   * which is a refresh interval away. The console shows the wait rather than
   * hiding it behind a spinner that would be lying.
   */
  app.post(
    '/:slug/agents/:agentId/commands',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('agent:manage')],
      schema: {
        params: z.object({ slug: z.string(), agentId: z.string().uuid() }),
        body: z.object({
          /*
           * Read from the column, not written again beside it.
           *
           * These were two lists kept in step by hand, and they drifted: the
           * database learned `ui-on` and this one did not, so the console asked
           * for something the schema allowed and got a 400 naming five kinds it
           * had never heard of. Derived, the two cannot disagree — adding a
           * kind is one edit, in the one place that decides what a kind is.
           */
          kind: z.enum(schema.agentCommandKind.enumValues),
        }),
        response: { 200: z.object({ id: z.string() }) },
      },
    },
    async (req) => {
      const [agent] = await app.db
        .select({ id: schema.agents.id, isLocal: schema.agents.isLocal })
        .from(schema.agents)
        .where(
          and(eq(schema.agents.id, req.params.agentId), eq(schema.agents.tenantId, req.tenant!.id)),
        )
        .limit(1)
      if (!agent) throw app.httpErrors.notFound('Unknown agent')

      /*
       * The instance's own agent takes every instruction but one.
       *
       * This used to refuse all of them, which was one rule too broad: asking
       * it for its logs, or to turn its page on, is exactly as reasonable as
       * asking any other agent, and the operator was left with a menu holding
       * a single verb and no explanation.
       *
       * `stop` is the exception, and it is a real one. A stopped agent listens
       * for nothing, so nothing here could start it again — and the one it
       * would silence is the instance's own, which is what watches this server
       * when no other agent is looking. Pausing it is reversible from this same
       * screen and stays allowed.
       */
      if (agent.isLocal && req.body.kind === 'stop') {
        throw app.httpErrors.conflict(
          `${LOCAL_AGENT_NAME} watches this instance, and a stopped agent listens for nothing — ` +
            `nothing here could start it again. Pause it instead, or turn it off with TERN_LOCAL_AGENT=false.`,
        )
      }

      const [created] = await app.db
        .insert(schema.agentCommands)
        .values({
          tenantId: req.tenant!.id,
          agentId: agent.id,
          kind: req.body.kind,
          requestedBy: req.actor.userId ?? null,
        })
        .returning({ id: schema.agentCommands.id })

      await audit(app, {
        action: 'agent.command',
        tenantId: req.tenant!.id,
        actorId: req.actor.userId,
        target: agent.id,
        meta: { kind: req.body.kind },
        ip: req.ip,
      })

      return { id: created!.id }
    },
  )

  app.get(
    '/:slug/agents/:agentId/commands',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('agent:manage')],
      schema: {
        params: z.object({ slug: z.string(), agentId: z.string().uuid() }),
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              kind: z.string(),
              createdAt: z.string(),
              deliveredAt: z.string().nullable(),
              completedAt: z.string().nullable(),
              result: z.string().nullable(),
              error: z.string().nullable(),
            }),
          ),
        },
      },
    },
    async (req) => {
      const rows = await app.db
        .select()
        .from(schema.agentCommands)
        .where(
          and(
            eq(schema.agentCommands.agentId, req.params.agentId),
            eq(schema.agentCommands.tenantId, req.tenant!.id),
          ),
        )
        .orderBy(desc(schema.agentCommands.createdAt))
        .limit(20)

      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        createdAt: row.createdAt.toISOString(),
        deliveredAt: row.deliveredAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        result: row.result,
        error: row.error,
      }))
    },
  )

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
            /**
             * The code's own id, so the screen showing the PIN can ask whether
             * it has been redeemed.
             *
             * Not a secret, and not a second way in: the PIN is the credential
             * and this is a row identifier, readable only by someone who
             * already holds `agent:manage` on the tenant. Without it the admin
             * had no handle on the code it had just minted, and so no way to
             * notice the moment it stopped working.
             */
            id: z.string(),
            pin: z.string(),
            expiresAt: z.string(),
            maxUses: z.number(),
            pairCommand: z.string(),
            /**
             * The same PIN, for a relay rather than an agent.
             *
             * Both are returned because the code does not choose: the server
             * infers the role from the version the binary announces at pairing.
             * An admin who changes their mind after minting does not need a new
             * PIN, only the other line.
             */
            proxyPairCommand: z.string(),
          }),
        },
      },
    },
    async (req) => {
      const tenant = req.tenant!
      const pin = generatePin()
      const expiresAt = new Date(Date.now() + req.body.ttlMinutes * 60_000)

      const [created] = await app.db
        .insert(schema.pairingCodes)
        .values({
          tenantId: tenant.id,
          codeHash: hashToken(normalisePin(pin)),
          createdBy: req.actor.userId ?? null,
          expiresAt,
          maxUses: req.body.maxUses,
          scopeControlIds: req.body.scopeControlIds,
          autoRegister: req.body.autoRegister,
        })
        .returning({ id: schema.pairingCodes.id })

      await audit(app, {
        action: 'agent.pairing_code.created',
        tenantId: tenant.id,
        actorId: req.actor.userId,
        meta: { maxUses: req.body.maxUses, ttlMinutes: req.body.ttlMinutes },
        ip: req.ip,
      })

      return {
        id: created!.id,
        pin,
        expiresAt: expiresAt.toISOString(),
        maxUses: req.body.maxUses,
        // Ready to paste on the target machine — the point of the whole flow.
        pairCommand: renderAgentPairCommand(publicOrigin(), pin),
        proxyPairCommand: renderProxyInitCommand(publicOrigin(), pin),
      }
    },
  )

  /**
   * Whether a code has been redeemed, and by what.
   *
   * The screen that shows a PIN has no other way to know it has stopped
   * working. A single-use code is spent the moment a machine pairs with it, and
   * until now the admin went on displaying it — counting down, offering a Copy
   * button — for a credential that would be refused. The operator adding a
   * second machine copied a dead line and read the failure on the far end.
   *
   * By id rather than by PIN: asking "is *this* PIN spent?" would mean sending
   * the credential back up the wire on a timer, which is the one thing the
   * whole pairing dance exists to avoid.
   */
  app.get(
    '/:slug/pairing-codes/:codeId',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('agent:manage')],
      schema: {
        params: z.object({ slug: z.string(), codeId: z.string().uuid() }),
        response: {
          200: z.object({
            usedCount: z.number(),
            maxUses: z.number(),
            expiresAt: z.string(),
            consumedAt: z.string().nullable(),
            /** What paired with it — normally one machine, or none yet. */
            agents: z.array(z.object({ id: z.string(), name: z.string() })),
          }),
        },
      },
    },
    async (req) => {
      const [code] = await app.db
        .select()
        .from(schema.pairingCodes)
        .where(
          and(
            eq(schema.pairingCodes.id, req.params.codeId),
            // Scoped to the tenant in the query, not checked after: a code from
            // another tenant must be indistinguishable from one that never
            // existed.
            eq(schema.pairingCodes.tenantId, req.tenant!.id),
          ),
        )
        .limit(1)
      if (!code) throw app.httpErrors.notFound('Unknown pairing code')

      const paired = await app.db
        .select({ id: schema.agents.id, name: schema.agents.name })
        .from(schema.agents)
        .where(eq(schema.agents.pairingCodeId, code.id))

      return {
        usedCount: code.usedCount,
        maxUses: code.maxUses,
        expiresAt: code.expiresAt.toISOString(),
        consumedAt: code.consumedAt?.toISOString() ?? null,
        agents: paired,
      }
    },
  )

  app.get(
    '/:slug/agents',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('agent:read')],
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
              site: z.string().nullable(),
              /** `agent` or `proxy`. A proxy relays for a zone with no route out. */
              role: z.string(),
              /** The proxy this one reports through, when it does not reach here itself. */
              parentAgentId: z.string().nullable(),
              /**
               * The address it paired from.
               *
               * Stored since the table existed and never shown, which made
               * "which box is this?" a question answered by guessing at
               * hostnames. Null for an agent behind a proxy: the address the
               * proxy reports is the one it sees inside the zone, and this
               * server never saw it at all.
               */
              pairedIp: z.string().nullable(),
              /** Where a relay serves its zone. Null for anything else. */
              zoneAddress: z.string().nullable(),
              /** Every address it says it can be dialled on. Empty if it never said. */
              zoneAddresses: z.array(z.string()),
              /**
               * Where this agent serves its own page, as the agent reports it.
               *
               * Null covers every case where there is nothing to open: no page,
               * a page on loopback, a relay (which serves none), and a zone
               * agent this server never hears from directly.
               */
              uiAddress: z.string().nullable(),
              status: z.string(),
              lastSeenAt: z.string().nullable(),
              pairedAt: z.string(),
              /** Probes this agent actually runs, after the assignment. */
              jobCount: z.number(),
              /** Which ones, so the fleet screen can show them without a second call. */
              controls: z.array(z.object({ id: z.string(), key: z.string(), name: z.string() })),
              /**
               * The controls its key is limited to. Empty means every control —
               * which is what makes "is this control already covered" answerable
               * without a second request per agent.
               */
              scopeControlIds: z.array(z.string()),
              /** The instance's own agent, which cannot be revoked or deleted. */
              isLocal: z.boolean(),
              /**
               * Which network the local agent measures from — `service:app` or
               * `host`. Null for every other agent, which sits on a machine this
               * server knows nothing about.
               */
              networkMode: z.string().nullable(),
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
        // Ordered, because this screen refetches every half minute: rows that
        // swap places under the pointer are how the wrong agent gets revoked.
        .orderBy(schema.agents.createdAt)

      // The assignment is computed once for the whole tenant — rather than a
      // query per agent, which on a fleet screen is the shape that quietly
      // turns into a hundred round trips.
      const assignments = await assignmentsFor(app, req.tenant!.id)

      const keys = await app.db
        .select({ id: schema.apiKeys.id, scopeControlIds: schema.apiKeys.scopeControlIds })
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.tenantId, req.tenant!.id))
      const scopeById = new Map(keys.map((k) => [k.id, k.scopeControlIds]))

      return rows.map((row) => {
        const scope = row.apiKeyId ? scopeById.get(row.apiKeyId) : undefined
        const mine = [...assignments.values()]
          .filter(({ runners }) => runners.includes(row.id))
          .map(({ control }) => ({ id: control.id, key: control.key, name: control.name }))

        return {
          id: row.id,
          name: row.name,
          hostname: row.hostname,
          os: row.os,
          arch: row.arch,
          agentVersion: row.agentVersion,
          site: row.site,
          role: row.role,
          parentAgentId: row.parentAgentId,
          pairedIp: row.pairedIp,
          zoneAddress: row.zoneAddress,
          zoneAddresses: row.zoneAddresses ?? [],
          uiAddress: row.uiAddress,
          status: row.status,
          lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
          pairedAt: row.createdAt.toISOString(),
          jobCount: row.status === 'revoked' ? 0 : mine.length,
          controls: row.status === 'revoked' ? [] : mine,
          scopeControlIds: scope ?? [],
          // Sent so the fleet screen can say why the delete button is missing,
          // rather than offering one that answers 409.
          isLocal: row.isLocal,
          // Only meaningful for the local agent: it is this process's own
          // environment. A remote agent's network is its host's business, and
          // guessing at it here would be worse than saying nothing.
          networkMode: row.isLocal ? config.TERN_AGENT_NETWORK_MODE : null,
        }
      })
    },
  )

  /**
   * Naming and placing an agent.
   *
   * A fleet of thirty called `ip-10-0-4-17` is unreadable, and the hostname the
   * machine reports is rarely the name the people running it use.
   */
  app.patch(
    '/:slug/agents/:agentId',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('agent:manage')],
      schema: {
        params: z.object({ slug: z.string(), agentId: z.string().uuid() }),
        body: z.object({
          name: z.string().min(1).max(120).optional(),
          site: z.string().max(120).nullable().optional(),
        }),
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
        .set({
          ...(req.body.name === undefined ? {} : { name: req.body.name }),
          // An empty site clears it rather than storing a blank string, so the
          // fleet view has one notion of "not placed".
          ...(req.body.site === undefined ? {} : { site: req.body.site?.trim() || null }),
        })
        .where(eq(schema.agents.id, agent.id))

      await audit(app, {
        action: 'agent.updated',
        tenantId: req.tenant!.id,
        actorId: req.actor.userId,
        target: agent.id,
        meta: { name: req.body.name, site: req.body.site },
        ip: req.ip,
      })

      return { ok: true }
    },
  )

  /**
   * Revoke or delete several agents at once.
   *
   * Two verbs, because they are not the same act. **Revoke** kills the key and
   * keeps the record — the agent stops reporting and the fleet still shows that
   * it existed, which is what an audit needs. **Delete** removes the record
   * entirely, and is for tidying a list of long-dead agents rather than for
   * stopping one.
   *
   * Delete revokes first regardless of the agent's state: removing the row
   * while leaving a working credential behind would be a deletion in name only.
   */
  app.post(
    '/:slug/agents/bulk',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('agent:manage')],
      schema: {
        params: z.object({ slug: z.string() }),
        body: z.object({
          ids: z.array(z.string().uuid()).min(1).max(200),
          action: z.enum(['revoke', 'delete']),
        }),
        response: { 200: z.object({ ok: z.boolean(), affected: z.number() }) },
      },
    },
    async (req) => {
      const owned = await app.db
        .select({
          id: schema.agents.id,
          apiKeyId: schema.agents.apiKeyId,
          isLocal: schema.agents.isLocal,
        })
        .from(schema.agents)
        .where(
          and(eq(schema.agents.tenantId, req.tenant!.id), inArray(schema.agents.id, req.body.ids)),
        )

      // Every id checked before anything is written: a foreign id halfway
      // through would otherwise leave part of the request applied.
      if (owned.length !== req.body.ids.length) {
        throw app.httpErrors.notFound('Unknown agent in the selection')
      }

      // Checked here rather than silently skipped. A selection of six that
      // quietly acts on five is a bulk action whose result nobody can predict,
      // and the whole request is refused for the same reason a foreign id
      // refuses it: partial application is the failure mode worth avoiding.
      if (owned.some((agent) => agent.isLocal)) {
        throw app.httpErrors.conflict(
          `${LOCAL_AGENT_NAME} belongs to this instance and cannot be revoked or deleted. Set TERN_LOCAL_AGENT=false to turn it off.`,
        )
      }

      const keyIds = owned.map((a) => a.apiKeyId).filter((id): id is string => Boolean(id))

      await app.db.transaction(async (tx) => {
        // The key dies in both cases. A deleted record with a live credential
        // is worse than no deletion at all.
        if (keyIds.length > 0) {
          await tx
            .update(schema.apiKeys)
            .set({ revokedAt: new Date() })
            .where(inArray(schema.apiKeys.id, keyIds))
        }

        if (req.body.action === 'delete') {
          await tx.delete(schema.agents).where(inArray(schema.agents.id, req.body.ids))
        } else {
          await tx
            .update(schema.agents)
            .set({ status: 'revoked', revokedAt: new Date() })
            .where(inArray(schema.agents.id, req.body.ids))
        }
      })

      await audit(app, {
        action: req.body.action === 'delete' ? 'agent.deleted' : 'agent.revoked',
        tenantId: req.tenant!.id,
        actorId: req.actor.userId,
        // Ids rather than a count: after a bulk delete the records are gone, and
        // the log is the only place left that says which.
        meta: { agents: req.body.ids },
        ip: req.ip,
      })

      return { ok: true, affected: owned.length }
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

      // 409 rather than 403: this is not a permission the caller lacks — an
      // admin has every permission there is — it is a state the object refuses.
      if (agent.isLocal) {
        throw app.httpErrors.conflict(
          `${LOCAL_AGENT_NAME} belongs to this instance and cannot be revoked or deleted. Set TERN_LOCAL_AGENT=false to turn it off.`,
        )
      }

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

/**
 * Through `config`, not `process.env`: the config validates the URL at boot,
 * and reading the raw variable here let the pairing command and the installer
 * URLs (`download.ts`, which already used `config`) disagree about where this
 * instance lives.
 */
function publicOrigin(): string {
  return config.PUBLIC_BASE_URL
}

export default routes

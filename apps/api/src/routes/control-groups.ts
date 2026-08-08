import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import { audit } from '../services/audit.js'

/**
 * The folders controls are filed under.
 *
 * The table has been there from the start, controls carry a `groupId`, the
 * reorder endpoint moves them between groups and the public page already draws
 * each group as a heading. What was missing was any way to make one: no create,
 * no rename, no delete, so `groupId` could only ever be null and the whole read
 * path rendered a feature nobody could reach.
 *
 * Its own file rather than more of `controls.ts`, which is already the editor's
 * back end — simulation, probing, script generation and CRUD. Folders are a
 * different noun with a different lifetime.
 *
 * ## Nesting, and the one rule it needs
 *
 * `parentId` makes this a tree — "Europe > Paris > API" rather than a flat
 * list, which is also how the geographic breakdown other status pages ship as a
 * separate "locations" feature is meant to be expressed here.
 *
 * A tree stored as parent pointers has exactly one way to go wrong: a cycle. A
 * group made its own ancestor disappears from every listing that walks down
 * from the roots, takes its controls with it, and cannot be repaired through
 * the interface that created it. `wouldCycle` below is the guard, and it runs
 * on every move.
 */

const MAX_DEPTH = 5

interface GroupRow {
  id: string
  parentId: string | null
}

/**
 * Whether making `parentId` the parent of `id` closes a loop.
 *
 * Walks up from the proposed parent: if `id` is anywhere on that path, the edge
 * would point back into its own subtree. Bounded by the row count rather than
 * trusted to terminate — the data this reads is the data being repaired, and a
 * cycle already in the table would otherwise hang the request that came to fix
 * it.
 */
function wouldCycle(rows: GroupRow[], id: string, parentId: string | null): boolean {
  const parentOf = new Map(rows.map((row) => [row.id, row.parentId]))
  let cursor: string | null = parentId
  for (let step = 0; step <= rows.length; step += 1) {
    if (cursor === null) return false
    if (cursor === id) return true
    cursor = parentOf.get(cursor) ?? null
  }
  return true
}

/** How deep a group sits, counted from a root. Used to refuse a sixth level. */
function depthOf(rows: GroupRow[], parentId: string | null): number {
  const parentOf = new Map(rows.map((row) => [row.id, row.parentId]))
  let depth = 0
  let cursor: string | null = parentId
  while (cursor !== null && depth <= rows.length) {
    depth += 1
    cursor = parentOf.get(cursor) ?? null
  }
  return depth
}

const groupBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  position: z.number().int().min(0).optional(),
  /** How a folder's own status is derived from what it contains. */
  statusRollup: z.enum(['worst', 'majority', 'manual']).optional(),
  collapsedByDefault: z.boolean().optional(),
})

const groupShape = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  parentId: z.string().nullable(),
  position: z.number(),
  statusRollup: z.string(),
  collapsedByDefault: z.boolean(),
  /** Controls filed directly in this group — not counting its children's. */
  controlCount: z.number(),
})

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/:slug/control-groups',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('status:read:all')],
      schema: {
        params: z.object({ slug: z.string() }),
        response: { 200: z.array(groupShape) },
      },
    },
    async (req) => {
      const rows = await app.db
        .select()
        .from(schema.controlGroups)
        .where(eq(schema.controlGroups.tenantId, req.tenant!.id))
        .orderBy(schema.controlGroups.position, schema.controlGroups.name)

      // One grouped count rather than a query per folder: this list is drawn
      // every time the controls screen opens, and a fleet with thirty folders
      // would otherwise be thirty round trips behind it.
      const counts = await app.db
        .select({
          groupId: schema.controls.groupId,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.controls)
        .where(eq(schema.controls.tenantId, req.tenant!.id))
        .groupBy(schema.controls.groupId)

      const countByGroup = new Map(counts.map((row) => [row.groupId, row.count]))

      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        parentId: row.parentId,
        position: row.position,
        statusRollup: row.statusRollup,
        collapsedByDefault: row.collapsedByDefault,
        controlCount: countByGroup.get(row.id) ?? 0,
      }))
    },
  )

  app.post(
    '/:slug/control-groups',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('control:write')],
      schema: {
        params: z.object({ slug: z.string() }),
        body: groupBody,
        response: { 201: groupShape },
      },
    },
    async (req, reply) => {
      const rows = await app.db
        .select({ id: schema.controlGroups.id, parentId: schema.controlGroups.parentId })
        .from(schema.controlGroups)
        .where(eq(schema.controlGroups.tenantId, req.tenant!.id))

      const parentId = req.body.parentId ?? null

      // Checked against this tenant's own rows, not merely for existence: a
      // parent id from another tenant would otherwise file a folder under
      // somebody else's tree.
      if (parentId && !rows.some((row) => row.id === parentId)) {
        throw app.httpErrors.badRequest('Unknown parent group')
      }

      if (depthOf(rows, parentId) >= MAX_DEPTH) {
        throw app.httpErrors.badRequest(
          `Groups nest ${MAX_DEPTH} deep at most — a status page nobody can scan is not a page.`,
        )
      }

      const [created] = await app.db
        .insert(schema.controlGroups)
        .values({
          tenantId: req.tenant!.id,
          name: req.body.name,
          description: req.body.description ?? null,
          parentId,
          position: req.body.position ?? 0,
          ...(req.body.statusRollup ? { statusRollup: req.body.statusRollup } : {}),
          ...(req.body.collapsedByDefault === undefined
            ? {}
            : { collapsedByDefault: req.body.collapsedByDefault }),
        })
        .returning()

      await audit(app, {
        action: 'control_group.created',
        tenantId: req.tenant!.id,
        actorId: req.actor.userId,
        target: created!.id,
        meta: { name: created!.name },
        ip: req.ip,
      })

      return reply.code(201).send({
        id: created!.id,
        name: created!.name,
        description: created!.description,
        parentId: created!.parentId,
        position: created!.position,
        statusRollup: created!.statusRollup,
        collapsedByDefault: created!.collapsedByDefault,
        controlCount: 0,
      })
    },
  )

  app.patch(
    '/:slug/control-groups/:id',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('control:write')],
      schema: {
        params: z.object({ slug: z.string(), id: z.string().uuid() }),
        body: groupBody.partial(),
        response: { 200: groupShape },
      },
    },
    async (req) => {
      const rows = await app.db
        .select({ id: schema.controlGroups.id, parentId: schema.controlGroups.parentId })
        .from(schema.controlGroups)
        .where(eq(schema.controlGroups.tenantId, req.tenant!.id))

      if (!rows.some((row) => row.id === req.params.id)) throw app.httpErrors.notFound()

      if (req.body.parentId !== undefined) {
        const parentId = req.body.parentId
        if (parentId === req.params.id) {
          throw app.httpErrors.badRequest('A group cannot be its own parent')
        }
        if (parentId && !rows.some((row) => row.id === parentId)) {
          throw app.httpErrors.badRequest('Unknown parent group')
        }
        if (wouldCycle(rows, req.params.id, parentId)) {
          // Refused rather than repaired: the move would put this group inside
          // its own subtree, and every listing walks down from the roots — the
          // folder and everything in it would simply stop being drawn.
          throw app.httpErrors.badRequest('That move would put the group inside itself')
        }
        if (depthOf(rows, parentId) >= MAX_DEPTH) {
          throw app.httpErrors.badRequest(`Groups nest ${MAX_DEPTH} deep at most`)
        }
      }

      const [updated] = await app.db
        .update(schema.controlGroups)
        .set({
          ...(req.body.name === undefined ? {} : { name: req.body.name }),
          ...(req.body.description === undefined ? {} : { description: req.body.description }),
          ...(req.body.parentId === undefined ? {} : { parentId: req.body.parentId }),
          ...(req.body.position === undefined ? {} : { position: req.body.position }),
          ...(req.body.statusRollup === undefined ? {} : { statusRollup: req.body.statusRollup }),
          ...(req.body.collapsedByDefault === undefined
            ? {}
            : { collapsedByDefault: req.body.collapsedByDefault }),
        })
        .where(
          and(
            eq(schema.controlGroups.id, req.params.id),
            eq(schema.controlGroups.tenantId, req.tenant!.id),
          ),
        )
        .returning()

      const [tally] = await app.db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.controls)
        .where(eq(schema.controls.groupId, req.params.id))

      await audit(app, {
        action: 'control_group.updated',
        tenantId: req.tenant!.id,
        actorId: req.actor.userId,
        target: req.params.id,
        meta: { name: updated!.name },
        ip: req.ip,
      })

      return {
        id: updated!.id,
        name: updated!.name,
        description: updated!.description,
        parentId: updated!.parentId,
        position: updated!.position,
        statusRollup: updated!.statusRollup,
        collapsedByDefault: updated!.collapsedByDefault,
        controlCount: tally?.count ?? 0,
      }
    },
  )

  app.delete(
    '/:slug/control-groups/:id',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('control:write')],
      schema: {
        params: z.object({ slug: z.string(), id: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const rows = await app.db
        .select({ id: schema.controlGroups.id, parentId: schema.controlGroups.parentId })
        .from(schema.controlGroups)
        .where(eq(schema.controlGroups.tenantId, req.tenant!.id))

      if (!rows.some((row) => row.id === req.params.id)) throw app.httpErrors.notFound()

      /*
       * The folder goes; nothing it held does.
       *
       * `parentId` cascades on delete, so removing a group with children would
       * take the whole subtree with it — and the controls inside would survive
       * only because they reference it with `set null`. Deleting a folder is a
       * filing decision, not a decision about what is monitored, and an
       * operator who tidies their page must not discover the next morning that
       * they stopped watching six services.
       *
       * So the subtree is lifted to this group's own parent first, and the
       * controls are unfiled, before the row is removed.
       */
      const [target] = rows.filter((row) => row.id === req.params.id)

      await app.db.transaction(async (tx) => {
        await tx
          .update(schema.controlGroups)
          .set({ parentId: target!.parentId })
          .where(eq(schema.controlGroups.parentId, req.params.id))

        await tx
          .update(schema.controls)
          .set({ groupId: null })
          .where(
            and(
              eq(schema.controls.groupId, req.params.id),
              eq(schema.controls.tenantId, req.tenant!.id),
            ),
          )

        await tx
          .delete(schema.controlGroups)
          .where(
            and(
              eq(schema.controlGroups.id, req.params.id),
              eq(schema.controlGroups.tenantId, req.tenant!.id),
            ),
          )
      })

      await audit(app, {
        action: 'control_group.deleted',
        tenantId: req.tenant!.id,
        actorId: req.actor.userId,
        target: req.params.id,
        ip: req.ip,
      })

      return reply.code(204).send(null)
    },
  )

  /**
   * Filing several controls at once.
   *
   * Separate from the per-control PATCH because the gesture is different: the
   * screen offers a selection and one destination, and doing it as N requests
   * would leave a half-moved selection behind the first failure.
   */
  app.post(
    '/:slug/controls/move',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('control:write')],
      schema: {
        params: z.object({ slug: z.string() }),
        body: z.object({
          controlIds: z.array(z.string().uuid()).min(1).max(200),
          /** Null files them at the top level. */
          groupId: z.string().uuid().nullable(),
        }),
        response: { 200: z.object({ moved: z.number() }) },
      },
    },
    async (req) => {
      if (req.body.groupId) {
        const [group] = await app.db
          .select({ id: schema.controlGroups.id })
          .from(schema.controlGroups)
          .where(
            and(
              eq(schema.controlGroups.id, req.body.groupId),
              eq(schema.controlGroups.tenantId, req.tenant!.id),
            ),
          )
          .limit(1)
        if (!group) throw app.httpErrors.badRequest('Unknown group')
      }

      // Scoped to the tenant in the same statement rather than checked first:
      // an id belonging to somebody else then updates nothing, instead of being
      // reported as missing and telling the caller it exists.
      const moved = await app.db
        .update(schema.controls)
        .set({ groupId: req.body.groupId })
        .where(
          and(
            eq(schema.controls.tenantId, req.tenant!.id),
            inArray(schema.controls.id, req.body.controlIds),
          ),
        )
        .returning({ id: schema.controls.id })

      await audit(app, {
        action: 'control.moved',
        tenantId: req.tenant!.id,
        actorId: req.actor.userId,
        meta: { count: moved.length, groupId: req.body.groupId },
        ip: req.ip,
      })

      return { moved: moved.length }
    },
  )
}

export default routes
export const __testables = { wouldCycle, depthOf, MAX_DEPTH }

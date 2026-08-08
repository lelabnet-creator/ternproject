import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { schema } from '@tern/db'
import {
  formatImportIssue,
  MAX_IMPORT_BYTES,
  parseControlsFile,
  type ImportedControl,
} from '@tern/shared/control-import'
import { audit } from '../services/audit.js'

/**
 * Controls, imported from a YAML file.
 *
 * Separate from `controls.ts` because it is a different operation, not another
 * verb on the same one: it writes many rows at once, it resolves groups by
 * name, and its failure mode is a list of problems rather than a message. The
 * file format itself lives in `@tern/shared/control-import`, so a client can
 * validate before uploading and the parser is testable without a database.
 *
 * ## All or nothing
 *
 * One transaction. A file half applied is worse than a file rejected: the
 * person has to work out which controls landed before they can safely try
 * again, and a monitoring configuration that is partly the old one and partly
 * the new one is exactly the state nobody can reason about during an incident.
 *
 * ## Applied on top, keyed by `key`
 *
 * Importing the same file twice changes nothing the second time. The key is
 * already the identity scripts and agents push against, so it is the only thing
 * that could serve here — matching on name would rename-and-duplicate, and
 * matching on id would mean the file could not be written by hand.
 *
 * A field the file does not mention is left as it is, which is what makes a
 * partial file a legitimate thing to write: a file that sets only thresholds
 * adjusts thresholds, and does not quietly reset everything else to a default
 * it never stated. See the note on defaults in the shared module.
 */

const routes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/:slug/controls/import',
    {
      onRequest: [app.requireTenant()],
      preHandler: [app.requirePermission('control:write')],
      /*
       * Refused at the connection, before the body is buffered. The check in
       * the handler is about the YAML itself and gives a better message; this
       * one is about not reading a gigabyte into memory to find that out. The
       * margin covers the JSON envelope around the file.
       */
      bodyLimit: MAX_IMPORT_BYTES + 8 * 1024,
      schema: {
        params: z.object({ slug: z.string() }),
        body: z.object({
          /** The file, as text. Not multipart: the admin app reads it and posts it. */
          yaml: z.string(),
          /**
           * Validate and report what would happen, writing nothing.
           *
           * The reason it exists: the answer to "what will this file do to my
           * status page" should be obtainable without doing it, and the same
           * code path has to produce it or the preview is a guess.
           */
          dryRun: z.boolean().default(false),
        }),
        response: {
          200: z.object({
            dryRun: z.boolean(),
            created: z.number(),
            updated: z.number(),
            groupsCreated: z.number(),
            controls: z.array(
              z.object({ key: z.string(), action: z.enum(['created', 'updated']) }),
            ),
          }),
          /*
           * The list, not a message. Fastify's default error shape carries one
           * string, which is the shape this endpoint exists to improve on: a
           * file with six problems should take one round trip to fix, not six.
           */
          400: z.object({
            message: z.string(),
            issues: z.array(
              z.object({
                line: z.number().nullable(),
                column: z.number().nullable(),
                path: z.string(),
                key: z.string().nullable(),
                message: z.string(),
                received: z.string().nullable(),
                expected: z.string().nullable(),
                /** The same issue on one line, for a log or a terminal client. */
                detail: z.string(),
              }),
            ),
          }),
        },
      },
    },
    async (req, reply) => {
      const tenantId = req.tenant!.id

      if (Buffer.byteLength(req.body.yaml, 'utf8') > MAX_IMPORT_BYTES) {
        throw app.httpErrors.payloadTooLarge(
          `That file is larger than ${Math.round(MAX_IMPORT_BYTES / 1024)} KB. Split it into several imports.`,
        )
      }

      const parsed = parseControlsFile(req.body.yaml)
      if (!parsed.ok) {
        return reply.code(400).send({
          message:
            parsed.issues.length === 1
              ? 'One problem in the file. Nothing was imported.'
              : `${parsed.issues.length} problems in the file. Nothing was imported.`,
          issues: parsed.issues.map((issue) => ({
            line: issue.line,
            column: issue.column,
            path: issue.path,
            key: issue.key,
            message: issue.message,
            received: issue.received ?? null,
            expected: issue.expected ?? null,
            detail: formatImportIssue(issue),
          })),
        })
      }

      const outcome = await app.db.transaction(async (tx) =>
        apply(app, tx, tenantId, parsed.controls, req.body.dryRun),
      )

      if (!req.body.dryRun) {
        await audit(app, {
          action: 'control.imported',
          tenantId,
          actorId: req.actor.userId,
          target: tenantId,
          meta: {
            created: outcome.created,
            updated: outcome.updated,
            groupsCreated: outcome.groupsCreated,
            keys: outcome.controls.map((control) => control.key),
          },
          ip: req.ip,
        })
      }

      return { dryRun: req.body.dryRun, ...outcome }
    },
  )
}

type Tx = Parameters<Parameters<Parameters<FastifyPluginAsyncZod>[0]['db']['transaction']>[0]>[0]

interface Outcome {
  created: number
  updated: number
  groupsCreated: number
  controls: { key: string; action: 'created' | 'updated' }[]
}

/**
 * Applies the file inside one transaction, or works out what it would do.
 *
 * The dry run takes the same path rather than a parallel one that only reads:
 * a preview computed by different code is a preview that can disagree with the
 * import, which is worse than no preview. It reads the same rows, resolves the
 * same groups and raises the same conflicts — it simply does not write.
 */
async function apply(
  app: Parameters<FastifyPluginAsyncZod>[0],
  tx: Tx,
  tenantId: string,
  controls: ImportedControl[],
  dryRun: boolean,
): Promise<Outcome> {
  const keys = controls.map((control) => control.key)

  const existing = await tx
    .select({ id: schema.controls.id, key: schema.controls.key })
    .from(schema.controls)
    .where(and(eq(schema.controls.tenantId, tenantId), inArray(schema.controls.key, keys)))

  const existingByKey = new Map(existing.map((row) => [row.key, row.id]))

  const groups = await resolveGroups(app, tx, tenantId, controls, dryRun)

  const outcome: Outcome = { created: 0, updated: 0, groupsCreated: groups.created, controls: [] }

  // One statement per control rather than one multi-row insert: half of them
  // are updates, they carry different sets of columns, and the count is bounded
  // by the parser at a few hundred. Batching would trade a legible loop for a
  // saving nobody can measure on an operation somebody runs by hand.
  for (const control of controls) {
    const { group, groupId, ...columns } = control
    const resolved = groupFor(group, groupId, groups.byName)

    const values = { ...columns, ...(resolved === undefined ? {} : { groupId: resolved }) }
    const id = existingByKey.get(control.key)

    if (id) {
      outcome.updated += 1
      outcome.controls.push({ key: control.key, action: 'updated' })
      if (!dryRun) {
        await tx
          .update(schema.controls)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(schema.controls.id, id))
      }
      continue
    }

    outcome.created += 1
    outcome.controls.push({ key: control.key, action: 'created' })
    if (!dryRun) {
      await tx
        .insert(schema.controls)
        .values({ ...values, tenantId })
        // The read above is what decides created-versus-updated, and another
        // import could have inserted the same key between the two. Upserting on
        // the unique index makes that a wrong count in the response rather than
        // a failed import — the wrong number is recoverable, losing the file is
        // more annoying than it is worth.
        .onConflictDoUpdate({
          target: [schema.controls.tenantId, schema.controls.key],
          set: { ...values, updatedAt: new Date() },
        })
    }
  }

  return outcome
}

/**
 * Which group each control belongs to.
 *
 * Names, because a file written by a person cannot carry UUIDs. A name that
 * does not exist yet is created: importing a file that describes a structure
 * and then being told the structure does not exist would leave the reader to
 * create eight groups by hand and run the import again.
 *
 * Ambiguity is refused rather than guessed. Group names are not unique — the
 * tree is what disambiguates them on screen — so a file naming a group that
 * exists twice has no correct answer, and picking one silently would file
 * controls under the wrong heading on a public page.
 */
async function resolveGroups(
  app: Parameters<FastifyPluginAsyncZod>[0],
  tx: Tx,
  tenantId: string,
  controls: ImportedControl[],
  dryRun: boolean,
): Promise<{ byName: Map<string, string>; created: number }> {
  const wanted = [
    ...new Set(controls.map((control) => control.group).filter((name) => typeof name === 'string')),
  ]

  const explicitIds = [
    ...new Set(controls.map((control) => control.groupId).filter((id) => typeof id === 'string')),
  ]

  if (explicitIds.length > 0) {
    const owned = await tx
      .select({ id: schema.controlGroups.id })
      .from(schema.controlGroups)
      .where(
        and(
          eq(schema.controlGroups.tenantId, tenantId),
          inArray(schema.controlGroups.id, explicitIds),
        ),
      )
    const ownedIds = new Set(owned.map((row) => row.id))
    const unknown = explicitIds.find((id) => !ownedIds.has(id))
    // Checked before anything is written, and by tenant: a groupId from another
    // tenant must be a refusal, not a control filed under a foreign heading.
    if (unknown) throw app.httpErrors.notFound(`No group with id ${unknown} in this tenant`)
  }

  const byName = new Map<string, string>()
  if (wanted.length === 0) return { byName, created: 0 }

  const rows = await tx
    .select({ id: schema.controlGroups.id, name: schema.controlGroups.name })
    .from(schema.controlGroups)
    .where(
      and(eq(schema.controlGroups.tenantId, tenantId), inArray(schema.controlGroups.name, wanted)),
    )

  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.name)) {
      throw app.httpErrors.conflict(
        `This tenant has more than one group named "${row.name}". Use groupId for that control, or rename one of the groups.`,
      )
    }
    seen.add(row.name)
    byName.set(row.name, row.id)
  }

  const missing = wanted.filter((name) => !byName.has(name))
  if (missing.length === 0) return { byName, created: 0 }

  if (dryRun) return { byName, created: missing.length }

  const inserted = await tx
    .insert(schema.controlGroups)
    .values(missing.map((name) => ({ tenantId, name })))
    .returning({ id: schema.controlGroups.id, name: schema.controlGroups.name })

  for (const row of inserted) byName.set(row.name, row.id)

  return { byName, created: inserted.length }
}

/**
 * `undefined` leaves the control's group alone, `null` clears it.
 *
 * The distinction is the whole reason the import schema keeps every field
 * optional: a file that never mentions groups must not un-group everything it
 * touches.
 */
function groupFor(
  group: string | null | undefined,
  groupId: string | null | undefined,
  byName: Map<string, string>,
): string | null | undefined {
  if (group === null || groupId === null) return null
  if (typeof groupId === 'string') return groupId
  if (typeof group === 'string') return byName.get(group) ?? null
  return undefined
}

export default routes

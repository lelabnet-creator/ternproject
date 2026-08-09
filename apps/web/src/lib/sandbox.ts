import { DEFAULT_WIDGET } from '../charts/registry'
import { SANDBOX_OVERLAY_KEY } from './sandbox-flag'

/**
 * The demo, made writable — in this browser and nowhere else.
 *
 * A demo tenant refuses every write, which is what makes it safe to leave open
 * and also what makes it useless for looking at the half of the product that
 * writes. Nobody can see what creating a control feels like, or what an import
 * of forty of them reports, without first standing up an instance of their own.
 *
 * So the writes are answered here instead. Every admin request passes through
 * one function — `request` in `adminApi.ts` — and that is the only seam this
 * needs: reads go to the real server and come back with the browser's changes
 * laid over them, writes never leave the tab.
 *
 * ## Why an overlay rather than a fake server
 *
 * A fake server would have to invent the seeded demo data before it could
 * pretend to modify it, and it would drift from the real one the first time a
 * field was added. An overlay owns only the difference: three lists per
 * collection — created here, patched here, deleted here — applied to whatever
 * the API returns. A column added to controls tomorrow flows through untouched.
 *
 * ## What it does not answer
 *
 * `/api/v1/auth/*` and `/api/v1/system/*` are never intercepted. Signing in has
 * to be real or the session is a lie, and an instance upgrade is not a thing to
 * simulate — a button that claims to have pulled an image is worse than one
 * that says it cannot.
 *
 * Endpoints that do something to the outside world rather than to a row — send
 * a test mail, run a probe, pair an agent, purge logs — answer with a plausible
 * result and store nothing. There is nothing to store: their effect was never
 * in the database.
 *
 * ## Development only
 *
 * The switch that turns this on renders under `import.meta.env.DEV`, and the
 * call site imports this module dynamically inside the same condition, so none
 * of it reaches a production bundle. It is a test fixture with a UI, not a
 * feature: a public demo anyone could edit — even locally — invites screenshots
 * of a product state nobody shipped.
 */

/** Returned when the sandbox has no opinion and the request should go out. */
export const PASS = Symbol('pass')

/** Signed-in flows and instance-wide operations stay real. */
const NEVER = [/^\/api\/v1\/auth\//, /^\/api\/v1\/system\//]

interface Overlay {
  /** Rows invented here, per collection path. */
  created: Record<string, Row[]>
  /** Shallow field patches by row id, per collection path. */
  patched: Record<string, Record<string, Row>>
  /** Ids this browser considers gone, per collection path. */
  deleted: Record<string, string[]>
  /** Whole-object endpoints — settings, layout — merged rather than listed. */
  singletons: Record<string, Row>
}

type Row = Record<string, unknown>

function blank(): Overlay {
  return { created: {}, patched: {}, deleted: {}, singletons: {} }
}

export function readOverlay(): Overlay {
  try {
    const raw = localStorage.getItem(SANDBOX_OVERLAY_KEY)
    if (!raw) return blank()
    return { ...blank(), ...(JSON.parse(raw) as Partial<Overlay>) }
  } catch {
    return blank()
  }
}

function writeOverlay(overlay: Overlay): void {
  try {
    localStorage.setItem(SANDBOX_OVERLAY_KEY, JSON.stringify(overlay))
  } catch {
    /* over quota: the change is lost, which the next read will show plainly */
  }
}

/** Throws away everything written here, leaving the real demo behind. */
export function resetSandbox(): void {
  try {
    localStorage.removeItem(SANDBOX_OVERLAY_KEY)
  } catch {
    /* see above */
  }
}

/** How much this browser is currently pretending. */
export function sandboxSize(): number {
  const overlay = readOverlay()
  const count = (map: Record<string, unknown[]>) =>
    Object.values(map).reduce((total, list) => total + list.length, 0)
  return (
    count(overlay.created) +
    count(overlay.deleted) +
    Object.values(overlay.patched).reduce((total, rows) => total + Object.keys(rows).length, 0) +
    Object.keys(overlay.singletons).length
  )
}

/*
 * The shape of a row this browser invents.
 *
 * Only the fields the screens read. Everything the server would also have filled
 * — timestamps of checks that never ran, counts of things that do not exist — is
 * null, because that is what a row created a second ago actually looks like.
 */
interface Collection {
  /** What a POST body becomes. */
  seed: (body: Row, id: string) => Row
  /** What the POST answers with, which is rarely the whole row. */
  answer?: (row: Row) => unknown
}

const COLLECTIONS: Record<string, Collection> = {
  controls: {
    seed: (body, id) => ({
      id,
      key: String(body.key ?? id),
      name: String(body.name ?? body.key ?? 'Untitled'),
      description: null,
      groupId: null,
      kind: 'push',
      config: {},
      isPublic: true,
      enabled: true,
      expectedIntervalS: null,
      degradedThresholdMs: null,
      downThresholdMs: null,
      valueUnit: null,
      valueLabel: null,
      slaTarget: null,
      widget: DEFAULT_WIDGET,
      widgetOptions: {},
      position: 0,
      lastCheckAt: null,
      lastCheckStatus: null,
      lastCheckMessage: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      ...body,
    }),
    answer: (row) => ({ id: row.id, key: row.key }),
  },

  'control-groups': {
    seed: (body, id) => ({
      id,
      name: String(body.name ?? 'Untitled folder'),
      description: null,
      parentId: null,
      position: 0,
      statusRollup: 'worst',
      collapsedByDefault: false,
      controlCount: 0,
      ...body,
    }),
  },

  incidents: {
    seed: (body, id) => ({
      id,
      title: String(body.title ?? 'Untitled incident'),
      severity: 'minor',
      status: 'investigating',
      startedAt: new Date().toISOString(),
      resolvedAt: null,
      hasPostmortem: false,
      impacts: [],
      updates: [],
      ...body,
    }),
    answer: (row) => ({ id: row.id }),
  },

  maintenances: {
    seed: (body, id) => ({
      id,
      title: String(body.title ?? 'Untitled window'),
      body: null,
      status: 'scheduled',
      actualStart: null,
      actualEnd: null,
      autoTransition: true,
      suppressAlerts: true,
      isPublic: true,
      remindersBeforeMin: [],
      remindersSentAt: [],
      controlIds: [],
      updates: [],
      ...body,
    }),
    answer: (row) => ({ id: row.id }),
  },

  receivers: {
    seed: (body, id) => ({ id, url: `/api/v1/ingest/${id}`, ...body }),
    answer: (row) => ({ id: row.id, url: row.url }),
  },

  'notifications/webhooks': {
    seed: (body, id) => ({ id, confirmed: false, hasSecret: true, ...body }),
    answer: (row) => ({ id: row.id, secret: 'sandbox-secret-not-a-real-one' }),
  },
}

/**
 * Answers a request, or declines to.
 *
 * Async because the import endpoint runs the shared parser, which is fetched on
 * demand — and because a caller that awaits either way cannot tell the
 * difference, which keeps the seam in `adminApi` to a single line.
 */
export async function answer(
  method: string,
  path: string,
  body: unknown,
  fetchReal: (path: string) => Promise<unknown>,
): Promise<unknown | typeof PASS> {
  if (NEVER.some((pattern) => pattern.test(path))) return PASS

  const route = parse(path)
  if (!route) return PASS

  const overlay = readOverlay()

  if (method === 'GET') {
    // Reads still go out. The sandbox owns the difference, not the data: a
    // browser that answered reads from itself would show an estate frozen at
    // whatever the seed was on the day the switch was flipped.
    const real = await fetchReal(path)
    return applied(real, route, overlay)
  }

  const done = await mutate(method, route, (body ?? {}) as Row, overlay, fetchReal)
  if (done === PASS) return PASS

  writeOverlay(overlay)
  return done
}

interface Route {
  slug: string
  /** `controls`, `control-groups`, `notifications/webhooks`… */
  collection: string
  /** The row, when the path named one. */
  id: string | null
  /** A verb after the row or the collection: `updates`, `move`, `import`… */
  action: string | null
  /** What follows the `?`. Only `controls=delete` is read, on a folder delete. */
  query: URLSearchParams
}

/**
 * Splits a path into the four things the router cares about.
 *
 * The awkward part is that a collection can be two segments deep
 * (`notifications/webhooks`) and that some verbs sit exactly where an id would
 * (`controls/move`), so neither can be decided by counting. The known verbs are
 * listed instead, which is also the only honest way to say which ones are
 * handled.
 */
const VERBS = new Set([
  'move',
  'import',
  'simulate',
  'run',
  'pair',
  'bulk',
  'test',
  'updates',
  'postmortem',
  'transition',
  'scripts',
])

export function parse(path: string): Route | null {
  const [clean = '', search = ''] = path.split('?')
  const query = new URLSearchParams(search)
  const parts = clean.split('/').filter(Boolean)
  // api, v1, <slug>, …
  if (parts[0] !== 'api' || parts[1] !== 'v1' || parts.length < 4) return null

  const slug = parts[2]!
  let rest = parts.slice(3)

  // Two-segment collections, named rather than guessed.
  let collection = rest[0]!
  if (collection === 'notifications' && rest[1]) {
    collection = `notifications/${rest[1]}`
    rest = rest.slice(1)
  }
  rest = rest.slice(1)

  let id: string | null = null
  let action: string | null = null

  for (const segment of rest) {
    if (VERBS.has(segment)) action = segment
    else if (id === null) id = segment
    // A third kind of segment would be a shape this router does not know; it
    // falls through to PASS rather than being guessed at.
  }

  return { slug, collection, id, action, query }
}

/** The server's answer, with this browser's changes laid over it. */
function applied(real: unknown, route: Route, overlay: Overlay): unknown {
  const singleton = overlay.singletons[route.collection]
  if (singleton && !Array.isArray(real) && typeof real === 'object' && real !== null) {
    return { ...(real as Row), ...singleton }
  }

  if (!Array.isArray(real)) return real

  const deleted = new Set(overlay.deleted[route.collection] ?? [])
  const patched = overlay.patched[route.collection] ?? {}
  const created = overlay.created[route.collection] ?? []

  const rows = (real as Row[])
    .filter((row) => !deleted.has(String(row.id)))
    .map((row) => {
      const patch = patched[String(row.id)]
      return patch ? { ...row, ...patch } : row
    })

  // Created rows carry their own patches already applied on write, and are
  // appended rather than sorted in: a row made a moment ago belongs at the end
  // of the list the reader was already looking at.
  return [...rows, ...created.filter((row) => !deleted.has(String(row.id)))]
}

/** Applies a write to the overlay and says what the endpoint would have said. */
async function mutate(
  method: string,
  route: Route,
  body: Row,
  overlay: Overlay,
  fetchReal: (path: string) => Promise<unknown>,
): Promise<unknown | typeof PASS> {
  const { collection, id, action } = route

  // ── Actions that touch the world rather than a row ────────────────────────
  // Nothing to store, because their effect was never a row: what they need to
  // answer is a shape the screen can render.
  if (action === 'test') return { sent: true, detail: 'Not sent — the sandbox answered.' }
  if (action === 'run') return probeResult()
  if (action === 'pair')
    return {
      pin: '000000',
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      pairCommand: 'tern-agent pair --pin 000000  # the sandbox invented this',
    }
  if (action === 'simulate')
    return method === 'DELETE' ? { deleted: 0 } : { inserted: Number(body.points ?? 0) }

  // ── Collection-shaped writes ──────────────────────────────────────────────
  if (action === 'import') return importControls(route, body, overlay, fetchReal)
  if (action === 'move') return move(route, body, overlay)
  if (action === 'bulk') return bulk(route, body, overlay)
  if (action === 'updates' && id) return appendUpdate(route, body, overlay)
  if (action === 'postmortem' && id) {
    patch(overlay, collection, id, { hasPostmortem: true })
    return { published: Boolean(body.published ?? true) }
  }
  if (action === 'transition' && id) {
    patch(overlay, collection, id, { status: body.status })
    return { id, status: body.status }
  }

  // Whole-object endpoints: one merged object rather than a list of rows.
  if (collection === 'settings' || collection === 'layout') {
    overlay.singletons[collection] = { ...(overlay.singletons[collection] ?? {}), ...body }
    return collection === 'layout' ? { ok: true, reordered: 0 } : { ok: true }
  }

  const shape = COLLECTIONS[collection]
  if (!shape) return PASS

  if (method === 'POST' && !id) {
    const row = shape.seed(body, newId())
    ;(overlay.created[collection] ??= []).push(row)
    return shape.answer ? shape.answer(row) : row
  }

  if (method === 'PATCH' && id) {
    patch(overlay, collection, id, body)
    const row = created(overlay, collection, id)
    return row ?? { ok: true }
  }

  if (method === 'DELETE' && id) {
    /*
     * A folder taken down with its contents.
     *
     * Mirrored here rather than left to diverge: the point of the sandbox is to
     * see a flow behave as it will, and a confirmation offering to delete six
     * controls that then quietly unfiled them would teach the opposite of what
     * the server does. Only the controls filed directly here, as on the server.
     */
    if (collection === 'control-groups' && route.query.get('controls') === 'delete') {
      const controls = applied(
        await fetchReal(`/api/v1/${route.slug}/controls`),
        { ...route, collection: 'controls' },
        overlay,
      )
      const inside = (Array.isArray(controls) ? (controls as Row[]) : []).filter(
        (row) => row.groupId === id,
      )
      const gone = (overlay.deleted.controls ??= [])
      for (const row of inside) gone.push(String(row.id))
      overlay.created.controls = (overlay.created.controls ?? []).filter(
        (row) => row.groupId !== id,
      )
      ;(overlay.deleted[collection] ??= []).push(id)
      overlay.created[collection] = (overlay.created[collection] ?? []).filter(
        (row) => String(row.id) !== id,
      )
      return { deleted: inside.length, unfiled: 0 }
    }

    ;(overlay.deleted[collection] ??= []).push(id)
    // Also dropped from the created list, so a row made and unmade here leaves
    // nothing behind at all.
    overlay.created[collection] = (overlay.created[collection] ?? []).filter(
      (row) => String(row.id) !== id,
    )
    return { ok: true }
  }

  return PASS
}

function patch(overlay: Overlay, collection: string, id: string, body: Row): void {
  const made = created(overlay, collection, id)
  if (made) {
    Object.assign(made, body)
    return
  }
  const rows = (overlay.patched[collection] ??= {})
  rows[id] = { ...(rows[id] ?? {}), ...body }
}

function created(overlay: Overlay, collection: string, id: string): Row | undefined {
  return (overlay.created[collection] ?? []).find((row) => String(row.id) === id)
}

/** Files a selection, which is a patch of one field across several rows. */
function move(route: Route, body: Row, overlay: Overlay): unknown {
  const ids = Array.isArray(body.controlIds) ? (body.controlIds as string[]) : []
  for (const id of ids) patch(overlay, route.collection, id, { groupId: body.groupId ?? null })
  return { moved: ids.length }
}

function bulk(route: Route, body: Row, overlay: Overlay): unknown {
  const ids = Array.isArray(body.ids) ? (body.ids as string[]) : []
  const { ids: _ignored, ...fields } = body
  for (const id of ids) patch(overlay, route.collection, id, fields)
  return { ok: true, affected: ids.length }
}

/** One more thing said about an incident or a window, appended to its own list. */
function appendUpdate(route: Route, body: Row, overlay: Overlay): unknown {
  const id = route.id!
  const entry = {
    id: newId(),
    status: body.status,
    body: body.body,
    createdAt: new Date().toISOString(),
  }
  const current = created(overlay, route.collection, id)
  const existing = Array.isArray(current?.updates)
    ? (current!.updates as Row[])
    : ((overlay.patched[route.collection]?.[id]?.updates as Row[] | undefined) ?? [])

  patch(overlay, route.collection, id, {
    updates: [...existing, entry],
    status: body.status,
    ...(body.status === 'resolved' ? { resolvedAt: new Date().toISOString() } : {}),
  })
  return { id: entry.id, status: body.status }
}

/**
 * A YAML import, applied to the overlay exactly as the endpoint applies it to
 * the database.
 *
 * The same parser, the same upsert on `key`, the same resolve-groups-by-name
 * and create-what-is-missing — because a preview that disagreed with the import
 * would be the one thing this is supposed to let somebody see working. What it
 * cannot reproduce is the transaction: a browser has no way to half-apply and
 * roll back, so the validation is done first and nothing is touched until it
 * passes, which reaches the same end by a shorter road.
 */
async function importControls(
  route: Route,
  body: Row,
  overlay: Overlay,
  fetchReal: (path: string) => Promise<unknown>,
): Promise<unknown> {
  const { parseControlsFile } = await import('@tern/shared/control-import')
  const parsed = parseControlsFile(String(body.yaml ?? ''))

  if (!parsed.ok) {
    // The same 400 the API would have sent, thrown the same way `request` would
    // have thrown it — the screen must not need to know which side refused.
    const { ApiError } = await import('./api')
    throw new ApiError(
      parsed.issues.length === 1
        ? 'One problem in the file. Nothing was imported.'
        : `${parsed.issues.length} problems in the file. Nothing was imported.`,
      400,
      {
        message: 'Nothing was imported.',
        issues: parsed.issues.map((issue) => ({
          ...issue,
          received: issue.received ?? null,
          expected: issue.expected ?? null,
          detail: issue.message,
        })),
      },
    )
  }

  const dryRun = body.dryRun === true

  // The real list, so that a key already in the demo counts as an update rather
  // than a second control with the same name.
  const existing = applied(
    await fetchReal(`/api/v1/${route.slug}/controls`),
    { ...route, collection: 'controls' },
    overlay,
  )
  const byKey = new Map(
    (Array.isArray(existing) ? (existing as Row[]) : []).map((row) => [String(row.key), row]),
  )

  const groups = groupsByName(overlay)
  const outcome = {
    dryRun,
    created: 0,
    updated: 0,
    groupsCreated: 0,
    controls: [] as { key: string; action: 'created' | 'updated' }[],
  }

  for (const control of parsed.controls) {
    const { group, groupId, ...columns } = control
    let resolved: string | null | undefined = groupId

    if (typeof group === 'string') {
      const known = groups.get(group)
      if (known) resolved = known
      else {
        const id = newId()
        outcome.groupsCreated += 1
        groups.set(group, id)
        if (!dryRun) {
          ;(overlay.created['control-groups'] ??= []).push(
            COLLECTIONS['control-groups']!.seed({ name: group }, id),
          )
        }
        resolved = id
      }
    } else if (group === null) {
      resolved = null
    }

    const values = { ...columns, ...(resolved === undefined ? {} : { groupId: resolved }) }
    const found = byKey.get(control.key)

    if (found) {
      outcome.updated += 1
      outcome.controls.push({ key: control.key, action: 'updated' })
      if (!dryRun) patch(overlay, 'controls', String(found.id), values)
      continue
    }

    outcome.created += 1
    outcome.controls.push({ key: control.key, action: 'created' })
    if (!dryRun) {
      ;(overlay.created.controls ??= []).push(COLLECTIONS.controls!.seed(values as Row, newId()))
    }
  }

  return outcome
}

/**
 * Folders this browser knows about, by name.
 *
 * Only the ones it created: a name already in the demo is resolved by the real
 * list on the way past, and re-creating one here would file controls under a
 * second folder with the same heading.
 */
function groupsByName(overlay: Overlay): Map<string, string> {
  return new Map(
    (overlay.created['control-groups'] ?? []).map((row) => [String(row.name), String(row.id)]),
  )
}

/** A probe result with nothing behind it, said plainly enough not to mislead. */
function probeResult(): unknown {
  return {
    status: 'operational',
    latencyMs: 42,
    message: 'The sandbox answered this. No request left the browser.',
    assertions: [],
  }
}

function newId(): string {
  return crypto.randomUUID()
}

import { isNode, LineCounter, parseDocument, type Document } from 'yaml'
import { z } from 'zod'
import {
  bodyAssertionSchema,
  certExpiryAssertionSchema,
  certProbeSchema,
  dnsAssertionSchema,
  dnsProbeSchema,
  dockerProbeSchema,
  headerAssertionSchema,
  httpProbeSchema,
  jsonPathAssertionSchema,
  jsonSearchAssertionSchema,
  latencyAssertionSchema,
  pingProbeSchema,
  statusCodeAssertionSchema,
  tcpProbeSchema,
  websocketProbeSchema,
} from './probe.js'

/**
 * Controls, described in a file.
 *
 * The editor is the right way to build one control. It is the wrong way to
 * build forty: someone migrating off another tool, or standing up a second
 * environment, already has the list — in a spreadsheet, in a Terraform module,
 * in a colleague's runbook. This reads that list.
 *
 * ## Why the errors are the whole feature
 *
 * A file of forty controls is applied as a unit (see the endpoint), so when it
 * fails the only thing that matters is whether the reader can find the problem
 * without bisecting the file by hand. `invalid input` cannot; neither can a
 * dump of Zod paths. Every issue returned here carries four things: where it is
 * (line, and a path in the file's own vocabulary), what was found, and what
 * would have been accepted. The line comes from the YAML syntax tree, which is
 * why the document is read with `parseDocument` and a `LineCounter` rather than
 * with `parse` — the plain object a parser returns has no idea where it came
 * from.
 *
 * ## Why absent is not the same as default
 *
 * The file is applied on top of what already exists, keyed by `key`. A control
 * the file does not mention is left alone, and so is a *field* it does not
 * mention: re-importing a file that only ever set `name` and `kind` must not
 * silently re-enable forty controls somebody switched off. That is the one
 * place this schema deliberately differs from the API's `POST /controls` body,
 * which fills in defaults because it is creating a control out of nothing.
 * Every field below is therefore optional except the two that identify the
 * control, and the defaults stay where they belong — on the database columns,
 * applied only on insert.
 *
 * ## Why it is strict
 *
 * Unknown keys are rejected rather than ignored. A `timeoutMs` misspelt as
 * `timeout_ms` and silently dropped is a probe that times out at ten seconds
 * forever, and a person certain they configured it otherwise. Strictness is
 * also what makes useful guidance possible at all: the accepted names can be
 * listed in the error.
 *
 * The field list mirrors `controlBody` in `apps/api/src/routes/controls.ts`
 * field for field and bound for bound. It is not imported from there because
 * `packages/shared` cannot depend on the API, and the API does not import this
 * one because of the defaults question above. Changing a bound in one place and
 * not the other is a drift bug; the shape is small enough to keep in step, and
 * `docs/import.md` states the bounds once for both.
 */

/**
 * The probe half of a control, made strict.
 *
 * `probeSchema` itself cannot be strict: it is also the wire format the Rust
 * agent and the ingest path read, where tolerating a field a newer server added
 * is how a fleet survives a staggered upgrade. A file somebody is typing has
 * the opposite need — there, an unknown key is a typo every time.
 */
const strictAssertionSchema = z.discriminatedUnion('type', [
  statusCodeAssertionSchema.strict(),
  latencyAssertionSchema.strict(),
  bodyAssertionSchema.strict(),
  headerAssertionSchema.strict(),
  jsonPathAssertionSchema.strict(),
  jsonSearchAssertionSchema.strict(),
  certExpiryAssertionSchema.strict(),
  dnsAssertionSchema.strict(),
])

const strictAssertions = { assertions: z.array(strictAssertionSchema).default([]) }

const strictProbeSchema = z.discriminatedUnion('type', [
  pingProbeSchema.strict().extend(strictAssertions),
  tcpProbeSchema.strict().extend(strictAssertions),
  httpProbeSchema.strict().extend(strictAssertions),
  dnsProbeSchema.strict().extend(strictAssertions),
  certProbeSchema.strict().extend(strictAssertions),
  websocketProbeSchema.strict().extend(strictAssertions),
  dockerProbeSchema.strict().extend(strictAssertions),
])

/**
 * Kept in step with the `control_kind` enum in `@tern/db`, and in the same
 * order — the enum is appended to and never reordered, so this list reads as
 * the history of what the product learned to check.
 *
 * `docker` is accepted here even though the server cannot run it. A file is a
 * description of what to monitor, not a claim about who monitors it: the
 * control is created, and the assignment to an agent that has the socket is a
 * separate decision made on a separate screen. Refusing it at import would mean
 * a fleet's file could not describe the fleet's own containers.
 */
export const CONTROL_KINDS = [
  'push',
  'http',
  'tcp',
  'ping',
  'dns',
  'cert',
  'websocket',
  'docker',
] as const

/**
 * How much file is accepted, in bytes of UTF-8.
 *
 * Room for a few hundred controls at a generous kilobyte each. The number lives
 * here rather than in the route because the documentation and the tests have to
 * agree with it, and because a client can then refuse a file before uploading
 * it instead of after.
 */
export const MAX_IMPORT_BYTES = 256 * 1024

/** A second bound, on the parsed shape: one file may not describe more than this. */
export const MAX_CONTROLS_PER_IMPORT = 500

const controlFields = z
  .object({
    key: z
      .string()
      .min(1)
      .max(200)
      .regex(
        /^[a-z0-9][a-z0-9._-]*$/,
        'Use lowercase letters, digits, dot, dash or underscore, starting with a letter or a digit',
      ),
    name: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
    /**
     * The group by name, which is the only form a person can write. The
     * endpoint resolves it against the tenant's groups, and creates it when it
     * is new.
     */
    group: z.string().min(1).max(200).nullable().optional(),
    /** The escape hatch, for a tenant where two groups share a name. */
    groupId: z.string().uuid().nullable().optional(),
    kind: z.enum(CONTROL_KINDS).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    expectedIntervalS: z.number().int().min(10).max(86_400).nullable().optional(),
    degradedThresholdMs: z.number().int().positive().nullable().optional(),
    downThresholdMs: z.number().int().positive().nullable().optional(),
    valueUnit: z.string().max(30).nullable().optional(),
    valueLabel: z.string().max(60).nullable().optional(),
    slaTarget: z.number().int().min(0).max(10_000).nullable().optional(),
    widget: z.string().max(60).optional(),
    widgetOptions: z.record(z.string(), z.unknown()).optional(),
    isPublic: z.boolean().optional(),
    /**
     * Accepted here although `POST /controls` does not accept it. The column
     * exists and the scheduler reads it, and a file describing a fleet is
     * exactly where "this one is off for now" belongs — without it, an imported
     * file could not reproduce the state it was written from.
     */
    enabled: z.boolean().optional(),
    position: z.number().int().min(0).optional(),
  })
  .strict()

const controlSchema = controlFields.superRefine((control, ctx) => {
  if (control.group != null && control.groupId != null) {
    ctx.addIssue({
      code: 'custom',
      path: ['group'],
      message: 'Give either group or groupId, not both — they name the same thing',
    })
  }

  // Mirrors `assertThresholdOrder` in the controls route: a degraded threshold
  // at or above the down threshold makes the degraded band unreachable.
  if (
    control.degradedThresholdMs != null &&
    control.downThresholdMs != null &&
    control.degradedThresholdMs >= control.downThresholdMs
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['degradedThresholdMs'],
      message: `Must be below downThresholdMs (${control.downThresholdMs}), or the degraded state can never occur`,
    })
  }

  const kind = control.kind ?? 'push'

  if (kind === 'push') {
    if (control.config && Object.keys(control.config).length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['config'],
        message:
          'A push control is reported to rather than probed, so it has no config. Give it a kind of http, tcp, ping, dns or cert to describe a check.',
      })
    }
    return
  }

  if (!control.config) {
    ctx.addIssue({
      code: 'custom',
      path: ['config'],
      message: `A ${kind} control needs a config block saying what to check`,
    })
    return
  }

  // The probe is validated as the union member the kind selects, which is how
  // the API and the local prober read it back too: `{ type: kind, ...config }`.
  // A complaint about that spliced `type` is re-pointed at the config as a
  // whole, so that every reported path names something the file contains —
  // there is no `type:` line to blame. Only the discriminator at the root: an
  // assertion's own `type` is a real field on a real line.
  const probe = strictProbeSchema.safeParse({ type: kind, ...control.config })
  if (probe.success) return

  for (const issue of probe.error.issues) {
    const path = issue.path.length === 1 && issue.path[0] === 'type' ? [] : issue.path
    ctx.addIssue({ ...issue, path: ['config', ...path] })
  }
})

const fileSchema = z
  .object({
    /**
     * Optional today, and checked when present. Nothing branches on it yet; it
     * exists so a second format has somewhere to announce itself, and so a file
     * written now still parses then.
     */
    version: z.literal(1).optional(),
    controls: z.array(controlSchema).min(1).max(MAX_CONTROLS_PER_IMPORT),
  })
  .strict()

export type ImportedControl = z.infer<typeof controlSchema>

/** One thing wrong with the file, said precisely enough to act on. */
export interface ImportIssue {
  /** 1-based, in the YAML source. Null when nothing in the file locates it. */
  line: number | null
  column: number | null
  /** Where in the document, as the file reads: `controls[3].config.url`. */
  path: string
  /** The control's `key`, when the file got far enough to have one. */
  key: string | null
  message: string
  /** What was there, rendered short. Absent when the field was simply missing. */
  received?: string
  /** What would have been accepted, when it can be stated as a list or a bound. */
  expected?: string
}

export type ImportParseResult =
  { ok: true; controls: ImportedControl[] } | { ok: false; issues: ImportIssue[] }

/**
 * Parses and validates an import file.
 *
 * Pure: it reads no database and resolves no group. Everything knowable from
 * the file alone is decided here, so the endpoint's transaction opens already
 * knowing the file is good — and so a client can run the same validation before
 * uploading anything at all.
 */
export function parseControlsFile(source: string): ImportParseResult {
  if (byteLength(source) > MAX_IMPORT_BYTES) {
    return {
      ok: false,
      issues: [
        at(
          `The file is larger than ${Math.round(MAX_IMPORT_BYTES / 1024)} KB. Split it, or take out what is not a control.`,
        ),
      ],
    }
  }

  const lineCounter = new LineCounter()
  const doc = parseDocument(source, { lineCounter })

  // Syntax first, and alone. A document that did not parse has no trustworthy
  // contents to validate, and twenty schema complaints derived from a half-read
  // file bury the one line that actually needs fixing.
  if (doc.errors.length > 0) {
    return {
      ok: false,
      issues: doc.errors.map((error) => ({
        line: error.linePos?.[0]?.line ?? null,
        column: error.linePos?.[0]?.col ?? null,
        path: '',
        key: null,
        message: `This is not valid YAML: ${firstLine(error.message)}`,
      })),
    }
  }

  const data: unknown = doc.toJS()

  if (data === null || data === undefined) {
    return {
      ok: false,
      issues: [at('The file is empty. It should hold a controls: list — see docs/import.md.')],
    }
  }

  const parsed = fileSchema.safeParse(data)

  const issues = [
    ...(parsed.success
      ? []
      : parsed.error.issues.flatMap((issue) => expand(issue, data, doc, lineCounter))),
    ...duplicateKeyIssues(data, doc, lineCounter),
  ].sort(byPosition)

  if (issues.length > 0 || !parsed.success) return { ok: false, issues }
  return { ok: true, controls: parsed.data.controls }
}

/** One line, for a log or a terminal. A UI can lay the fields out its own way. */
export function formatImportIssue(issue: ImportIssue): string {
  const where = [
    issue.line === null ? null : `line ${issue.line}`,
    issue.path === '' ? null : issue.path,
  ]
    .filter(Boolean)
    .join(' · ')

  const detail = [
    issue.received === undefined ? null : `found ${issue.received}`,
    issue.expected === undefined ? null : `expected ${issue.expected}`,
  ].filter(Boolean)

  const suffix = detail.length === 0 ? '' : ` (${detail.join(', ')})`
  return where === '' ? `${issue.message}${suffix}` : `${where} — ${issue.message}${suffix}`
}

/** An issue about the file as a whole, with nowhere in particular to point. */
function at(message: string): ImportIssue {
  return { line: null, column: null, path: '', key: null, message }
}

/**
 * Turns one Zod issue into one or more reportable issues.
 *
 * More than one for `unrecognized_keys`, which Zod reports once per object with
 * every offending name inside it. Split so each typo gets its own line, because
 * two typos in one control are usually not on the same one.
 */
function expand(
  issue: z.core.$ZodIssue,
  data: unknown,
  doc: Document,
  lineCounter: LineCounter,
): ImportIssue[] {
  if (issue.code === 'unrecognized_keys') {
    const accepted = acceptedKeysAt(issue.path)
    return issue.keys.map((name) => ({
      ...locate(doc, lineCounter, [...issue.path, name]),
      path: pathString([...issue.path, name]),
      key: keyOf(data, issue.path),
      message: `Unknown field ${JSON.stringify(name)}`,
      ...(accepted === null ? {} : { expected: `one of ${accepted}` }),
    }))
  }

  const value = valueAt(data, issue.path)
  const { message, expected } = explain(issue, value !== undefined)

  return [
    {
      ...locate(doc, lineCounter, issue.path),
      path: pathString(issue.path),
      key: keyOf(data, issue.path),
      message,
      ...(expected === undefined ? {} : { expected }),
      // A missing field has no value worth printing, and printing `undefined`
      // would say the same thing for "absent" and for "written as null".
      ...(value === undefined ? {} : { received: render(value) }),
    },
  ]
}

/**
 * A readable sentence per Zod issue code.
 *
 * Zod's own messages are fine in a form, where the field is named by the label
 * beside it and the choices are in the widget. In a file they are not: "Invalid
 * option" says nothing about which options existed, and that list is the entire
 * answer the reader needs.
 */
function explain(
  issue: z.core.$ZodIssue,
  present: boolean,
): { message: string; expected?: string } {
  switch (issue.code) {
    case 'invalid_type':
      return present
        ? { message: `Expected ${issue.expected}`, expected: issue.expected }
        : { message: 'Required, and missing', expected: issue.expected }

    case 'invalid_value':
      return {
        message: 'Not one of the accepted values',
        expected: issue.values.map((value) => String(value)).join(', '),
      }

    case 'invalid_union':
      // Reached when a discriminator does not match — an unknown assertion type
      // inside a probe, since `kind` is an enum checked before this.
      return {
        message: 'Not one of the accepted types',
        expected: 'options' in issue ? (issue.options as unknown[]).join(', ') : undefined,
      }

    case 'too_small':
      if (issue.origin === 'string') {
        return { message: `Must be at least ${issue.minimum} character(s) long` }
      }
      if (issue.origin === 'array') {
        return { message: `Must hold at least ${issue.minimum} entries` }
      }
      return { message: `Must be at least ${issue.minimum}` }

    case 'too_big':
      if (issue.origin === 'string') {
        return { message: `Must be at most ${issue.maximum} character(s) long` }
      }
      if (issue.origin === 'array') {
        return { message: `Must hold at most ${issue.maximum} entries` }
      }
      return { message: `Must be at most ${issue.maximum}` }

    case 'invalid_format':
      return { message: issue.message, expected: issue.format }

    default:
      return { message: issue.message }
  }
}

/**
 * The names accepted at a path, for the second half of an unknown-field error.
 *
 * Only the two shapes worth listing: the file itself, and a control. Inside a
 * probe the accepted names depend on the kind, and the strict probe schema has
 * already named them in its own message; inside `widgetOptions` there is no
 * fixed list to give.
 */
function acceptedKeysAt(path: readonly PropertyKey[]): string | null {
  if (path.length === 0) return Object.keys(fileSchema.shape).join(', ')
  if (path.length === 2 && path[0] === 'controls')
    return Object.keys(controlFields.shape).join(', ')
  return null
}

/**
 * Controls sharing a `key` inside one file.
 *
 * Checked here rather than as a schema refinement so it can name the line of
 * the first occurrence: by the time Zod reaches the second one, the document is
 * out of reach. It also runs when the schema failed — two controls called `api`
 * is worth saying in the same pass as the typo three lines above.
 */
function duplicateKeyIssues(data: unknown, doc: Document, lineCounter: LineCounter): ImportIssue[] {
  const controls = (data as { controls?: unknown } | null)?.controls
  if (!Array.isArray(controls)) return []

  const seen = new Map<string, number>()
  const issues: ImportIssue[] = []

  for (const [index, control] of controls.entries()) {
    const key: unknown = (control as { key?: unknown } | null)?.key
    if (typeof key !== 'string' || key === '') continue

    const first = seen.get(key)
    if (first === undefined) {
      seen.set(key, index)
      continue
    }

    const firstLine = locate(doc, lineCounter, ['controls', first, 'key']).line
    issues.push({
      ...locate(doc, lineCounter, ['controls', index, 'key']),
      path: pathString(['controls', index, 'key']),
      key,
      message:
        `Duplicate control key ${JSON.stringify(key)}` +
        (firstLine === null ? '' : `, already used on line ${firstLine}`) +
        '. A key identifies one control, so two entries sharing one would import as a single control.',
    })
  }

  return issues
}

/**
 * Where a path is in the source.
 *
 * Walks up when the exact node is absent, which is the common case: a missing
 * required field has no node of its own, so the enclosing control is the
 * closest true answer — and a line pointing at the right control beats no line.
 */
function locate(
  doc: Document,
  lineCounter: LineCounter,
  path: readonly PropertyKey[],
): { line: number | null; column: number | null } {
  for (let depth = path.length; depth >= 0; depth--) {
    const node = depth === 0 ? doc.contents : doc.getIn(path.slice(0, depth), true)
    if (isNode(node) && node.range) {
      const position = lineCounter.linePos(node.range[0])
      return { line: position.line, column: position.col }
    }
  }
  return { line: null, column: null }
}

/** `controls[3].config.assertions[0].ms` — how the file reads, not how Zod does. */
function pathString(path: readonly PropertyKey[]): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') return `${acc}[${segment}]`
    return acc === '' ? String(segment) : `${acc}.${String(segment)}`
  }, '')
}

function valueAt(data: unknown, path: readonly PropertyKey[]): unknown {
  let current = data
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<PropertyKey, unknown>)[segment]
  }
  return current
}

/** The key of the control a path falls inside, so an issue can name it. */
function keyOf(data: unknown, path: readonly PropertyKey[]): string | null {
  if (path[0] !== 'controls' || typeof path[1] !== 'number') return null
  const key = valueAt(data, ['controls', path[1], 'key'])
  return typeof key === 'string' ? key : null
}

/** Short, and never a wall of JSON: this is for recognition, not reproduction. */
function render(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value)
  return text.length <= 60 ? text : `${text.slice(0, 57)}...`
}

function firstLine(message: string): string {
  // The YAML parser appends an excerpt with a caret under the offending column.
  // Useful in a terminal, noise in a list where the line number is a field of
  // its own.
  return (message.split('\n')[0] ?? message).replace(/ at line \d+, column \d+:?$/, '')
}

function byPosition(a: ImportIssue, b: ImportIssue): number {
  return (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER)
}

function byteLength(source: string): number {
  return new TextEncoder().encode(source).length
}

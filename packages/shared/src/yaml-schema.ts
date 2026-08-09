import { stringify } from 'yaml'
import { z } from 'zod'
import { fileSchema } from './control-import.js'

/**
 * The import format, published as a schema somebody's tools can read.
 *
 * `docs/import.md` explains the format to a person and the commented skeleton
 * in the admin gets one started, but neither can be given to an editor or a CI
 * job. This can: it is JSON Schema, written as YAML, in the dialect specified by
 * the ASDF standard — `%YAML 1.1`, a `$schema` naming the metaschema, an `id`
 * naming itself, and JSON Schema **draft 4** underneath.
 *
 * ## Why it is generated
 *
 * From the same Zod object the endpoint validates with, so the published schema
 * cannot describe a format the server does not accept. A hand-written schema is
 * a second description of one thing, and the two stop agreeing the first time a
 * bound moves. This is the reason `probe.schema.json` is generated too.
 *
 * ## Why draft 4, when Zod emits 2020-12
 *
 * Because the dialect says draft 4, and a document that declared that
 * metaschema while using `const`, `prefixItems` and `$defs` would be a document
 * no draft-4 validator can read — worse than not publishing one, because it
 * fails somewhere inside a tool rather than here. The rewrite below is small
 * and total: every construct Zod emits that draft 4 spells differently, spelt
 * the draft 4 way.
 *
 * What is deliberately lost: the cross-field rules — `group` against `groupId`,
 * the degraded threshold against the down one, the probe config against the
 * kind. They live in refinements, which have no JSON Schema expression at all.
 * A file this schema accepts can still be refused, and the description says so
 * rather than leaving somebody to discover it.
 */

/** The metaschema this dialect is defined by. */
const YAML_SCHEMA = 'http://stsci.edu/schemas/yaml-schema/draft-01'

const ID = 'https://tern.dev/schemas/controls-import.yaml'

/** The order a control reads best in — the ASDF keyword for exactly this. */
const CONTROL_ORDER = [
  'key',
  'name',
  'description',
  'group',
  'groupId',
  'kind',
  'config',
  'expectedIntervalS',
  'degradedThresholdMs',
  'downThresholdMs',
  'valueUnit',
  'valueLabel',
  'slaTarget',
  'widget',
  'widgetOptions',
  'isPublic',
  'enabled',
  'position',
]

type Node = Record<string, unknown>

/** The import file's schema, as an ASDF YAML Schema document. */
export function controlsFileYamlSchema(): string {
  const generated = z.toJSONSchema(fileSchema, { io: 'input' }) as Node

  // The root `$schema` Zod writes names the dialect it emitted, which is the
  // one thing this document must not claim.
  delete generated.$schema

  const body: Node = {
    $schema: YAML_SCHEMA,
    id: ID,
    title: 'TERN controls import file',
    description:
      'A list of controls to create or update, keyed by `key`. Applied as a unit: either every ' +
      'control in the file lands or none does. A control the file does not name is left alone, ' +
      'and so is a field it leaves out.\n\n' +
      'Rules that span two fields cannot be expressed here and are enforced by the server: ' +
      '`group` and `groupId` are alternatives, `degradedThresholdMs` must be below ' +
      '`downThresholdMs`, and `config` is validated against the probe the `kind` names.',
    ...(toDraft4(generated) as Node),
  }

  // `%YAML 1.1` and the closing `...` are part of the dialect, not decoration:
  // the document is one YAML stream with an explicit start and end.
  return `%YAML 1.1\n---\n${stringify(body, { lineWidth: 88 })}...\n`
}

/**
 * Rewrites what Zod emits into the draft 4 spelling of the same thing.
 *
 * Depth-first and total: every node is visited, because these constructs nest —
 * a `const` inside a `oneOf` inside a `properties` is the common case, not the
 * exotic one.
 */
function toDraft4(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toDraft4)
  if (node === null || typeof node !== 'object') return node

  const out: Node = {}

  for (const [key, value] of Object.entries(node as Node)) {
    switch (key) {
      // Draft 4 has no `const`; a one-value `enum` is what it means.
      case 'const':
        out.enum = [value]
        break

      // Draft 4's `exclusiveMinimum` is a boolean qualifying `minimum`, not a
      // bound of its own. Same for the maximum.
      case 'exclusiveMinimum':
        out.minimum = value
        out.exclusiveMinimum = true
        break
      case 'exclusiveMaximum':
        out.maximum = value
        out.exclusiveMaximum = true
        break

      // A tuple is `items: [...]` in draft 4, where 2020-12 splits it out.
      case 'prefixItems':
        out.items = toDraft4(value)
        break

      // `$defs` is the 2020-12 name for what draft 4 calls `definitions`.
      case '$defs':
        out.definitions = toDraft4(value)
        break

      // No draft 4 equivalent. It only ever says "the keys are strings", which
      // is true of every YAML mapping key this format accepts anyway.
      case 'propertyNames':
        break

      default:
        out[key] = typeof value === 'string' ? value : toDraft4(value)
    }
  }

  // Refs written against `$defs` have to follow it to its new name.
  if (typeof out.$ref === 'string') out.$ref = out.$ref.replace('#/$defs/', '#/definitions/')

  // A control is the one node with an order worth stating.
  if (isControl(out)) out.propertyOrder = CONTROL_ORDER

  return out
}

function isControl(node: Node): boolean {
  const properties = node.properties
  return (
    typeof properties === 'object' &&
    properties !== null &&
    'key' in properties &&
    'widgetOptions' in properties
  )
}

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { controlsFileYamlSchema } from './yaml-schema.js'

/**
 * The published schema, checked against the dialect it claims.
 *
 * A schema is read by machines that will not tell us they could not read it —
 * an editor stops offering completions, a CI job passes everything. So the
 * things worth pinning are the ones that fail silently: a `$schema` naming
 * draft 4 over a body written in 2020-12, and a field the schema forgot because
 * it was added to the Zod object and nowhere else.
 */

/** Only the parts asserted below — the document is data here, not a contract. */
interface SchemaDocument {
  $schema: string
  id: string
  $id?: string
  type: string
  description: string
  required: string[]
  additionalProperties: boolean
  properties: {
    controls: {
      maxItems: number
      items: {
        required: string[]
        additionalProperties: boolean
        propertyOrder: string[]
        properties: Record<string, { pattern?: string; maxLength?: number }>
      }
    }
  }
}

const document = controlsFileYamlSchema()
const schema = parse(document) as SchemaDocument

describe('the document', () => {
  it('is a YAML 1.1 stream with an explicit start and end', () => {
    expect(document.startsWith('%YAML 1.1\n---\n')).toBe(true)
    expect(document.endsWith('...\n')).toBe(true)
  })

  it('names the metaschema it is written in, and itself', () => {
    expect(schema.$schema).toBe('http://stsci.edu/schemas/yaml-schema/draft-01')
    // `id`, not `$id`: draft 4 spells it without the dollar.
    expect(schema.id).toBe('https://tern.dev/schemas/controls-import.yaml')
    expect(schema.$id).toBeUndefined()
  })

  it('parses back to what it says it is', () => {
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['controls'])
    expect(schema.additionalProperties).toBe(false)
  })
})

describe('nothing draft 4 cannot read', () => {
  /** Every node, so a construct nested three deep is not missed. */
  function* nodes(node: unknown): Generator<Record<string, unknown>> {
    if (Array.isArray(node)) {
      for (const item of node) yield* nodes(item)
      return
    }
    if (node === null || typeof node !== 'object') return
    yield node as Record<string, unknown>
    for (const value of Object.values(node)) yield* nodes(value)
  }

  const all = [...nodes(schema)]

  it('uses none of the keywords 2020-12 introduced', () => {
    for (const keyword of ['const', 'prefixItems', '$defs', 'propertyNames', '$anchor']) {
      expect(all.some((node) => keyword in node)).toBe(false)
    }
  })

  it('writes an exclusive bound the draft 4 way', () => {
    // Draft 4 spells it as a boolean qualifying `minimum`; 2020-12 spells it as
    // a bound of its own. A validator reading the second as the first sees
    // `minimum: true` and either throws or, worse, ignores it.
    const exclusive = all.filter((node) => 'exclusiveMinimum' in node)
    expect(exclusive.length).toBeGreaterThan(0)
    for (const node of exclusive) {
      expect(node.exclusiveMinimum).toBe(true)
      expect(typeof node.minimum).toBe('number')
    }
  })

  it('has a ref-free body, or refs that point at definitions', () => {
    for (const node of all) {
      if (typeof node.$ref === 'string') expect(node.$ref).not.toContain('$defs')
    }
  })
})

describe('the control it describes', () => {
  const control = schema.properties.controls.items

  it('requires the two fields that identify one, and nothing else', () => {
    expect(control.required).toEqual(['key', 'name'])
  })

  it('lists every field the format accepts', () => {
    // The drift this catches: a field added to `controlFields` in
    // control-import.ts and not reachable through anything published.
    expect(Object.keys(control.properties).sort()).toEqual(
      [
        'config',
        'degradedThresholdMs',
        'description',
        'downThresholdMs',
        'enabled',
        'expectedIntervalS',
        'group',
        'groupId',
        'isPublic',
        'key',
        'kind',
        'name',
        'position',
        'slaTarget',
        'valueLabel',
        'valueUnit',
        'widget',
        'widgetOptions',
      ].sort(),
    )
  })

  it('states the order it reads best in, which is what the dialect adds', () => {
    expect(control.propertyOrder[0]).toBe('key')
    expect([...control.propertyOrder].sort()).toEqual(Object.keys(control.properties).sort())
  })

  it('refuses a field it does not name', () => {
    // The whole reason the format is strict: a `timeout_ms` silently dropped is
    // a probe that keeps its old timeout for ever.
    expect(control.additionalProperties).toBe(false)
  })

  it('carries the bounds, not just the types', () => {
    expect(control.properties.key!.pattern).toBe('^[a-z0-9][a-z0-9._-]*$')
    expect(control.properties.name!.maxLength).toBe(200)
    expect(schema.properties.controls.maxItems).toBe(500)
  })

  it('says out loud what it cannot check', () => {
    // Three rules live in refinements and have no JSON Schema expression. A
    // reader who trusts this document to be the whole contract will write a
    // file it accepts and the server refuses.
    expect(schema.description).toContain('enforced by the server')
    expect(schema.description).toContain('downThresholdMs')
  })
})

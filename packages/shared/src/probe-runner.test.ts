import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertionSchema } from './probe.js'
import { evaluateAssertions, queryJsonPath, searchJson } from './probe-runner.js'
import type { ProbeObservation } from './probe-runner.js'

const conformanceDir = join(dirname(fileURLToPath(import.meta.url)), '../../../schemas/conformance')

interface Fixture {
  name: string
  why: string
  assertions: unknown[]
  observation: ProbeObservation
  expect: { status: string; value: number | null; failing: string[] }
}

/**
 * The shared contract with the Rust agent. Adding a case here is how a decision
 * — or a bug fix — reaches the other implementation.
 */
describe('probe conformance fixtures', () => {
  const files = readdirSync(conformanceDir).filter((f) => f.endsWith('.json'))

  it('finds the fixture directory', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(conformanceDir, file), 'utf8')) as Fixture

    it(`${file}: ${fixture.name}`, () => {
      // Parsing through the schema first proves the fixtures are valid probe
      // specifications, not just objects that happen to satisfy the engine.
      const assertions = fixture.assertions.map((a) => assertionSchema.parse(a))
      const result = evaluateAssertions(assertions, fixture.observation)

      expect(result.status).toBe(fixture.expect.status)
      expect(result.value).toBe(fixture.expect.value)
      expect(result.assertions.filter((a) => !a.passed).map((a) => a.type)).toEqual(
        fixture.expect.failing,
      )
    })
  }
})

describe('failure messages', () => {
  it('cites the failing assertion with the actual value', () => {
    // "check failed" is useless at 3am. The message has to say what was
    // expected and what was found.
    const result = evaluateAssertions(
      [assertionSchema.parse({ type: 'status_code', severity: 'down', eq: 200 })],
      { statusCode: 503 },
    )
    expect(result.message).toContain('503')
    expect(result.message).toContain('200')
  })
})

describe('queryJsonPath', () => {
  const doc = {
    data: { items: [{ id: 'a' }, { id: 'b' }] },
    'with space': { nested: 42 },
  }

  it('walks dotted paths and array indexes', () => {
    expect(queryJsonPath(doc, '$.data.items[1].id')).toBe('b')
  })

  it('supports negative indexes', () => {
    expect(queryJsonPath(doc, '$.data.items[-1].id')).toBe('b')
  })

  it('supports bracketed keys containing spaces', () => {
    expect(queryJsonPath(doc, "$['with space'].nested")).toBe(42)
  })

  it('returns undefined for a missing path rather than throwing', () => {
    expect(queryJsonPath(doc, '$.data.missing.deeper')).toBeUndefined()
  })
})

describe('searchJson', () => {
  it('collects values under a key at any depth', () => {
    const doc = { a: { state: 'up' }, b: [{ state: 'down' }] }
    expect(searchJson(doc, 'state')).toEqual(['up', 'down'])
  })

  it('collects every leaf when no key is given', () => {
    expect(searchJson({ a: 1, b: { c: 2 } })).toEqual([1, 2])
  })
})

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type z } from 'zod'
import {
  commandResultRequestSchema,
  heartbeatRequestSchema,
  heartbeatResponseSchema,
  ingestPointSchema,
  ingestResponseSchema,
  jobsResponseSchema,
  pairRequestSchema,
  pairResponseSchema,
  problemSchema,
  zoneDeclarationSchema,
  zoneRedeemRequestSchema,
  zoneRedeemResponseSchema,
} from './agent-protocol.js'

/**
 * The TypeScript half of the conformance contract.
 *
 * Every fixture in `schemas/conformance/protocol/` must parse against the Zod
 * schema it names; the Rust suite (`clients/agent/tests/protocol_conformance.rs`)
 * reads the same files against the serde structs. Neither implementation
 * imports the other — these fixtures are the bridge, and this test is what
 * keeps the bridge honest from this side.
 */

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../schemas/conformance/protocol',
)

const schemas: Record<string, z.ZodType> = {
  pairRequest: pairRequestSchema,
  pairResponse: pairResponseSchema,
  jobsResponse: jobsResponseSchema,
  heartbeatRequest: heartbeatRequestSchema,
  heartbeatResponse: heartbeatResponseSchema,
  commandResultRequest: commandResultRequestSchema,
  zoneDeclaration: zoneDeclarationSchema,
  zoneRedeem: zoneRedeemRequestSchema,
  ingestPoint: ingestPointSchema,
  ingestResponse: ingestResponseSchema,
  problem: problemSchema,
}

/** The odd one out: request and response live in one small file. */
const responseSchemas: Record<string, z.ZodType> = {
  zoneRedeem: zoneRedeemResponseSchema,
}

type Fixture = {
  message: string
  examples: unknown[]
  responseExamples?: unknown[]
  /**
   * Shapes the server tolerates from hand-written clients but the agent never
   * emits — validated here, deliberately ignored by the Rust round-trip.
   */
  serverAcceptsExamples?: unknown[]
}

const files = readdirSync(fixturesDir).filter((name) => name.endsWith('.json'))

describe('protocol conformance fixtures', () => {
  // A fixture whose message names no schema is a typo, and a schema with no
  // fixture is a message the Rust side is not being held to.
  it('covers every schema and names no unknown one', () => {
    const named = files.map(
      (file) => (JSON.parse(readFileSync(join(fixturesDir, file), 'utf8')) as Fixture).message,
    )
    expect(named.toSorted()).toEqual(Object.keys(schemas).toSorted())
  })

  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8')) as Fixture

    it(`${file}: every example parses`, () => {
      const schema = schemas[fixture.message]
      expect(schema, `unknown message ${fixture.message}`).toBeDefined()

      for (const example of [...fixture.examples, ...(fixture.serverAcceptsExamples ?? [])]) {
        const parsed = schema!.safeParse(example)
        expect(
          parsed.success,
          `${file} example ${JSON.stringify(example)}: ${parsed.error?.message}`,
        ).toBe(true)
      }

      for (const example of fixture.responseExamples ?? []) {
        const schema = responseSchemas[fixture.message]
        expect(schema, `no response schema for ${fixture.message}`).toBeDefined()
        expect(schema!.safeParse(example).success).toBe(true)
      }
    })
  }
})

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { probeResultSchema, probeSchema } from './probe.js'
import { controlsFileYamlSchema } from './yaml-schema.js'

/**
 * Exports the probe contract as JSON Schema for the Rust agent.
 *
 * The Zod schema stays the single source of truth — this file is generated, and
 * CI fails if it is stale. Hand-maintaining a second copy of the contract in
 * another language is how the two implementations quietly stop agreeing.
 */

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../../../schemas')

const documents = [
  { file: 'probe.schema.json', schema: probeSchema, id: 'https://tern.dev/schemas/probe.json' },
  {
    file: 'probe-result.schema.json',
    schema: probeResultSchema,
    id: 'https://tern.dev/schemas/probe-result.json',
  },
] as const

mkdirSync(outDir, { recursive: true })

for (const doc of documents) {
  const json = z.toJSONSchema(doc.schema, { io: 'input' })
  const body = JSON.stringify({ $id: doc.id, ...json }, null, 2) + '\n'
  writeFileSync(join(outDir, doc.file), body)
  console.warn(`✓ ${doc.file}`)
}

/*
 * The import format, for people rather than for the agent — and so as YAML,
 * in the dialect the admin's "Copy the schema" button hands out. Written here
 * too so that the repository carries the published document and CI notices when
 * a schema change leaves it behind, exactly as for the two above.
 */
const yamlSchema = 'controls-import.schema.yaml'
writeFileSync(join(outDir, yamlSchema), controlsFileYamlSchema())
console.warn(`✓ ${yamlSchema}`)

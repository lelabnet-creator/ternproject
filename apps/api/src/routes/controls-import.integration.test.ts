import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schema } from '@tern/db'
import { MAX_IMPORT_BYTES } from '@tern/shared/control-import'
import { createFixture, login, type TestFixture } from '../test/harness.js'

let fx: TestFixture
let adminCookie: string

beforeAll(async () => {
  fx = await createFixture()
  adminCookie = await login(fx.app, fx.users.admin.email)
}, 30_000)

afterAll(async () => {
  await fx.cleanup()
})

const importFile = (yaml: string, dryRun = false) =>
  fx.app.inject({
    method: 'POST',
    url: `/api/v1/${fx.slug}/controls/import`,
    headers: { cookie: adminCookie },
    payload: { yaml, dryRun },
  })

const load = async (key: string) => {
  const [row] = await fx.app.db
    .select()
    .from(schema.controls)
    .where(and(eq(schema.controls.tenantId, fx.tenantId), eq(schema.controls.key, key)))
    .limit(1)
  return row
}

/** Unique per test, so suites and reruns never collide on the tenant's key index. */
let counter = 0
const uniqueKey = () => `imp-${Date.now()}-${counter++}`

describe('permission', () => {
  it('refuses a user who may communicate but not reconfigure', async () => {
    const memberCookie = await login(fx.app, fx.users.member.email)
    const response = await fx.app.inject({
      method: 'POST',
      url: `/api/v1/${fx.slug}/controls/import`,
      headers: { cookie: memberCookie },
      payload: { yaml: 'controls:\n  - key: nope\n    name: Nope\n' },
    })
    expect(response.statusCode).toBe(403)
  })
})

describe('importing a file', () => {
  it('creates what is not there and reports what it did', async () => {
    const key = uniqueKey()
    const response = await importFile(`version: 1
controls:
  - key: ${key}
    name: Website
    kind: http
    expectedIntervalS: 60
    config:
      url: https://example.com/health
      assertions:
        - type: status_code
          range: [200, 299]
`)

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      dryRun: false,
      created: 1,
      updated: 0,
      controls: [{ key, action: 'created' }],
    })

    const control = await load(key)
    expect(control?.kind).toBe('http')
    expect(control?.expectedIntervalS).toBe(60)
    expect(control?.config).toMatchObject({ url: 'https://example.com/health' })
  })

  it('is idempotent by key: the same file twice is one control, then an update', async () => {
    const key = uniqueKey()
    const file = `controls:
  - key: ${key}
    name: Payments
`
    expect((await importFile(file)).json()).toMatchObject({ created: 1, updated: 0 })

    const second = await importFile(file)
    expect(second.json()).toMatchObject({ created: 0, updated: 1 })

    const rows = await fx.app.db
      .select()
      .from(schema.controls)
      .where(and(eq(schema.controls.tenantId, fx.tenantId), eq(schema.controls.key, key)))
    expect(rows).toHaveLength(1)
  })

  it('leaves a field the file does not mention alone', async () => {
    // The reason the import schema has no defaults: a file that only ever set
    // names must not re-publish a control somebody deliberately made private.
    const key = uniqueKey()
    await importFile(`controls:
  - key: ${key}
    name: Internal job
    isPublic: false
    enabled: false
`)

    await importFile(`controls:
  - key: ${key}
    name: Internal job, renamed
`)

    const control = await load(key)
    expect(control?.name).toBe('Internal job, renamed')
    expect(control?.isPublic).toBe(false)
    expect(control?.enabled).toBe(false)
  })

  it('writes nothing on a dry run, and says what it would have done', async () => {
    const key = uniqueKey()
    const response = await importFile(
      `controls:\n  - key: ${key}\n    name: Preview\n    group: Imported preview\n`,
      true,
    )

    expect(response.json()).toMatchObject({ dryRun: true, created: 1, groupsCreated: 1 })
    expect(await load(key)).toBeUndefined()

    const groups = await fx.app.db
      .select()
      .from(schema.controlGroups)
      .where(
        and(
          eq(schema.controlGroups.tenantId, fx.tenantId),
          eq(schema.controlGroups.name, 'Imported preview'),
        ),
      )
    expect(groups).toHaveLength(0)
  })
})

describe('groups', () => {
  it('creates a group named in the file, then reuses it', async () => {
    const name = `Platform ${Date.now()}`
    const first = await importFile(
      `controls:\n  - key: ${uniqueKey()}\n    name: One\n    group: ${name}\n`,
    )
    expect(first.json()).toMatchObject({ groupsCreated: 1 })

    const second = await importFile(
      `controls:\n  - key: ${uniqueKey()}\n    name: Two\n    group: ${name}\n`,
    )
    expect(second.json()).toMatchObject({ groupsCreated: 0 })

    const groups = await fx.app.db
      .select()
      .from(schema.controlGroups)
      .where(
        and(eq(schema.controlGroups.tenantId, fx.tenantId), eq(schema.controlGroups.name, name)),
      )
    expect(groups).toHaveLength(1)
  })

  it('refuses a group id that belongs to nobody here', async () => {
    const response = await importFile(`controls:
  - key: ${uniqueKey()}
    name: Orphan
    groupId: 0b7a3a2e-2c1a-4f0e-9a3f-1b2c3d4e5f60
`)
    expect(response.statusCode).toBe(404)
    expect(response.json().detail).toMatch(/no group with id/i)
  })
})

describe('all or nothing', () => {
  it('imports none of the file when one control is rejected by the schema', async () => {
    const good = uniqueKey()
    const response = await importFile(`controls:
  - key: ${good}
    name: Fine
  - key: ${uniqueKey()}
    name: Broken
    kind: htp
    config:
      url: https://example.com
`)

    expect(response.statusCode).toBe(400)
    expect(await load(good)).toBeUndefined()
  })

  it('rolls back a control already written when a later one fails', async () => {
    // The schema cannot catch this one: the group id is well formed and only
    // the database knows it belongs to nobody. It is the case that proves the
    // transaction, rather than the parser, is what makes the import atomic.
    const good = uniqueKey()
    const response = await importFile(`controls:
  - key: ${good}
    name: Written first
  - key: ${uniqueKey()}
    name: Fails second
    groupId: 0b7a3a2e-2c1a-4f0e-9a3f-1b2c3d4e5f60
`)

    expect(response.statusCode).toBe(404)
    expect(await load(good)).toBeUndefined()
  })
})

describe('a file that will not do', () => {
  it('answers with every problem, located', async () => {
    const response = await importFile(`controls:
  - key: ${uniqueKey()}
    name: Website
    intervalSeconds: 60
  - key: ${uniqueKey()}
    name: Database
    kind: tcp
    config:
      host: db.internal
`)

    expect(response.statusCode).toBe(400)
    const body = response.json()
    expect(body.message).toMatch(/nothing was imported/i)
    expect(body.issues).toHaveLength(2)
    expect(body.issues[0]).toMatchObject({ line: 4, path: 'controls[0].intervalSeconds' })
    expect(body.issues[0].expected).toContain('expectedIntervalS')
    expect(body.issues[1]).toMatchObject({ path: 'controls[1].config.port' })
    expect(body.issues[1].detail).toContain('line 9')
  })

  it('refuses a file too large to be a list of controls', async () => {
    const response = await importFile(`# ${'x'.repeat(MAX_IMPORT_BYTES)}\ncontrols: []\n`)
    expect(response.statusCode).toBe(413)
    expect(response.json().detail).toMatch(/larger than 256 KB/)
  })

  it('says an empty file is empty', async () => {
    const response = await importFile('\n')
    expect(response.statusCode).toBe(400)
    expect(response.json().issues[0].message).toMatch(/empty/i)
  })
})

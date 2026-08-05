import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { schema } from '@tern/db'
import { hashPassword } from '@tern/shared'
import { buildApp } from '../app.js'

/**
 * Integration-test harness.
 *
 * Runs against the real database rather than a mock: the behaviour under test
 * here is authorisation and session handling, and both are enforced partly by
 * SQL. A stubbed store would prove only that the stub agrees with itself.
 *
 * Each suite works in its own tenant with a unique slug, so suites can run in
 * any order and clean up after themselves without a shared reset step.
 */

export const TEST_PASSWORD = 'integration-test-password'

export interface TestFixture {
  app: FastifyInstance
  tenantId: string
  slug: string
  users: Record<'admin' | 'member' | 'visitor' | 'outsider', { id: string; email: string }>
  controls: { publicId: string; privateId: string }
  cleanup(): Promise<void>
}

let counter = 0

export async function createFixture(
  options: { visibility?: 'public' | 'private' } = {},
): Promise<TestFixture> {
  const app = await buildApp()
  await app.ready()

  const slug = `test-${process.pid}-${counter++}`
  const passwordHash = await hashPassword(TEST_PASSWORD)

  const [tenant] = await app.db
    .insert(schema.tenants)
    .values({
      slug,
      name: `Test ${slug}`,
      visibility: options.visibility ?? 'public',
    })
    .returning()
  if (!tenant) throw new Error('failed to create test tenant')

  const makeUser = async (role: string) => {
    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: `${role}-${slug}@test.local`,
        name: `${role} user`,
        passwordHash,
      })
      .returning()
    if (!user) throw new Error(`failed to create ${role}`)
    return user
  }

  const admin = await makeUser('admin')
  const member = await makeUser('member')
  const visitor = await makeUser('visitor')
  const outsider = await makeUser('outsider')

  await app.db.insert(schema.memberships).values([
    { userId: admin.id, tenantId: tenant.id, role: 'admin' },
    { userId: member.id, tenantId: tenant.id, role: 'user' },
    { userId: visitor.id, tenantId: tenant.id, role: 'visitor' },
    // `outsider` deliberately has no membership.
  ])

  const [publicControl] = await app.db
    .insert(schema.controls)
    .values({ tenantId: tenant.id, key: 'public-api', name: 'Public API', isPublic: true })
    .returning()
  const [privateControl] = await app.db
    .insert(schema.controls)
    .values({ tenantId: tenant.id, key: 'internal-job', name: 'Internal job', isPublic: false })
    .returning()
  if (!publicControl || !privateControl) throw new Error('failed to create controls')

  return {
    app,
    tenantId: tenant.id,
    slug,
    users: { admin, member, visitor, outsider },
    controls: { publicId: publicControl.id, privateId: privateControl.id },
    async cleanup() {
      // Tenant cascades take the controls and memberships; users are global and
      // have to go separately.
      await app.db.delete(schema.tenants).where(eq(schema.tenants.id, tenant.id))
      for (const user of [admin, member, visitor, outsider]) {
        await app.db.delete(schema.users).where(eq(schema.users.id, user.id))
      }
      await app.close()
    },
  }
}

/** Logs in and returns the session cookie header, or throws with the response body. */
export async function login(
  app: FastifyInstance,
  email: string,
  password = TEST_PASSWORD,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  })
  if (response.statusCode !== 200) {
    throw new Error(`login failed (${response.statusCode}): ${response.body}`)
  }
  const cookie = response.cookies.find((c) => c.name === 'tern_session')
  if (!cookie) throw new Error('no session cookie issued')
  return `tern_session=${cookie.value}`
}

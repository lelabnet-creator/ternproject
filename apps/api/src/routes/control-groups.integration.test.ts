import type { LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFixture, login, type TestFixture } from '../test/harness.js'
import { __testables } from './control-groups.js'

const { wouldCycle, depthOf, MAX_DEPTH } = __testables

/**
 * Folders, and the two ways a tree of parent pointers goes wrong.
 *
 * The table, the `groupId` on every control and the public page's group
 * headings all predate this route by a long way — what was missing was any way
 * to create a folder, so the whole read path drew a feature nobody could reach.
 *
 * What is pinned here is not the CRUD, which is unremarkable. It is the two
 * failures that cannot be undone through the interface that caused them: a
 * group made its own ancestor vanishes from every listing that walks down from
 * the roots, and a delete that cascaded would take a subtree of controls off
 * the page as a side effect of tidying it.
 */

let fx: TestFixture

beforeAll(async () => {
  fx = await createFixture()
}, 30_000)

afterAll(async () => {
  await fx.cleanup()
})

const api = async (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> => {
  const cookie = await login(fx.app, fx.users.admin.email)
  // Awaited here rather than returned: `inject` hands back a chainable object as
  // well as a promise, and a caller that only awaits the outer layer gets a type
  // with no `.json()` on it.
  return await fx.app.inject({
    method,
    url: `/api/v1/${fx.slug}${path}`,
    headers: { cookie },
    payload,
  })
}

const makeGroup = async (name: string, parentId?: string) => {
  const response = await api('POST', '/control-groups', { name, parentId: parentId ?? null })
  expect(response.statusCode, response.body).toBe(201)
  return response.json() as { id: string; name: string; parentId: string | null }
}

describe('the cycle guard, on its own', () => {
  // Unit-level because the interesting inputs are shapes the API will not let
  // you build — including a table that already holds a cycle, which is exactly
  // when this must not hang.
  const rows = [
    { id: 'a', parentId: null },
    { id: 'b', parentId: 'a' },
    { id: 'c', parentId: 'b' },
  ]

  it('catches a group made its own descendant', () => {
    expect(wouldCycle(rows, 'a', 'c')).toBe(true)
    expect(wouldCycle(rows, 'a', 'b')).toBe(true)
    expect(wouldCycle(rows, 'b', 'c')).toBe(true)
  })

  it('allows the moves that are fine', () => {
    expect(wouldCycle(rows, 'c', null)).toBe(false)
    expect(wouldCycle(rows, 'c', 'a')).toBe(false)
  })

  it('terminates on a table that is already broken', () => {
    // Not hypothetical: a cycle written by an older version, or by hand, is
    // precisely the state somebody would open the interface to repair.
    const looped = [
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' },
    ]
    expect(wouldCycle(looped, 'x', 'y')).toBe(true)
  })

  it('measures depth from the root', () => {
    expect(depthOf(rows, null)).toBe(0)
    expect(depthOf(rows, 'a')).toBe(1)
    expect(depthOf(rows, 'c')).toBe(3)
  })
})

describe('folders through the API', () => {
  it('creates, nests and lists them', async () => {
    const europe = await makeGroup('Europe')
    const paris = await makeGroup('Paris', europe.id)

    expect(paris.parentId).toBe(europe.id)

    const list = await api('GET', '/control-groups')
    expect(list.statusCode).toBe(200)

    const names = (list.json() as { name: string }[]).map((g) => g.name)
    expect(names).toContain('Europe')
    expect(names).toContain('Paris')
  })

  it('refuses a move that would put a group inside itself', async () => {
    const outer = await makeGroup('Outer')
    const inner = await makeGroup('Inner', outer.id)

    const response = await api('PATCH', `/control-groups/${outer.id}`, { parentId: inner.id })

    expect(response.statusCode).toBe(400)
    expect(response.json().message).toMatch(/inside itself/i)
  })

  it('refuses to be its own parent', async () => {
    const group = await makeGroup('Solo')
    const response = await api('PATCH', `/control-groups/${group.id}`, { parentId: group.id })
    expect(response.statusCode).toBe(400)
  })

  it(`stops nesting at ${MAX_DEPTH} deep`, async () => {
    let parentId: string | undefined
    for (let level = 0; level < MAX_DEPTH; level += 1) {
      parentId = (await makeGroup(`Level ${level}`, parentId)).id
    }

    const tooDeep = await api('POST', '/control-groups', { name: 'One too many', parentId })
    expect(tooDeep.statusCode).toBe(400)
  })

  it('refuses a parent belonging to somebody else', async () => {
    // A uuid that is well-formed and not this tenant's. Reported as unknown
    // rather than forbidden — telling a caller that an id exists elsewhere is
    // itself an answer they did not earn.
    const response = await api('POST', '/control-groups', {
      name: 'Borrowed',
      parentId: '00000000-0000-4000-8000-000000000000',
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().message).toMatch(/unknown parent/i)
  })
})

describe('deleting a folder', () => {
  it('keeps the controls that were in it', async () => {
    const group = await makeGroup('Doomed')

    const moved = await api('POST', '/controls/move', {
      controlIds: [fx.controls.publicId],
      groupId: group.id,
    })
    expect(moved.statusCode).toBe(200)
    expect(moved.json().moved).toBe(1)

    const gone = await api('DELETE', `/control-groups/${group.id}`)
    expect(gone.statusCode).toBe(204)

    // The control survives, unfiled. Deleting a folder is a filing decision,
    // not a decision about what is monitored — an operator tidying their page
    // must not find out the next morning that they stopped watching a service.
    const controls = await api('GET', '/controls')
    const survivor = (controls.json() as { id: string; groupId: string | null }[]).find(
      (c) => c.id === fx.controls.publicId,
    )

    expect(survivor).toBeDefined()
    expect(survivor!.groupId).toBeNull()
  })

  it('lifts the children rather than taking them along', async () => {
    const top = await makeGroup('Top')
    const middle = await makeGroup('Middle', top.id)
    const leaf = await makeGroup('Leaf', middle.id)

    expect((await api('DELETE', `/control-groups/${middle.id}`)).statusCode).toBe(204)

    const list = (await api('GET', '/control-groups')).json() as {
      id: string
      parentId: string | null
    }[]

    const stillThere = list.find((g) => g.id === leaf.id)
    // `parentId` cascades on delete in the schema, so without the lift this row
    // would be gone — and its controls with it, silently.
    expect(stillThere, 'the child group must outlive its parent').toBeDefined()
    expect(stillThere!.parentId).toBe(top.id)
  })
})

describe('moving controls in bulk', () => {
  it('files a selection in one call, and refuses an unknown destination', async () => {
    const group = await makeGroup('Destination')

    const ok = await api('POST', '/controls/move', {
      controlIds: [fx.controls.publicId, fx.controls.privateId],
      groupId: group.id,
    })
    expect(ok.json().moved).toBe(2)

    const bad = await api('POST', '/controls/move', {
      controlIds: [fx.controls.publicId],
      groupId: '00000000-0000-4000-8000-000000000000',
    })
    expect(bad.statusCode).toBe(400)

    // Put back, so the files that run after this one see what they expect.
    await api('POST', '/controls/move', {
      controlIds: [fx.controls.publicId, fx.controls.privateId],
      groupId: null,
    })
  })
})

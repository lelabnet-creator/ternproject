import { beforeEach, describe, expect, it } from 'vitest'
import { SANDBOX_ENABLED_KEY } from './sandbox-flag'

/**
 * The router, and the overlay it writes into.
 *
 * Two things here are easy to get wrong and impossible to notice by looking.
 * The first is the path table: `controls/move` and `controls/:id` are the same
 * shape, so a router that counted segments would file a selection under a
 * control whose id happened to be the word "move". The second is that a write
 * has to survive the read that follows it — the screens all invalidate and
 * refetch, so an overlay that applied on write but not on read would look like
 * a save that silently did nothing.
 */

/** The tests run in node, which has no storage. This is the whole of what is used. */
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string) {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.map.set(key, value)
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
  clear() {
    this.map.clear()
  }
}

const storage = new MemoryStorage()
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

const { answer, PASS, parse, readOverlay, resetSandbox, sandboxSize } = await import('./sandbox')

/** A demo estate the sandbox lays its changes over. */
const REAL_CONTROLS = [
  { id: 'c1', key: 'api', name: 'API', groupId: null },
  { id: 'c2', key: 'db', name: 'Database', groupId: null },
]

const fetchReal = (path: string): Promise<unknown> => {
  if (path.endsWith('/controls')) return Promise.resolve(structuredClone(REAL_CONTROLS))
  if (path.endsWith('/control-groups')) return Promise.resolve([])
  return Promise.resolve([])
}

const get = (path: string) => answer('GET', path, undefined, fetchReal)
const post = (path: string, body: unknown) => answer('POST', path, body, fetchReal)

beforeEach(() => {
  storage.clear()
  storage.setItem(SANDBOX_ENABLED_KEY, '1')
})

describe('parse', () => {
  it('tells a verb from an id at the same depth', () => {
    expect(parse('/api/v1/acme/controls/move')).toMatchObject({
      collection: 'controls',
      id: null,
      action: 'move',
    })
    expect(parse('/api/v1/acme/controls/c1')).toMatchObject({ collection: 'controls', id: 'c1' })
  })

  it('keeps a two-segment collection together', () => {
    expect(parse('/api/v1/acme/notifications/webhooks/w1')).toMatchObject({
      collection: 'notifications/webhooks',
      id: 'w1',
    })
  })

  it('reads a verb that follows a row', () => {
    expect(parse('/api/v1/acme/incidents/i1/updates')).toMatchObject({
      collection: 'incidents',
      id: 'i1',
      action: 'updates',
    })
  })

  it('drops a query string before deciding anything', () => {
    expect(parse('/api/v1/acme/incidents?limit=50')).toMatchObject({
      collection: 'incidents',
      id: null,
    })
  })

  it('has nothing to say about a path that is not one of ours', () => {
    expect(parse('/health')).toBeNull()
  })
})

describe('what is never answered here', () => {
  it('lets every authentication call go out', async () => {
    expect(await post('/api/v1/auth/login', { email: 'a@b.c' })).toBe(PASS)
    expect(await post('/api/v1/auth/logout', {})).toBe(PASS)
  })

  it('lets an instance upgrade go out', async () => {
    // Simulating a pulled image would be a button claiming to have done
    // something to the host.
    expect(await post('/api/v1/system/release/update', {})).toBe(PASS)
  })
})

describe('a control created here', () => {
  it('comes back on the next read, after the real ones', async () => {
    const created = (await post('/api/v1/acme/controls', {
      key: 'cache',
      name: 'Cache',
    })) as { id: string; key: string }
    expect(created.key).toBe('cache')

    const list = (await get('/api/v1/acme/controls')) as { key: string }[]
    expect(list.map((row) => row.key)).toEqual(['api', 'db', 'cache'])
  })

  it('is filled out enough for the screens that read it', async () => {
    await post('/api/v1/acme/controls', { key: 'cache', name: 'Cache' })
    const list = (await get('/api/v1/acme/controls')) as Record<string, unknown>[]
    const row = list.at(-1)!
    // A row made a second ago has never reported, and says so rather than
    // leaving the field undefined for a card to render as "undefined".
    expect(row.lastCheckAt).toBeNull()
    expect(row.enabled).toBe(true)
    expect(row.widgetOptions).toEqual({})
  })
})

describe('a real row changed here', () => {
  it('is patched on the way past, not replaced', async () => {
    await answer('PATCH', '/api/v1/acme/controls/c1', { name: 'Renamed' }, fetchReal)
    const list = (await get('/api/v1/acme/controls')) as Record<string, unknown>[]
    expect(list[0]).toMatchObject({ id: 'c1', key: 'api', name: 'Renamed' })
  })

  it('disappears when deleted, and stays gone', async () => {
    await answer('DELETE', '/api/v1/acme/controls/c2', undefined, fetchReal)
    const list = (await get('/api/v1/acme/controls')) as { id: string }[]
    expect(list.map((row) => row.id)).toEqual(['c1'])
  })

  it('leaves nothing behind when it was made here and then unmade', async () => {
    const made = (await post('/api/v1/acme/controls', { key: 'temp', name: 'Temp' })) as {
      id: string
    }
    await answer('DELETE', `/api/v1/acme/controls/${made.id}`, undefined, fetchReal)
    const list = (await get('/api/v1/acme/controls')) as { key: string }[]
    expect(list.map((row) => row.key)).toEqual(['api', 'db'])
  })
})

describe('a folder deleted here', () => {
  const inFolder = (path: string) =>
    path.endsWith('/controls')
      ? Promise.resolve([
          { id: 'c1', key: 'api', name: 'API', groupId: 'g1' },
          { id: 'c2', key: 'db', name: 'Database', groupId: null },
        ])
      : Promise.resolve([])

  it('keeps its controls unless asked otherwise', async () => {
    await answer('DELETE', '/api/v1/acme/control-groups/g1?controls=unfile', undefined, inFolder)
    const list = (await answer('GET', '/api/v1/acme/controls', undefined, inFolder)) as {
      id: string
    }[]
    expect(list.map((row) => row.id)).toEqual(['c1', 'c2'])
  })

  it('takes them when it is', async () => {
    // The sandbox has to behave as the server does here, or the confirmation
    // teaches the opposite of what the button will do.
    const outcome = await answer(
      'DELETE',
      '/api/v1/acme/control-groups/g1?controls=delete',
      undefined,
      inFolder,
    )
    expect(outcome).toEqual({ deleted: 1, unfiled: 0 })

    const list = (await answer('GET', '/api/v1/acme/controls', undefined, inFolder)) as {
      id: string
    }[]
    expect(list.map((row) => row.id)).toEqual(['c2'])
  })
})

describe('a selection filed here', () => {
  it('moves every control it names', async () => {
    const moved = (await post('/api/v1/acme/controls/move', {
      controlIds: ['c1', 'c2'],
      groupId: 'g9',
    })) as { moved: number }
    expect(moved.moved).toBe(2)

    const list = (await get('/api/v1/acme/controls')) as { groupId: string | null }[]
    expect(list.every((row) => row.groupId === 'g9')).toBe(true)
  })
})

describe('an import applied here', () => {
  const FILE = `controls:
  - key: api
    name: API renamed
  - key: web
    name: Web
    group: Imported
`

  it('reports what it would do, and does nothing, on a dry run', async () => {
    const outcome = (await post('/api/v1/acme/controls/import', { yaml: FILE, dryRun: true })) as {
      created: number
      updated: number
      groupsCreated: number
    }
    expect(outcome).toMatchObject({ created: 1, updated: 1, groupsCreated: 1 })
    expect(sandboxSize()).toBe(0)
  })

  it('upserts on key, and makes the folder the file named', async () => {
    await post('/api/v1/acme/controls/import', { yaml: FILE, dryRun: false })

    const list = (await get('/api/v1/acme/controls')) as { key: string; name: string }[]
    expect(list.find((row) => row.key === 'api')!.name).toBe('API renamed')
    expect(list.map((row) => row.key)).toContain('web')

    const folders = (await get('/api/v1/acme/control-groups')) as { name: string }[]
    expect(folders.map((row) => row.name)).toEqual(['Imported'])
  })

  it('changes nothing the second time, which is the property the endpoint promises', async () => {
    await post('/api/v1/acme/controls/import', { yaml: FILE, dryRun: false })
    const again = (await post('/api/v1/acme/controls/import', {
      yaml: FILE,
      dryRun: false,
    })) as { created: number; updated: number; groupsCreated: number }
    expect(again).toMatchObject({ created: 0, updated: 2, groupsCreated: 0 })

    const list = (await get('/api/v1/acme/controls')) as unknown[]
    expect(list).toHaveLength(3)
  })

  it('refuses a bad file the way the endpoint refuses it', async () => {
    // The screen reads the issue list off ApiError.body and must not need to
    // know which side said no.
    await expect(
      post('/api/v1/acme/controls/import', { yaml: 'controls:\n  - name: no key\n' }),
    ).rejects.toMatchObject({
      status: 400,
      body: {
        issues: expect.arrayContaining([expect.objectContaining({ line: expect.any(Number) })]),
      },
    })
  })
})

describe('discarding', () => {
  it('leaves the real demo behind', async () => {
    await post('/api/v1/acme/controls', { key: 'cache', name: 'Cache' })
    expect(sandboxSize()).toBe(1)

    resetSandbox()
    expect(sandboxSize()).toBe(0)
    expect(readOverlay().created).toEqual({})

    const list = (await get('/api/v1/acme/controls')) as { key: string }[]
    expect(list.map((row) => row.key)).toEqual(['api', 'db'])
  })
})

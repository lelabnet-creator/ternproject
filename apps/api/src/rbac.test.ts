import { describe, expect, it } from 'vitest'
import { PERMISSIONS, ROLES, can, permissionsFor } from './rbac.js'

describe('permission matrix', () => {
  it('gives admin every permission', () => {
    for (const permission of PERMISSIONS) {
      expect(can('admin', permission)).toBe(true)
    }
  })

  it('never lets a visitor write', () => {
    // The whole point of the visitor role, and of QR viewer sessions which map
    // onto it: read-only means read-only, including for anything that mutates
    // configuration or incident state.
    const writes = PERMISSIONS.filter(
      (p) => p.includes(':write') || p.includes(':manage') || p.endsWith(':settings'),
    )
    expect(writes.length).toBeGreaterThan(0)
    for (const permission of writes) {
      expect(can('visitor', permission)).toBe(false)
    }
  })

  it('hides internal controls from visitors', () => {
    expect(can('visitor', 'status:read')).toBe(true)
    expect(can('visitor', 'status:read:all')).toBe(false)
  })

  it('lets a user communicate but not reconfigure', () => {
    expect(can('user', 'incident:write')).toBe(true)
    expect(can('user', 'maintenance:write')).toBe(true)
    expect(can('user', 'control:write')).toBe(false)
    expect(can('user', 'tenant:settings')).toBe(false)
    expect(can('user', 'member:manage')).toBe(false)
  })

  it('grants anonymous callers strictly less than a visitor', () => {
    const anonymous = permissionsFor('anonymous')
    const visitor = permissionsFor('visitor')
    expect(anonymous.length).toBeLessThan(visitor.length)
    for (const permission of anonymous) {
      expect(visitor).toContain(permission)
    }
  })

  it('does not let an anonymous caller subscribe implicitly', () => {
    // Subscribing writes a row and needs its own rate limiting, so it is not
    // granted by simply being able to view a public page.
    expect(can('anonymous', 'subscribe')).toBe(false)
  })

  it('grants each role strictly more than the one below it', () => {
    const [admin, user, visitor] = ROLES.map((r) => permissionsFor(r).length)
    expect(admin).toBeGreaterThan(user!)
    expect(user).toBeGreaterThan(visitor!)
  })
})

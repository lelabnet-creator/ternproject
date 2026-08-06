import { describe, expect, it } from 'vitest'
import { matching } from './AdminApp'
import type { Control } from '../../lib/adminApi'

const control = (over: Partial<Control>): Control =>
  ({
    id: over.key ?? 'id',
    key: 'k',
    name: 'Name',
    description: null,
    groupId: null,
    kind: 'push',
    isPublic: true,
    enabled: true,
    expectedIntervalS: null,
    degradedThresholdMs: null,
    downThresholdMs: null,
    valueUnit: null,
    valueLabel: null,
    slaTarget: null,
    widget: 'uptime-ribbon',
    widgetOptions: {},
    position: 0,
    ...over,
  }) as Control

const CONTROLS = [
  control({ key: 'db-eu-west', name: 'Base de données (Paris)', description: 'Cluster primaire' }),
  control({ key: 'api-gateway', name: 'API gateway', description: 'Public REST entry point' }),
  control({ key: 'cdn', name: 'CDN', description: null }),
]

describe('finding a control', () => {
  it('returns everything when nothing is typed', () => {
    expect(matching(CONTROLS, '')).toHaveLength(3)
    expect(matching(CONTROLS, '   ')).toHaveLength(3)
  })

  it('matches the key, which is often what someone remembers', () => {
    expect(matching(CONTROLS, 'db-eu').map((c) => c.key)).toEqual(['db-eu-west'])
  })

  it('matches the description too', () => {
    expect(matching(CONTROLS, 'primaire').map((c) => c.key)).toEqual(['db-eu-west'])
  })

  it('ignores accents in both directions', () => {
    // The case this exists for: a French name and an ASCII keyboard. Typing
    // "donnees" must find "données", and typing "données" must still work.
    expect(matching(CONTROLS, 'donnees').map((c) => c.key)).toEqual(['db-eu-west'])
    expect(matching(CONTROLS, 'données').map((c) => c.key)).toEqual(['db-eu-west'])
  })

  it('ignores case', () => {
    expect(matching(CONTROLS, 'API')).toHaveLength(1)
    expect(matching(CONTROLS, 'api')).toHaveLength(1)
  })

  it('narrows with each term rather than widening', () => {
    // Every term must match somewhere — the behaviour of every search box
    // people already use. "paris cluster" is one control, not two.
    expect(matching(CONTROLS, 'paris cluster')).toHaveLength(1)
    expect(matching(CONTROLS, 'paris gateway')).toHaveLength(0)
  })
})

import { existsSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../config.js'
import { binaryNameFor, shippedAgentVersion, upgradeFor } from './agent-release.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return { ...actual, existsSync: vi.fn() }
})

/**
 * The two ways this can be quietly wrong, and they mirror each other.
 *
 * Offering an upgrade that cannot happen puts a button on a row that answers
 * with a download failure minutes later, on a machine nobody is watching.
 * Never offering one lets an estate drift a version at a time with the screen
 * saying nothing — which is the state this was written for.
 */

const shipped = vi.mocked(existsSync)

/** Everything this instance publishes is present, unless a test says otherwise. */
beforeEach(() => {
  shipped.mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function agent(over: Partial<Parameters<typeof upgradeFor>[0]> = {}) {
  return {
    role: 'agent',
    os: 'linux',
    arch: 'x86_64',
    agentVersion: '0.2.0',
    status: 'active',
    isLocal: false,
    ...over,
  }
}

describe('binaryNameFor', () => {
  it('reads what the Rust agent calls its platform', () => {
    expect(binaryNameFor('agent', 'linux', 'x86_64')).toBe('tern-agent-x86_64-unknown-linux-musl')
    expect(binaryNameFor('agent', 'macos', 'aarch64')).toBe('tern-agent-aarch64-apple-darwin')
  })

  it('and what Node calls it, because the local agent is registered by Node', () => {
    // `x64` and `win32` are Node's spelling. Both vocabularies land in the same
    // column, so both have to resolve — see the note on the function.
    expect(binaryNameFor('agent', 'linux', 'x64')).toBe('tern-agent-x86_64-unknown-linux-musl')
    expect(binaryNameFor('agent', 'win32', 'x64')).toBe('tern-agent-x86_64-pc-windows-msvc.exe')
    expect(binaryNameFor('agent', 'darwin', 'arm64')).toBe('tern-agent-aarch64-apple-darwin')
  })

  it('gives a relay its own binary and never the agent’s', () => {
    // A relay that replaced itself with an agent would come back with no zone,
    // no listener, and nothing behind it able to report.
    expect(binaryNameFor('proxy', 'linux', 'x86_64')).toBe('tern-proxy-x86_64-unknown-linux-musl')
  })

  it('says nothing for a platform this project does not build for', () => {
    expect(binaryNameFor('agent', 'windows', 'aarch64')).toBeNull()
    expect(binaryNameFor('agent', 'freebsd', 'x86_64')).toBeNull()
    expect(binaryNameFor('agent', null, 'x86_64')).toBeNull()
    expect(binaryNameFor('agent', 'linux', null)).toBeNull()
  })

  it('and nothing for a build this instance does not actually have', () => {
    // A source checkout that never ran CI has an empty `bin/`. The name is
    // right and the file is absent, which is a button that cannot work.
    shipped.mockReturnValue(false)
    expect(binaryNameFor('agent', 'linux', 'x86_64')).toBeNull()
  })
})

describe('upgradeFor', () => {
  const declared = config.TERN_VERSION

  beforeEach(() => {
    ;(config as { TERN_VERSION: string }).TERN_VERSION = 'v0.2.1'
  })

  afterEach(() => {
    ;(config as { TERN_VERSION: string }).TERN_VERSION = declared
  })

  it('names the version an agent that is behind would move to', () => {
    expect(shippedAgentVersion()).toBe('0.2.1')
    expect(upgradeFor(agent())).toBe('0.2.1')
  })

  it('offers nothing to one that is already there, or ahead', () => {
    expect(upgradeFor(agent({ agentVersion: '0.2.1' }))).toBeNull()
    // Ahead happens: an operator who built from main, or an instance rolled
    // back. Walking that machine backwards is not an upgrade.
    expect(upgradeFor(agent({ agentVersion: '0.3.0' }))).toBeNull()
  })

  it('compares as numbers, which is where a string comparison would lie', () => {
    ;(config as { TERN_VERSION: string }).TERN_VERSION = 'v0.10.0'
    expect(upgradeFor(agent({ agentVersion: '0.9.0' }))).toBe('0.10.0')
  })

  it('says nothing when either side has no version to compare', () => {
    expect(upgradeFor(agent({ agentVersion: null }))).toBeNull()
    // A build with no tag has binaries of unknown vintage. "You are behind" is
    // not something to tell an operator on a hunch.
    ;(config as { TERN_VERSION: string }).TERN_VERSION = 'dev'
    expect(upgradeFor(agent())).toBeNull()
  })

  it('says nothing for a revoked row', () => {
    // Its key is dead, so nothing on that machine will ever poll for this.
    expect(upgradeFor(agent({ status: 'revoked' }))).toBeNull()
  })

  it('says nothing for the instance’s own agent', () => {
    // It already runs what an upgrade would download — this process starts it
    // from those very files. It moves forward when the instance does.
    expect(upgradeFor(agent({ isLocal: true }))).toBeNull()
  })

  it('says nothing when there is no binary here for its platform', () => {
    shipped.mockReturnValue(false)
    expect(upgradeFor(agent())).toBeNull()
  })
})

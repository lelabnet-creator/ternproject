import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { config } from '../config.js'
import { requestUpdate, toProgress, updateProgress, updaterPresent } from './self-update.js'

/**
 * The half of the update that this process is responsible for: writing down
 * what it wants, and reading what somebody else did about it.
 *
 * The failure these guard against is the reassuring kind. An updater that is
 * not there, a status file that is half written, a percentage of `"nope"` —
 * each must land on "nothing is known", never on a full bar or a green tick.
 */

let dir: string
const original = config.TERN_DATA_DIR

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tern-update-'))
  config.TERN_DATA_DIR = dir
})

afterEach(() => {
  config.TERN_DATA_DIR = original
  rmSync(dir, { recursive: true, force: true })
})

const heartbeat = (at = new Date()) =>
  writeFileSync(join(dir, 'updater.json'), JSON.stringify({ seenAt: at.toISOString() }))

const status = (record: Record<string, unknown>) =>
  writeFileSync(join(dir, 'update.status.json'), JSON.stringify(record))

describe('updaterPresent', () => {
  it('is false with no heartbeat at all', async () => {
    await expect(updaterPresent()).resolves.toBe(false)
  })

  it('is true on a fresh one', async () => {
    heartbeat()
    await expect(updaterPresent()).resolves.toBe(true)
  })

  it('is false once the updater has stopped ticking', async () => {
    // A container that was removed leaves its last heartbeat behind. Believing
    // it would offer a button whose request nothing will ever read.
    heartbeat(new Date(Date.now() - 10 * 60_000))
    await expect(updaterPresent()).resolves.toBe(false)
  })

  it('is false on a heartbeat from the future', async () => {
    // Two clocks disagreeing, not a fresh tick — and the disagreement is the
    // interesting fact, because it would otherwise never expire.
    heartbeat(new Date(Date.now() + 10 * 60_000))
    await expect(updaterPresent()).resolves.toBe(false)
  })

  it('is false on a file that is not JSON', async () => {
    // Caught mid-write, or truncated by a full disk.
    writeFileSync(join(dir, 'updater.json'), '{"seenAt":')
    await expect(updaterPresent()).resolves.toBe(false)
  })
})

describe('updateProgress', () => {
  it('reports the absence of an updater as its own state', async () => {
    // Not `idle`. One means "ask away", the other means "there is nobody to
    // ask", and only the second should replace a button with instructions.
    const progress = await updateProgress()
    expect(progress.state).toBe('unavailable')
    expect(progress.steps.every((step) => step.state === 'pending')).toBe(true)
  })

  it('is idle with an updater and nothing asked of it', async () => {
    heartbeat()
    await expect(updateProgress()).resolves.toMatchObject({ state: 'idle', target: null })
  })

  it('reads the updater´s report', async () => {
    heartbeat()
    status({
      id: 'abc',
      target: '0.1.7',
      state: 'running',
      step: 'pull',
      percent: 42,
      detail: '3 of 7 layers',
      startedAt: '2026-08-09T09:00:00Z',
    })

    const progress = await updateProgress()
    expect(progress.state).toBe('running')
    expect(progress.target).toBe('0.1.7')
    expect(progress.steps.map((step) => step.state)).toEqual(['running', 'pending', 'pending'])
    expect(progress.steps[0]).toMatchObject({ percent: 42, detail: '3 of 7 layers' })
  })
})

describe('toProgress', () => {
  it('marks the steps before the current one as done', () => {
    const progress = toProgress({ state: 'running', step: 'restart', percent: 50 }, true)
    expect(progress.steps.map((step) => step.state)).toEqual(['done', 'done', 'running'])
  })

  it('marks every step done on success', () => {
    const progress = toProgress({ state: 'succeeded', step: 'restart', percent: 100 }, true)
    expect(progress.steps.every((step) => step.state === 'done')).toBe(true)
  })

  it('fails the step it failed on, and no others', () => {
    const progress = toProgress(
      { state: 'failed', step: 'verify', detail: 'says it is 0.1.6' },
      true,
    )
    expect(progress.steps.map((step) => step.state)).toEqual(['done', 'failed', 'pending'])
    expect(progress.steps[1]?.detail).toContain('0.1.6')
  })

  it('claims nothing about the order when the step is unrecognised', () => {
    // A newer updater reporting a step this build has never heard of. Guessing
    // where it sits would draw ticks against work that may not have happened.
    const progress = toProgress({ state: 'running', step: 'quantum-tunnel' }, true)
    expect(progress.steps.every((step) => step.state === 'pending')).toBe(true)
  })

  it('refuses a percentage that is not one', () => {
    for (const percent of ['nope', null, NaN, Infinity, -20, 900]) {
      const progress = toProgress({ state: 'running', step: 'pull', percent }, true)
      const value = progress.steps[0]!.percent
      expect(value, String(percent)).toBeGreaterThanOrEqual(0)
      expect(value, String(percent)).toBeLessThanOrEqual(100)
    }
  })
})

describe('requestUpdate', () => {
  it('refuses when there is no updater to read the request', async () => {
    const outcome = await requestUpdate('0.1.7', 'ghcr.io/owner/tern')
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable' })
    // And writes nothing: a request file nobody reads is one an updater would
    // pick up the moment it was finally started, hours later.
    expect(() => readFileSync(join(dir, 'update.request'))).toThrow()
  })

  it('refuses a second request while one is running', async () => {
    heartbeat()
    status({ id: 'abc', state: 'running', step: 'pull' })
    await expect(requestUpdate('0.1.7', 'ghcr.io/owner/tern')).resolves.toMatchObject({
      ok: false,
      reason: 'busy',
    })
  })

  it('writes key=value, which is what a POSIX shell can read', async () => {
    heartbeat()
    const outcome = await requestUpdate('0.1.7', 'ghcr.io/owner/tern')
    expect(outcome.ok).toBe(true)

    const written = readFileSync(join(dir, 'update.request'), 'utf8')
    expect(written).toContain('target=0.1.7')
    expect(written).toContain('image=ghcr.io/owner/tern')
    expect(written).toMatch(/^id=[0-9a-f]{24}$/m)
  })

  it('gives every request a new id, so a repeat is not mistaken for the old one', async () => {
    heartbeat()
    const first = await requestUpdate('0.1.7', 'ghcr.io/owner/tern')
    status({ id: 'whatever', state: 'succeeded', step: 'restart' })
    const second = await requestUpdate('0.1.8', 'ghcr.io/owner/tern')

    expect(first.ok && second.ok && first.id !== second.id).toBe(true)
  })
})

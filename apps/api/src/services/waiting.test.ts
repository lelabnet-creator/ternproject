import { describe, expect, it } from 'vitest'

import { heldCount, holdFor, MAX_HOLD_MS, wake, waitForWork } from './waiting.js'

describe('waitForWork', () => {
  it('returns as soon as its agent is woken', async () => {
    const started = Date.now()
    const held = waitForWork(['a'], 5_000)
    setTimeout(() => wake(['a']), 10)
    expect(await held).toBe(true)
    // The point of the whole thing: not the five seconds it was allowed.
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('gives up on its own when nobody comes', async () => {
    expect(await waitForWork(['quiet'], 20)).toBe(false)
  })

  it('ignores a wake for somebody else', async () => {
    const held = waitForWork(['mine'], 40)
    wake(['not-mine'])
    expect(await held).toBe(false)
  })

  /** A relay waits for its whole zone, so any one of them ends the wait. */
  it('wakes on any of the agents it was given', async () => {
    const held = waitForWork(['relay', 'behind-it'], 5_000)
    wake(['behind-it'])
    expect(await held).toBe(true)
  })

  it('does not wait at all when asked for nothing', async () => {
    expect(await waitForWork(['a'], 0)).toBe(false)
    expect(await waitForWork([], 5_000)).toBe(false)
  })

  /*
   * The leak that would not show up as a failure: a listener left behind on
   * every beat, on a process that beats for every agent every twenty seconds.
   */
  it('leaves no listener behind, woken or expired', async () => {
    expect(heldCount()).toBe(0)

    const expired = waitForWork(['tidy'], 20)
    expect(heldCount()).toBe(1)
    await expired
    expect(heldCount()).toBe(0)

    const relay = waitForWork(['relay', 'zone-a', 'zone-b'], 5_000)
    expect(heldCount()).toBe(3)
    wake(['zone-b'])
    await relay
    expect(heldCount()).toBe(0)
  })
})

describe('holdFor', () => {
  it('answers at once when the agent asks for nothing', () => {
    expect(holdFor(undefined)).toBe(0)
    expect(holdFor(0)).toBe(0)
  })

  it('gives what was asked, in milliseconds', () => {
    expect(holdFor(5)).toBe(5_000)
  })

  it('never gives more than this server will hold', () => {
    expect(holdFor(300)).toBe(MAX_HOLD_MS)
  })
})

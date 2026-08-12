/**
 * Holding an agent's beat open until there is something to tell it.
 *
 * An agent cannot be called. It polls, and everything the console asks waited
 * for the next poll — a minute, once the beat was shortened, and five before
 * that. A minute is a long time to look at a button you have pressed, and it is
 * how somebody comes to press it four times.
 *
 * So the beat waits. The agent asks "anything for me?", this holds the request
 * until the answer is yes or the hold runs out, and the agent asks again. One
 * connection standing open per agent, instead of one question a minute — and an
 * instruction reaches the machine within a second of being asked for.
 *
 * ## Why this and not a WebSocket
 *
 * The same property that makes an agent reachable at all: the agent opens the
 * connection. Through a firewall, through a relay, through a corporate proxy
 * that has never heard of an upgrade header — all of it works, because it is a
 * POST that happens to take a while. A WebSocket would buy the ability to push
 * things other than instructions, which nothing here needs yet, at the cost of
 * a second protocol, a reconnection dance, and a fallback for the proxies that
 * refuse it.
 *
 * ## What it costs
 *
 * A held request per agent. For the fleets this product is built for — tens of
 * machines, not tens of thousands — that is a socket each and nothing else: no
 * timer, no polling loop, no work while it waits. The hold is bounded so that a
 * connection cannot be forgotten, and the agent's own re-ask is what makes it
 * continuous.
 */

import { EventEmitter } from 'node:events'

/**
 * A woken agent, by id.
 *
 * In process, because the thing that enqueues an instruction and the thing that
 * holds the beat are the same server. A deployment that ran several of these
 * behind one address would miss the signal — which is why the wait also expires
 * on its own rather than trusting it, and why a missed signal costs a fraction
 * of the hold rather than the instruction.
 */
const woken = new EventEmitter()

// A held beat per agent, and a relay listens for its whole zone. The default of
// ten is reached by a small fleet and prints a warning that means nothing here.
woken.setMaxListeners(0)

/** Tells anyone holding a beat for these agents to look again. */
export function wake(agentIds: string[]): void {
  for (const id of agentIds) woken.emit(id)
}

/**
 * Waits until one of these agents is woken, or the time runs out.
 *
 * Resolves `true` if it was woken — the caller then re-reads the database,
 * which is the authority; this only says "worth looking".
 */
export function waitForWork(agentIds: string[], ms: number): Promise<boolean> {
  if (agentIds.length === 0 || ms <= 0) return Promise.resolve(false)

  return new Promise((resolve) => {
    let settled = false
    const done = (woke: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const id of agentIds) woken.off(id, onWake)
      resolve(woke)
    }

    const onWake = () => done(true)
    const timer = setTimeout(() => done(false), ms)
    // Unref'd: a held beat must never be the reason a process refuses to exit.
    timer.unref?.()

    for (const id of agentIds) woken.on(id, onWake)
  })
}

/**
 * How many beats are being held right now.
 *
 * Exposed because the failure this design can have is invisible otherwise: a
 * listener left behind on every beat leaks quietly on a process that beats for
 * every agent three times a minute, and nothing about the product would look
 * wrong until the process did.
 */
export function heldCount(): number {
  return woken.eventNames().reduce((total, name) => total + woken.listenerCount(name), 0)
}

/**
 * How long a beat may be held.
 *
 * Twenty-five seconds sits under every idle timeout that tends to be in the way
 * — thirty on nginx and on most cloud load balancers, sixty on Caddy — so the
 * hold ends on this server's terms rather than as a dropped connection the
 * agent has to tell apart from a real failure.
 */
export const MAX_HOLD_MS = 25_000

/** What an agent may ask for, bounded to what this server will give. */
export function holdFor(requested: number | undefined): number {
  if (!requested || requested <= 0) return 0
  return Math.min(requested * 1000, MAX_HOLD_MS)
}

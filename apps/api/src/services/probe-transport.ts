import { connect } from 'node:net'
import { lookup } from 'node:dns/promises'
import {
  evaluateAssertions,
  type Probe,
  type ProbeObservation,
  type ProbeResult,
} from '@tern/shared'

/**
 * The I/O half of probe execution.
 *
 * The assertion engine lives in `shared` and is shared with the Rust agent by
 * contract; this file only produces the observation it evaluates. Keeping them
 * apart is what lets the semantics be tested without a network.
 */

export async function runProbe(probe: Probe): Promise<ProbeResult> {
  const observation = await observe(probe)
  return evaluateAssertions(probe.assertions, observation)
}

async function observe(probe: Probe): Promise<ProbeObservation> {
  switch (probe.type) {
    case 'http':
      return observeHttp(probe)
    case 'tcp':
      return observeTcp(probe)
    case 'ping':
      // ICMP needs raw sockets, which a server process should not hold. A TCP
      // connect to the echo port measures reachability closely enough and needs
      // no privileges — the agent, which may run as root on a host that wants
      // it, does real ICMP.
      return observeTcp({ host: probe.host, port: 7, timeoutMs: probe.timeoutMs })
    case 'dns':
      return observeDns(probe)
    case 'cert':
      return observeCert(probe)
  }
}

async function observeHttp(probe: Extract<Probe, { type: 'http' }>): Promise<ProbeObservation> {
  const started = performance.now()

  try {
    const response = await fetch(probe.url, {
      method: probe.method,
      headers: probe.headers,
      body: probe.body,
      redirect: probe.followRedirects ? 'follow' : 'manual',
      signal: AbortSignal.timeout(probe.timeoutMs),
    })

    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      headers[key] = value
    })

    // The body is read before latency is taken: a server that sends headers
    // fast and then stalls is slow, and stopping the clock at the headers would
    // report it as healthy.
    const body = await response.text()

    return {
      latencyMs: Math.round(performance.now() - started),
      statusCode: response.status,
      headers,
      body,
    }
  } catch (error) {
    return { error: describe(error), latencyMs: Math.round(performance.now() - started) }
  }
}

function observeTcp(probe: {
  host: string
  port: number
  timeoutMs: number
}): Promise<ProbeObservation> {
  return new Promise((resolve) => {
    const started = performance.now()
    const socket = connect({ host: probe.host, port: probe.port })
    let settled = false

    const finish = (observation: ProbeObservation) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(observation)
    }

    socket.setTimeout(probe.timeoutMs)
    socket.once('connect', () => finish({ latencyMs: Math.round(performance.now() - started) }))
    socket.once('timeout', () => finish({ error: `Timed out after ${probe.timeoutMs} ms` }))
    socket.once('error', (error) => finish({ error: describe(error) }))
  })
}

async function observeDns(probe: Extract<Probe, { type: 'dns' }>): Promise<ProbeObservation> {
  const started = performance.now()
  try {
    const records = await lookup(probe.name, { all: true })
    return {
      latencyMs: Math.round(performance.now() - started),
      dnsRecords: records.map((r) => r.address),
    }
  } catch (error) {
    return { error: describe(error) }
  }
}

async function observeCert(probe: Extract<Probe, { type: 'cert' }>): Promise<ProbeObservation> {
  const tls = await import('node:tls')

  return new Promise((resolve) => {
    const started = performance.now()
    const socket = tls.connect(
      { host: probe.host, port: probe.port, servername: probe.host, timeout: probe.timeoutMs },
      () => {
        const cert = socket.getPeerCertificate()
        socket.destroy()

        if (!cert?.valid_to) {
          resolve({ error: 'No certificate presented' })
          return
        }

        const daysLeft = Math.floor((Date.parse(cert.valid_to) - Date.now()) / 86_400_000)
        resolve({
          latencyMs: Math.round(performance.now() - started),
          certExpiresInDays: daysLeft,
        })
      },
    )

    socket.once('timeout', () => {
      socket.destroy()
      resolve({ error: `Timed out after ${probe.timeoutMs} ms` })
    })
    socket.once('error', (error) => {
      socket.destroy()
      resolve({ error: describe(error) })
    })
  })
}

/**
 * A message an operator can act on.
 *
 * Node's raw errors say "fetch failed" with the useful part nested in `cause`,
 * which is precisely the detail someone debugging a probe needs.
 */
function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    if (cause instanceof Error && cause.message) return `${error.message}: ${cause.message}`
    if (cause && typeof cause === 'object' && 'code' in cause) {
      return `${error.message}: ${String((cause as { code: unknown }).code)}`
    }
    return error.message
  }
  return String(error)
}

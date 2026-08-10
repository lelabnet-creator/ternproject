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
    case 'websocket':
      return observeWebsocket(probe)
    case 'docker':
      /*
       * The first of the four targets the server refuses.
       *
       * Running it would mean handing this process a Docker socket, and the
       * Docker socket is root on the host: an HTTP service able to create a
       * privileged container bind-mounting `/` is a remote root shell with
       * extra steps. No configuration flag is offered, because a flag is a
       * thing somebody turns on.
       *
       * An error rather than a silent skip: the control is assigned to an
       * agent or it does not work, and "nothing happened" is the worst way to
       * learn which.
       */
      return {
        error:
          'A docker control must be run by an agent on the host. The server has no ' +
          'Docker socket and is not given one — see `docker` in the probe specification.',
      }
    case 'file':
    case 'directory':
    case 'uptime':
      /*
       * The other three, refused for one reason.
       *
       * They read the filesystem and the process table of whatever machine runs
       * them. On an agent that machine belongs to the operator, who installed
       * the binary and chose its user. Here it is the instance — and a control
       * is editable by anyone with write access to a tenant. Executing them
       * server-side would turn that form into a filesystem oracle: `file` on
       * `/root/.ssh/id_ed25519` reports whether it is there and how many bytes
       * it is, `directory` on `/home` lists the accounts, `uptime` reports how
       * long the instance has been up. None of that is the tenant's to ask.
       *
       * Refused by name in the same breath as `docker`, and for the sharper
       * reason: the Docker socket at least has to be mounted before it can be
       * abused, whereas the filesystem is simply there.
       */
      return {
        error:
          `A ${probe.type} control observes the machine it runs on, so it must be run by an ` +
          'agent. The server refuses it rather than reading its own filesystem on behalf of ' +
          'a tenant — see `file`, `directory` and `uptime` in the probe specification.',
      }
  }
}

/**
 * The WebSocket opening handshake, and only that.
 *
 * `fetch` cannot do this: it treats a 101 as a protocol error rather than a
 * response, so the status line never reaches the caller. The handshake is an
 * ordinary HTTP/1.1 upgrade request, so it is written out by hand over a socket
 * the same way `observeCert` does its own TLS.
 *
 * The clock stops on the status line. Nothing is sent afterwards and the socket
 * is closed immediately — see the note on `websocketProbeSchema` for why there
 * is no send/expect pair.
 */
async function observeWebsocket(
  probe: Extract<Probe, { type: 'websocket' }>,
): Promise<ProbeObservation> {
  const url = new URL(probe.url)

  // The schema refuses any other scheme, so this is the row written before it
  // did — and the alternative is worse than a refusal: `https:` is not `wss:`,
  // so it would be dialled as plaintext on port 443, answer something, and be
  // reported as a working websocket. The agent has always refused it here.
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return { error: `${probe.url} is not a ws:// or wss:// URL` }
  }

  const secure = url.protocol === 'wss:'
  const port = url.port ? Number(url.port) : secure ? 443 : 80
  const started = performance.now()

  /* 16 random bytes, base64. The server echoes a hash of it back; we do not
     verify that, because a server that answers 101 has accepted the upgrade and
     the accept-hash tells us nothing further about availability. */
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64')

  const headers = [
    `GET ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    ...(probe.subprotocol ? [`Sec-WebSocket-Protocol: ${probe.subprotocol}`] : []),
    ...Object.entries(probe.headers).map(([name, value]) => `${name}: ${value}`),
    '',
    '',
  ].join('\r\n')

  try {
    const socket = secure
      ? (await import('node:tls')).connect({
          host: url.hostname,
          port,
          servername: url.hostname,
          // Always verified, and no longer configurable — the schema no longer
          // carries the field. It was honoured here and ignored by the agent,
          // so one control gave two verdicts depending on who ran it. See the
          // note on `websocketProbeSchema`.
          rejectUnauthorized: true,
        })
      : connect({ host: url.hostname, port })

    const statusLine = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`No handshake response within ${probe.timeoutMs} ms`))
      }, probe.timeoutMs)

      let buffered = ''

      const finish = (line: string) => {
        clearTimeout(timer)
        socket.destroy()
        resolve(line)
      }

      socket.on(secure ? 'secureConnect' : 'connect', () => socket.write(headers))
      socket.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('latin1')
        const end = buffered.indexOf('\r\n')
        if (end !== -1) finish(buffered.slice(0, end))
      })
      socket.on('error', (error: Error) => {
        clearTimeout(timer)
        socket.destroy()
        reject(error)
      })
    })

    const latencyMs = Math.round(performance.now() - started)
    /* "HTTP/1.1 101 Switching Protocols" — the number is what `status_code`
       asserts on, so a plain handshake check is `{ "type": "status_code",
       "eq": 101 }` and needs nothing new in the engine. */
    const status = Number(statusLine.split(' ')[1])

    return {
      latencyMs,
      statusCode: Number.isFinite(status) ? status : undefined,
      body: statusLine,
    }
  } catch (error) {
    return { error: describe(error) }
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

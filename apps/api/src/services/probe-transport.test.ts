import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { runProbe } from './probe-transport.js'

/**
 * The server's half of the transports.
 *
 * There was no test file here at all. The conformance fixtures cover what an
 * observation *means* once obtained; nothing covered obtaining one, which is
 * how `websocket` and `docker` shipped in 0.1.7 with two implementations and no
 * exercise of either. `docs/probes.md` now states the rule these satisfy.
 *
 * Everything binds a listener on 127.0.0.1. No test here reaches a network this
 * machine does not own — a suite that probed a public host would fail on a train.
 */

let open: Server | null = null

afterEach(() => {
  open?.close()
  open = null
})

/** Answers one connection with a fixed status line, then closes. */
async function handshakeServer(statusLine: string): Promise<number> {
  const server = createServer((socket) => {
    socket.once('data', () => {
      socket.write(`${statusLine}\r\n\r\n`)
    })
  })
  open = server
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}

describe('docker, on the server', () => {
  it('is refused, and says to give it to an agent', async () => {
    /*
     * A security property, not a limitation to be relaxed later.
     *
     * Running it would mean handing this process a Docker socket, which is root
     * on the host. The refusal has to be an error rather than a silent skip:
     * "nothing happened" is the worst way to learn a control is not being run.
     */
    const result = await runProbe({
      type: 'docker',
      container: 'anything',
      requireHealthcheck: false,
      timeoutMs: 1000,
      assertions: [],
    })

    expect(result.status).toBe('down')
    expect(result.message).toMatch(/agent/i)
    // And never by touching a socket to find out.
    expect(result.message).not.toMatch(/could not connect/i)
  })
})

describe('websocket, on the server', () => {
  it('reports the upgrade it was granted', async () => {
    const port = await handshakeServer('HTTP/1.1 101 Switching Protocols')

    const result = await runProbe({
      type: 'websocket',
      url: `ws://127.0.0.1:${port}/ws`,
      headers: {},
      timeoutMs: 2000,
      // 101 is an ordinary status code to the engine, which is the design: no
      // special case exists for this target, and that only holds if the number
      // reaches the assertion.
      assertions: [{ type: 'status_code', severity: 'down', eq: 101 }],
    })

    expect(result.status).toBe('operational')
  })

  it('reaches a server that refuses the upgrade, and lets the assertion judge it', async () => {
    const port = await handshakeServer('HTTP/1.1 404 Not Found')

    const result = await runProbe({
      type: 'websocket',
      url: `ws://127.0.0.1:${port}/ws`,
      headers: {},
      timeoutMs: 2000,
      assertions: [{ type: 'status_code', severity: 'down', eq: 101 }],
    })

    // Down because the assertion says so, not because the transport called it
    // unreachable: an endpoint that answered the wrong thing is a different
    // fault from one that answered nothing, and the message has to keep them
    // apart.
    expect(result.status).toBe('down')
    expect(result.message).toMatch(/404/)
  })

  it('refuses a url that is not a websocket url', async () => {
    const result = await runProbe({
      type: 'websocket',
      // A local address that nothing listens on, not a public host: if the
      // refusal below ever regresses, this test must fail on a connection it
      // could not make rather than quietly reach out to the internet.
      url: 'https://127.0.0.1:1/ws',
      headers: {},
      timeoutMs: 2000,
      assertions: [],
    })

    expect(result.status).toBe('down')
    expect(result.message).toMatch(/ws/)
  })
})

describe('cert, on the server', () => {
  it('reports a port that does not speak TLS rather than hanging on it', async () => {
    const server = createServer((socket) => socket.write('not tls\r\n'))
    open = server
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    const result = await runProbe({
      type: 'cert',
      host: '127.0.0.1',
      port,
      timeoutMs: 2000,
      assertions: [],
    })

    expect(result.status).toBe('down')
  })
})

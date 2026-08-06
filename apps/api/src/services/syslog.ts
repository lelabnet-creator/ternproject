import { createSocket } from 'node:dgram'
import { connect } from 'node:net'

/**
 * Mirroring audit events to a syslog collector.
 *
 * Mirroring, not moving: the row in `audit_log` is written first and stays
 * whatever happens here. A trail that only exists on a host you cannot reach
 * during an incident is not a trail you have.
 *
 * Failures are therefore never fatal and never retried. A collector that is
 * down must not make the action that produced the event fail, and a queue of
 * undeliverable log lines is a second thing to operate for no gain — the local
 * trail is already complete.
 */

export interface SyslogTarget {
  host: string
  port: number
  protocol: 'udp' | 'tcp'
  /** 0–23. 16–23 are `local0`–`local7`, which is where application logs belong. */
  facility: number
  format: 'rfc5424' | 'json'
  appName: string
}

export interface SyslogEvent {
  timestamp: Date
  tenantSlug: string
  action: string
  actor: string
  target?: string | null
  ip?: string | null
  meta?: Record<string, unknown>
}

/** Informational. An audit event is a record, not an alarm. */
const SEVERITY_INFO = 6

/**
 * RFC 5424, which is what a modern collector parses without a custom rule.
 *
 * Structured data carries the fields rather than the message, so a collector can
 * filter on `action` without a regular expression over prose.
 */
export function formatRfc5424(event: SyslogEvent, target: SyslogTarget): string {
  const priority = target.facility * 8 + SEVERITY_INFO
  const timestamp = event.timestamp.toISOString()
  const hostname = safe(event.tenantSlug) || '-'

  const structured = [
    `tern@0`,
    `action="${escapeSd(event.action)}"`,
    `actor="${escapeSd(event.actor)}"`,
    event.target ? `target="${escapeSd(event.target)}"` : '',
    event.ip ? `ip="${escapeSd(event.ip)}"` : '',
  ]
    .filter(Boolean)
    .join(' ')

  // The message repeats what the structured data holds, because a human tailing
  // the collector reads the message and a rule reads the fields.
  const message = `${event.action} by ${event.actor}${event.target ? ` on ${event.target}` : ''}`

  return `<${priority}>1 ${timestamp} ${hostname} ${safe(target.appName) || 'tern'} - - [${structured}] ${message}`
}

export function formatJson(event: SyslogEvent, target: SyslogTarget): string {
  const priority = target.facility * 8 + SEVERITY_INFO
  return `<${priority}>${JSON.stringify({
    ts: event.timestamp.toISOString(),
    app: target.appName,
    tenant: event.tenantSlug,
    action: event.action,
    actor: event.actor,
    target: event.target ?? undefined,
    ip: event.ip ?? undefined,
    meta: event.meta,
  })}`
}

export function render(event: SyslogEvent, target: SyslogTarget): string {
  return target.format === 'json' ? formatJson(event, target) : formatRfc5424(event, target)
}

/**
 * One datagram or one line. Resolves when the write is accepted locally, or
 * rejects with something an operator can act on — the caller decides whether
 * that matters, and for the audit path it does not.
 */
export function send(line: string, target: SyslogTarget, timeoutMs = 3000): Promise<void> {
  return target.protocol === 'udp' ? sendUdp(line, target) : sendTcp(line, target, timeoutMs)
}

function sendUdp(line: string, target: SyslogTarget): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4')
    socket.send(Buffer.from(line), target.port, target.host, (error) => {
      socket.close()
      // UDP tells you nothing about the far end; a resolved promise here means
      // "handed to the kernel", and the test in the admin says as much.
      if (error) reject(error)
      else resolve()
    })
  })
}

function sendTcp(line: string, target: SyslogTarget, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: target.host, port: target.port })
    let settled = false

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      // Newline-framed, which is what every collector accepts over a stream.
      socket.write(`${line}\n`, () => finish())
    })
    socket.once('timeout', () => finish(new Error(`Timed out after ${timeoutMs} ms`)))
    socket.once('error', (error) => finish(error))
  })
}

function safe(value: string): string {
  // Syslog headers are space-delimited; a space in one shifts every field after
  // it, which a collector then parses into the wrong column.
  return value.replace(/[^\x21-\x7e]/g, '').slice(0, 48)
}

function escapeSd(value: string): string {
  return String(value).replace(/[\\\]"]/g, (c) => `\\${c}`)
}

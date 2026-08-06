import { describe, expect, it } from 'vitest'
import { formatJson, formatRfc5424, type SyslogEvent, type SyslogTarget } from './syslog.js'

const target: SyslogTarget = {
  host: 'logs.example.com',
  port: 514,
  protocol: 'udp',
  facility: 16, // local0
  format: 'rfc5424',
  appName: 'tern',
}

const event: SyslogEvent = {
  timestamp: new Date('2026-08-06T09:41:12.004Z'),
  tenantSlug: 'acme',
  action: 'agent.revoked',
  actor: 'ops@example.com',
  target: 'agent-17',
  ip: '203.0.113.4',
  meta: { agents: 2 },
}

describe('the syslog line', () => {
  it('computes the priority from facility and severity', () => {
    // local0 (16) × 8 + informational (6) = 134. An audit event is a record,
    // not an alarm, and a collector filtering on severity should see that.
    expect(formatRfc5424(event, target).startsWith('<134>1 ')).toBe(true)
  })

  it('carries the fields as structured data, not only in the prose', () => {
    // So a rule can filter on `action` without a regular expression over a
    // sentence that may be reworded.
    const line = formatRfc5424(event, target)
    expect(line).toContain('[tern@0 action="agent.revoked"')
    expect(line).toContain('actor="ops@example.com"')
    expect(line).toContain('target="agent-17"')
    expect(line).toContain('ip="203.0.113.4"')
  })

  it('escapes what would otherwise close the structured-data block', () => {
    const line = formatRfc5424({ ...event, actor: 'a"b]c\\d' }, target)
    expect(line).toContain('actor="a\\"b\\]c\\\\d"')
    // One opening bracket, one closing: an unescaped quote would have split it.
    expect(line.match(/\[/g)).toHaveLength(1)
  })

  it('strips whatever would shift the header fields', () => {
    // Syslog headers are space-delimited. A space in the app name moves every
    // field after it, and the collector parses them into the wrong columns.
    const line = formatRfc5424(event, { ...target, appName: 'tern prod' })
    expect(line).toContain(' ternprod ')
  })

  it('omits absent optional fields rather than sending empty ones', () => {
    const line = formatRfc5424({ ...event, target: null, ip: null }, target)
    expect(line).not.toContain('target=')
    expect(line).not.toContain('ip=')
  })

  it('keeps the priority prefix in JSON mode, so it is still syslog', () => {
    const line = formatJson(event, { ...target, format: 'json' })
    expect(line.startsWith('<134>{')).toBe(true)
    expect(JSON.parse(line.slice(line.indexOf('{'))).action).toBe('agent.revoked')
  })
})

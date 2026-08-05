import { describe, expect, it } from 'vitest'
import { normalise, severityToStatus } from './receivers.js'

/**
 * Payloads shaped after what each tool actually posts. The adapters are pure, so
 * this is the whole contract — nothing here needs a network or a database.
 */

describe('severity mapping', () => {
  it('maps the vocabularies these tools use', () => {
    expect(severityToStatus('critical')).toBe('down')
    expect(severityToStatus('warning')).toBe('degraded')
    expect(severityToStatus('ok')).toBe('operational')
  })

  it('treats an unrecognised severity as degraded, not down', () => {
    // Guessing high turns an unfamiliar label into a public major outage. That
    // is the expensive direction to be wrong in.
    expect(severityToStatus('spicy')).toBe('degraded')
    expect(severityToStatus(undefined)).toBe('degraded')
  })

  it('is case- and whitespace-insensitive', () => {
    expect(severityToStatus('  CRITICAL ')).toBe('down')
  })
})

describe('alertmanager', () => {
  const payload = {
    status: 'firing',
    alerts: [
      {
        status: 'firing',
        labels: { alertname: 'HighLatency', service: 'api-gateway', severity: 'critical' },
        annotations: { summary: 'p95 above 3s' },
      },
      {
        status: 'resolved',
        labels: { alertname: 'DiskFull', service: 'db-eu-west', severity: 'warning' },
        annotations: { description: 'Disk usage back to normal' },
      },
    ],
  }

  it('normalises a batch, per alert', () => {
    const alerts = normalise('alertmanager', payload)
    expect(alerts).toHaveLength(2)

    expect(alerts[0]).toMatchObject({
      key: 'api-gateway',
      status: 'down',
      resolved: false,
      message: 'p95 above 3s',
    })

    // A resolved alert is operational regardless of its severity label — the
    // severity describes what it was, not what it is.
    expect(alerts[1]).toMatchObject({ key: 'db-eu-west', status: 'operational', resolved: true })
  })

  it('prefers an explicit tern_control label over the service name', () => {
    // So a team can point an existing alert at a specific component without
    // renaming the alert itself.
    const alerts = normalise('alertmanager', {
      alerts: [{ status: 'firing', labels: { service: 'wrong', tern_control: 'right' } }],
    })
    expect(alerts[0]?.key).toBe('right')
  })

  it('skips an alert with nothing identifying it', () => {
    const alerts = normalise('alertmanager', { alerts: [{ status: 'firing', labels: {} }] })
    expect(alerts).toHaveLength(0)
  })

  it('survives a payload with no alerts array', () => {
    expect(normalise('alertmanager', {})).toEqual([])
    expect(normalise('alertmanager', null)).toEqual([])
  })
})

describe('grafana', () => {
  it('handles the legacy shape', () => {
    const alerts = normalise('grafana', {
      state: 'alerting',
      ruleName: 'checkout-errors',
      message: 'Error rate above 5%',
    })
    expect(alerts[0]).toMatchObject({ key: 'checkout-errors', resolved: false })
  })

  it('treats state ok as resolved', () => {
    const alerts = normalise('grafana', { state: 'ok', ruleName: 'checkout-errors' })
    expect(alerts[0]).toMatchObject({ status: 'operational', resolved: true })
  })

  it('falls through to the Alertmanager shape for Grafana 9+', () => {
    const alerts = normalise('grafana', {
      alerts: [{ status: 'firing', labels: { service: 'billing', severity: 'critical' } }],
    })
    expect(alerts[0]).toMatchObject({ key: 'billing', status: 'down' })
  })
})

describe('uptimerobot', () => {
  it('reads alertType 1 as down and 2 as up', () => {
    const down = normalise('uptimerobot', {
      monitorFriendlyName: 'website',
      alertType: '1',
      alertDetails: 'Connection timeout',
    })
    expect(down[0]).toMatchObject({ key: 'website', status: 'down', resolved: false })

    const up = normalise('uptimerobot', { monitorFriendlyName: 'website', alertType: '2' })
    expect(up[0]).toMatchObject({ status: 'operational', resolved: true })
  })
})

describe('healthchecks', () => {
  it('maps a missed ping to down', () => {
    const alerts = normalise('healthchecks', { check: { slug: 'nightly-backup', status: 'down' } })
    expect(alerts[0]).toMatchObject({ key: 'nightly-backup', status: 'down' })
  })
})

describe('zabbix', () => {
  it('maps disaster to down and average to degraded', () => {
    expect(
      normalise('zabbix', { host: 'db01', severity: 'Disaster', status: 'PROBLEM' })[0],
    ).toMatchObject({ status: 'down' })
    expect(
      normalise('zabbix', { host: 'db01', severity: 'Average', status: 'PROBLEM' })[0],
    ).toMatchObject({ status: 'degraded' })
  })
})

describe('generic mapping', () => {
  const payload = {
    service: { name: 'payments' },
    health: { state: 'FAILING', detail: 'upstream refused' },
  }

  it('extracts by JSONPath and applies an explicit status map', () => {
    const alerts = normalise('generic', payload, {
      keyPath: '$.service.name',
      statusPath: '$.health.state',
      messagePath: '$.health.detail',
      statusMap: { FAILING: 'down', SLOW: 'degraded' },
    })

    expect(alerts[0]).toMatchObject({
      key: 'payments',
      status: 'down',
      message: 'upstream refused',
    })
  })

  it('treats the configured okValue as resolved', () => {
    const alerts = normalise(
      'generic',
      { service: { name: 'payments' }, health: { state: 'OK' } },
      {
        keyPath: '$.service.name',
        statusPath: '$.health.state',
        okValue: 'OK',
      },
    )
    expect(alerts[0]).toMatchObject({ status: 'operational', resolved: true })
  })

  it('produces nothing when the key path matches nothing', () => {
    // Better to accept and ignore than to invent a control key from a payload
    // shape nobody configured.
    expect(normalise('generic', payload, { keyPath: '$.nope.missing' })).toEqual([])
  })
})

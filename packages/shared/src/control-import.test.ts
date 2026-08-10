import { describe, expect, it } from 'vitest'
import {
  CONTROL_KINDS,
  formatImportIssue,
  MAX_CONTROLS_PER_IMPORT,
  MAX_IMPORT_BYTES,
  parseControlsFile,
  type ImportIssue,
} from './control-import.js'

/**
 * What is actually under test here is the *reporting*.
 *
 * That a bad file is rejected is the easy half and would pass with a single
 * boolean. The half that matters is whether someone importing forty controls
 * can tell which one is wrong and why, so nearly every case below asserts on
 * the message, the path and the line rather than on `ok === false`.
 */

/** 1-based line of the first line containing `needle`. Beats counting by hand. */
function lineOf(source: string, needle: string): number {
  const index = source.split('\n').findIndex((line) => line.includes(needle))
  if (index === -1) throw new Error(`fixture has no line containing ${JSON.stringify(needle)}`)
  return index + 1
}

/** The same, for the second occurrence of something a fixture repeats. */
function lastLineOf(source: string, needle: string): number {
  const index = source.split('\n').findLastIndex((line) => line.includes(needle))
  if (index === -1) throw new Error(`fixture has no line containing ${JSON.stringify(needle)}`)
  return index + 1
}

function issues(source: string): ImportIssue[] {
  const result = parseControlsFile(source)
  if (result.ok) throw new Error('expected the file to be rejected, but it parsed')
  return result.issues
}

function only(source: string): ImportIssue {
  const found = issues(source)
  expect(
    found,
    `expected exactly one issue, got:\n${found.map(formatImportIssue).join('\n')}`,
  ).toHaveLength(1)
  return found[0]!
}

describe('a valid file', () => {
  const source = `version: 1
controls:
  - key: web
    name: Website
    kind: http
    group: Platform
    expectedIntervalS: 60
    config:
      url: https://example.com/health
      assertions:
        - type: status_code
          range: [200, 299]
        - type: latency
          ms: 800
          severity: degraded

  - key: db.port
    name: Database port
    kind: tcp
    config:
      host: db.internal
      port: 5432

  - key: gateway
    name: Gateway
    kind: ping
    config:
      host: 10.0.0.1
      count: 4

  - key: dns.apex
    name: Apex record
    kind: dns
    config:
      name: example.com
      recordType: A

  - key: tls
    name: Certificate
    kind: cert
    config:
      host: example.com
      assertions:
        - type: cert_expires_in
          days: 14
          severity: degraded

  - key: socket
    name: Live socket
    kind: websocket
    config:
      url: wss://example.com/socket
      assertions:
        - type: status_code
          eq: 101

  - key: api.container
    name: API container
    kind: docker
    config:
      container: api
      requireHealthcheck: true

  - key: exporter.pid
    name: Exporter pidfile
    kind: file
    config:
      path: /var/run/exporter.pid
      mustExist: true
      assertions:
        - type: json_path
          path: $.sizeBytes
          comparator: gt
          value: 0
          as: number

  - key: backups.fresh
    name: Backups still landing
    kind: directory
    config:
      path: /var/backups
      contains: .sql.gz
      maxQuietSeconds: 86400

  - key: db.continuity
    name: Postgres has not restarted
    kind: uptime
    config:
      of: process
      process: postgres
      minSeconds: 300

  - key: nightly-backup
    name: Nightly backup
    expectedIntervalS: 86400
    isPublic: false
    enabled: true
`

  it('accepts every probe kind and push', () => {
    const result = parseControlsFile(source)
    expect(result.ok, result.ok ? '' : result.issues.map(formatImportIssue).join('\n')).toBe(true)
    if (!result.ok) return

    expect(result.controls.map((c) => c.key)).toEqual([
      'web',
      'db.port',
      'gateway',
      'dns.apex',
      'tls',
      'socket',
      'api.container',
      'exporter.pid',
      'backups.fresh',
      'db.continuity',
      'nightly-backup',
    ])
    expect(result.controls.map((c) => c.kind)).toEqual([
      'http',
      'tcp',
      'ping',
      'dns',
      'cert',
      'websocket',
      'docker',
      'file',
      'directory',
      'uptime',
      undefined,
    ])

    // The name of this test is a claim about coverage, so it is checked rather
    // than trusted: every kind the product declares appears above. A kind added
    // to the enum and forgotten here fails at the line that promised otherwise.
    const covered = new Set(result.controls.map((c) => c.kind ?? 'push'))
    expect([...covered].sort()).toEqual([...CONTROL_KINDS].sort())
  })

  it('leaves out what the file left out, rather than inventing defaults', () => {
    // The file is applied on top of what exists. If absence meant `isPublic:
    // true`, re-importing a file that never mentioned visibility would publish
    // every private control on it.
    const result = parseControlsFile(source)
    if (!result.ok) throw new Error('fixture should parse')

    const web = result.controls[0]!
    expect(web).not.toHaveProperty('isPublic')
    expect(web).not.toHaveProperty('enabled')
    expect(web).not.toHaveProperty('position')
    expect(web).not.toHaveProperty('widget')
  })

  it('keeps the probe config exactly as written', () => {
    // Not normalised through the probe schema: storing `method: GET` and
    // `timeoutMs: 10000` that nobody typed makes the next export disagree with
    // the file that produced it, for no gain — the defaults are applied when
    // the probe runs.
    const result = parseControlsFile(source)
    if (!result.ok) throw new Error('fixture should parse')

    expect(result.controls[1]!.config).toEqual({ host: 'db.internal', port: 5432 })
    expect(result.controls[0]!.config).not.toHaveProperty('method')
  })
})

describe('a file that is not YAML', () => {
  it('says so, with the line the parser choked on', () => {
    const source = `controls:
  - key: web
    name: Website
   badly: indented
`
    const issue = only(source)
    expect(issue.message).toMatch(/not valid YAML/i)
    expect(issue.line).toBe(lineOf(source, 'badly'))
    // The parser's own excerpt, with its caret line, is stripped: the line
    // number is a field here, not something to read out of a paragraph.
    expect(issue.message).not.toContain('\n')
  })

  it('reports a repeated mapping key as the syntax error it is', () => {
    // Two `name:` lines in one control is not a schema question — YAML itself
    // has no answer for which one wins, and neither should this.
    const issue = only(`controls:
  - key: web
    name: Website
    name: Website again
`)
    expect(issue.message).toMatch(/must be unique/i)
  })
})

describe('an empty file', () => {
  it('says the file is empty rather than complaining about a missing field', () => {
    for (const source of ['', '   \n\n', '# just a comment\n']) {
      const issue = only(source)
      expect(issue.message).toMatch(/empty/i)
      expect(issue.message).toContain('controls:')
    }
  })

  it('refuses a controls list with nothing in it', () => {
    const issue = only('controls: []\n')
    expect(issue.path).toBe('controls')
    expect(issue.message).toMatch(/at least 1/i)
  })
})

describe('unknown fields', () => {
  it('names the field, its line, and what could have gone there', () => {
    const source = `controls:
  - key: web
    name: Website
    intervalSeconds: 60
`
    const issue = only(source)
    expect(issue.path).toBe('controls[0].intervalSeconds')
    expect(issue.line).toBe(lineOf(source, 'intervalSeconds'))
    expect(issue.key).toBe('web')
    expect(issue.message).toBe('Unknown field "intervalSeconds"')
    expect(issue.expected).toContain('expectedIntervalS')
  })

  it('reports two typos in one control separately, each on its own line', () => {
    const source = `controls:
  - key: web
    name: Website
    isPublik: true
    posn: 3
`
    const found = issues(source)
    expect(found.map((i) => i.path)).toEqual(['controls[0].isPublik', 'controls[0].posn'])
    expect(found.map((i) => i.line)).toEqual([lineOf(source, 'isPublik'), lineOf(source, 'posn')])
  })

  it('catches a typo inside a probe config, which would otherwise be dropped in silence', () => {
    const source = `controls:
  - key: web
    name: Website
    kind: http
    config:
      url: https://example.com
      timeout_ms: 2000
`
    const issue = only(source)
    expect(issue.path).toBe('controls[0].config.timeout_ms')
    expect(issue.line).toBe(lineOf(source, 'timeout_ms'))
    expect(issue.message).toContain('timeout_ms')
  })

  it('rejects an unknown key at the top level, and says what was missing because of it', () => {
    const found = issues(`contorls:
  - key: web
`)
    expect(found.map((i) => i.message)).toEqual([
      'Required, and missing',
      'Unknown field "contorls"',
    ])
    expect(found[1]!.expected).toContain('controls')
  })
})

describe('unknown kinds and types', () => {
  it('lists the kinds a control may have', () => {
    const source = `controls:
  - key: web
    name: Website
    kind: htp
    config:
      url: https://example.com
`
    const issue = only(source)
    expect(issue.path).toBe('controls[0].kind')
    expect(issue.line).toBe(lineOf(source, 'kind: htp'))
    expect(issue.received).toBe('"htp"')
    expect(issue.expected).toBe(CONTROL_KINDS.join(', '))
    // Spelt out once, so a reordering of the enum is caught here rather than
    // only in whatever reads the message.
    expect(issue.expected).toBe(
      'push, http, tcp, ping, dns, cert, websocket, docker, file, directory, uptime',
    )
    expect(formatImportIssue(issue)).toContain('expected push, http, tcp, ping, dns, cert')
  })

  it('lists the assertion types a probe may use', () => {
    const source = `controls:
  - key: web
    name: Website
    kind: http
    config:
      url: https://example.com
      assertions:
        - type: response_time
          ms: 500
`
    const issue = only(source)
    expect(issue.path).toBe('controls[0].config.assertions[0].type')
    expect(issue.line).toBe(lineOf(source, 'response_time'))
    expect(issue.expected).toContain('latency')
    expect(issue.expected).toContain('status_code')
  })

  it('refuses a probe config on a push control instead of ignoring it', () => {
    // Otherwise someone writes a perfectly good http config, forgets the kind,
    // and gets a control that waits forever for a push that nothing sends.
    const source = `controls:
  - key: web
    name: Website
    config:
      url: https://example.com
`
    const issue = only(source)
    expect(issue.path).toBe('controls[0].config')
    expect(issue.message).toMatch(/push control/i)
    expect(issue.message).toContain('http')
  })

  it('refuses a probe kind with no config', () => {
    const issue = only(`controls:
  - key: web
    name: Website
    kind: tcp
`)
    expect(issue.path).toBe('controls[0].config')
    expect(issue.message).toMatch(/needs a config block/i)
  })

  it('requires the fields the chosen probe needs', () => {
    const source = `controls:
  - key: db
    name: Database
    kind: tcp
    config:
      host: db.internal
`
    const issue = only(source)
    expect(issue.path).toBe('controls[0].config.port')
    expect(issue.message).toMatch(/required/i)
    expect(issue.line).toBe(lineOf(source, 'host: db.internal'))
  })

  it('checks the shape of a probe field, not only its presence', () => {
    const source = `controls:
  - key: web
    name: Website
    kind: http
    config:
      url: example.com
`
    const issue = only(source)
    expect(issue.path).toBe('controls[0].config.url')
    expect(issue.message).toMatch(/url/i)
    expect(issue.received).toBe('"example.com"')
  })

  /*
   * A design decision, held by a test because a comment does not fail.
   *
   * The WebSocket probe measures the opening handshake and nothing else: no
   * frame is sent, so there is no `send`/`expect` pair to configure. Someone
   * will reasonably assume otherwise and write one — importing strictly means
   * they are told, rather than having the field dropped in silence and left
   * wondering why their expected reply never matched.
   */
  it('refuses a message to send on a websocket probe, which has none', () => {
    const source = `controls:
  - key: socket
    name: Live socket
    kind: websocket
    config:
      url: wss://example.com/socket
      send: '{"op":"ping"}'
`
    const issue = only(source)
    expect(issue.path).toBe('controls[0].config.send')
    expect(issue.line).toBe(lineOf(source, 'send:'))
  })

  it('requires the container a docker probe watches', () => {
    const source = `controls:
  - key: api.container
    name: API container
    kind: docker
    config:
      requireHealthcheck: true
`
    const issue = only(source)
    expect(issue.path).toBe('controls[0].config.container')
    expect(issue.message).toMatch(/required/i)
  })
})

describe('values out of bounds', () => {
  it('gives the bound and the value that missed it', () => {
    const source = `controls:
  - key: web
    name: Website
    expectedIntervalS: 999999
`
    const issue = only(source)
    expect(issue.path).toBe('controls[0].expectedIntervalS')
    expect(issue.line).toBe(lineOf(source, '999999'))
    expect(issue.message).toBe('Must be at most 86400')
    expect(issue.received).toBe('999999')
    expect(formatImportIssue(issue)).toBe(
      `line ${issue.line} · controls[0].expectedIntervalS — Must be at most 86400 (found 999999)`,
    )
  })

  it('rejects an interval below the floor', () => {
    const issue = only(`controls:
  - key: web
    name: Website
    expectedIntervalS: 5
`)
    expect(issue.message).toBe('Must be at least 10')
  })

  it('rejects a key that is not safe in a URL, a script or an alert label', () => {
    const issue = only(`controls:
  - key: Web Site
    name: Website
`)
    expect(issue.path).toBe('controls[0].key')
    expect(issue.message).toMatch(/lowercase letters, digits/i)
    expect(issue.received).toBe('"Web Site"')
  })

  it('refuses a degraded threshold that the down threshold makes unreachable', () => {
    const issue = only(`controls:
  - key: web
    name: Website
    degradedThresholdMs: 3000
    downThresholdMs: 1000
`)
    expect(issue.path).toBe('controls[0].degradedThresholdMs')
    expect(issue.message).toContain('below downThresholdMs (1000)')
  })

  it('names a missing required field as missing rather than as a wrong type', () => {
    const issue = only(`controls:
  - key: web
`)
    expect(issue.path).toBe('controls[0].name')
    expect(issue.message).toBe('Required, and missing')
    expect(issue.received).toBeUndefined()
  })
})

describe('duplicate keys', () => {
  it('names the key and the line it was first used on', () => {
    const source = `controls:
  - key: web
    name: Website
  - key: api
    name: API
  - key: web
    name: Website again
`
    const issue = only(source)
    expect(issue.path).toBe('controls[2].key')
    expect(issue.line).toBe(lastLineOf(source, 'key: web'))
    expect(issue.message).toContain('"web"')
    expect(issue.message).toContain('already used on line 2')
  })

  it('is reported alongside the other problems, in file order', () => {
    // A file with two things wrong should not need two round trips to fix.
    const source = `controls:
  - key: web
    name: Website
    kind: htp
    config:
      url: https://example.com
  - key: web
    name: Website again
`
    const found = issues(source)
    expect(found.map((i) => i.path)).toEqual(['controls[0].kind', 'controls[1].key'])
  })
})

describe('bounds on the file itself', () => {
  it('refuses a file larger than the limit before parsing it', () => {
    const filler = '#'.repeat(MAX_IMPORT_BYTES + 1)
    const issue = only(`${filler}\ncontrols:\n  - key: web\n    name: Website\n`)
    expect(issue.message).toMatch(/larger than 256 KB/)
  })

  it('refuses more controls than one file may describe', () => {
    const entries = Array.from(
      { length: MAX_CONTROLS_PER_IMPORT + 1 },
      (_, i) => `  - key: c${i}\n    name: Control ${i}\n`,
    ).join('')
    const issue = only(`controls:\n${entries}`)
    expect(issue.path).toBe('controls')
    expect(issue.message).toBe(`Must hold at most ${MAX_CONTROLS_PER_IMPORT} entries`)
  })

  it('rejects a version it does not know how to read', () => {
    const issue = only(`version: 2
controls:
  - key: web
    name: Website
`)
    expect(issue.path).toBe('version')
    expect(issue.received).toBe('2')
  })

  it('rejects a bare list, which has no version and no room for one', () => {
    const issue = only(`- key: web
  name: Website
`)
    expect(issue.path).toBe('')
    expect(issue.message).toMatch(/expected object/i)
  })
})

describe('groups', () => {
  it('takes a group by name', () => {
    const result = parseControlsFile(`controls:
  - key: web
    name: Website
    group: Platform
`)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.controls[0]!.group).toBe('Platform')
  })

  it('refuses a name and an id at once, which could disagree', () => {
    const issue = only(`controls:
  - key: web
    name: Website
    group: Platform
    groupId: 0b7a3a2e-2c1a-4f0e-9a3f-1b2c3d4e5f60
`)
    expect(issue.path).toBe('controls[0].group')
    expect(issue.message).toMatch(/either group or groupId/i)
  })
})

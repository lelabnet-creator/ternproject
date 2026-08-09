import { describe, expect, it } from 'vitest'
import { parseControlsFile } from '@tern/shared/control-import'
import { ApiError } from '../../lib/api'
import { byteLength, formatBytes, fromLocal, fromWire, issuesFromError } from './issues'

/**
 * The two dialects, made one.
 *
 * The failure this guards against is quiet: a screen that reads `received` from
 * the parser and `received: null` from the API renders the word "null" beside a
 * field the file never wrote, and does it only for the half of the issues that
 * came back over the network. Both halves are checked against the same file.
 */

const BAD = `controls:
  - key: api
    name: API
    kind: http
    config:
      timeout_ms: 5000
`

describe('fromLocal', () => {
  const parsed = parseControlsFile(BAD)

  it('keeps where the problem is', () => {
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    const rows = fromLocal(parsed.issues)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]!.line).toBeTypeOf('number')
    expect(rows[0]!.path).toContain('config')
  })

  it('leaves out what the parser had nothing to say about', () => {
    // A missing field has no value to print, and `received: undefined` renders
    // as nothing where `received: "undefined"` would render as a lie.
    const rows = fromLocal([
      {
        line: 3,
        column: 5,
        path: 'controls[0].name',
        key: 'api',
        message: 'Required, and missing',
      },
    ])
    expect(rows[0]).not.toHaveProperty('received')
    expect(rows[0]).not.toHaveProperty('expected')
  })
})

describe('fromWire', () => {
  it('reads null as absent, not as a value', () => {
    const rows = fromWire([
      {
        line: 3,
        column: 5,
        path: 'controls[0].name',
        key: 'api',
        message: 'Required, and missing',
        received: null,
        expected: 'string',
        detail: 'line 3 · controls[0].name — Required, and missing (expected string)',
      },
    ])
    expect(rows[0]).not.toHaveProperty('received')
    expect(rows[0]!.expected).toBe('string')
  })
})

describe('issuesFromError', () => {
  const body = {
    message: 'One problem in the file. Nothing was imported.',
    issues: [
      {
        line: 6,
        column: 7,
        path: 'controls[0].config.timeout_ms',
        key: 'api',
        message: 'Unknown field "timeout_ms"',
        received: null,
        expected: null,
        detail: 'line 6 · controls[0].config.timeout_ms — Unknown field "timeout_ms"',
      },
    ],
  }

  it('finds the list inside a rejected file', () => {
    const rows = issuesFromError(new ApiError(body.message, 400, body))
    expect(rows).toHaveLength(1)
    expect(rows![0]!.line).toBe(6)
  })

  it('has nothing to say about a refusal that is a sentence', () => {
    // An ambiguous group name is a fact about the tenant, not about a line of
    // the file — the caller falls back to the message in a banner.
    const err = new ApiError('This tenant has more than one group named "Prod".', 409, {
      message: 'This tenant has more than one group named "Prod".',
    })
    expect(issuesFromError(err)).toBeNull()
  })

  it('survives a body that never arrived', () => {
    expect(issuesFromError(new ApiError('Request failed (400)', 400))).toBeNull()
    expect(issuesFromError(new Error('offline'))).toBeNull()
  })
})

describe('byteLength', () => {
  it('counts UTF-8, which is what the limit is written in', () => {
    // Eleven UTF-16 code units, thirteen bytes: a file of accented names is
    // bigger than `String.length` claims, and the check must not be the lenient
    // one or the upload happens just to be refused.
    expect('réseau privé'.length).toBe(12)
    expect(byteLength('réseau privé')).toBe(14)
  })
})

describe('formatBytes', () => {
  it('stays in bytes while that is the honest unit', () => {
    expect(formatBytes(512)).toBe('512 B')
  })

  it('reads in KB once there are any', () => {
    expect(formatBytes(2150)).toBe('2.1 KB')
  })
})

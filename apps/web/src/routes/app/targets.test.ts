import { describe, expect, it } from 'vitest'
import { meansThisMachine, targetHost } from './targets'

/**
 * The rule behind one warning in the control editor: this address will not mean
 * what you think it means.
 *
 * Worth pinning because both halves fail quietly. Too eager, and the notice
 * appears on checks that are fine, which teaches people to ignore it. Too shy,
 * and the check they were about to save fails against an address that looks
 * correct — the case the warning exists for.
 */

const form = (over: Partial<{ kind: string; url: string; host: string }>) => ({
  kind: 'http',
  url: '',
  host: '',
  ...over,
})

describe('the host a check will dial', () => {
  it('comes out of the URL for http, not the raw field', () => {
    expect(targetHost(form({ kind: 'http', url: 'http://localhost:8080/health' }))).toBe(
      'localhost',
    )
    expect(targetHost(form({ kind: 'http', url: 'https://example.com/x' }))).toBe('example.com')
  })

  it('is the host field for tcp, cert and ping', () => {
    for (const kind of ['tcp', 'cert', 'ping']) {
      expect(targetHost(form({ kind, host: '127.0.0.1' }))).toBe('127.0.0.1')
    }
  })

  it('is nothing for dns, which resolves a name and never dials it', () => {
    // A resolver asked about `localhost` answers correctly. Warning there would
    // be advice against a check that works.
    expect(targetHost(form({ kind: 'dns', host: 'localhost' }))).toBe('')
  })

  it('is nothing when the URL cannot be read as one', () => {
    // Every keystroke runs this, so the half-typed states have to be harmless
    // rather than merely unlikely.
    expect(targetHost(form({ kind: 'http', url: '' }))).toBe('')
    expect(targetHost(form({ kind: 'http', url: 'exa' }))).toBe('')
    expect(targetHost(form({ kind: 'http', url: 'https:' }))).toBe('')
  })

  it('reads a single slash the way a browser does, not as a failure', () => {
    // `http:/exa` parses — URL normalises it to `http://exa/`. Pinned because
    // the obvious assumption is that it throws, and a warning that depended on
    // it throwing would fire on the wrong addresses.
    expect(targetHost(form({ kind: 'http', url: 'http:/exa' }))).toBe('exa')
    expect(targetHost(form({ kind: 'http', url: 'http:/localhost' }))).toBe('localhost')
  })
})

describe('addresses that mean "this machine"', () => {
  it('catches the ones people actually type', () => {
    for (const host of [
      'localhost',
      'LocalHost',
      ' localhost ',
      '127.0.0.1',
      '127.1.2.3',
      '::1',
      '[::1]',
      'api.localhost',
      // Not a loopback address, and dialling it is not the same thing — but
      // whoever puts it in a monitoring target means their own machine, and
      // meets the same wall.
      '0.0.0.0',
    ]) {
      expect(meansThisMachine(host), host).toBe(true)
    }
  })

  it('leaves real targets alone', () => {
    for (const host of [
      'example.com',
      'localhost.example.com',
      'notlocalhost',
      '192.168.1.10',
      '10.0.0.1',
      // Close enough to trip a sloppy prefix match, and a public address.
      '127a.example.com',
      '1270.0.0.1',
      '',
    ]) {
      expect(meansThisMachine(host), host).toBe(false)
    }
  })
})

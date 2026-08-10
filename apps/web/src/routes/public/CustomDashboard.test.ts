import { describe, expect, it } from 'vitest'
import { __testables as frame } from './CustomDashboard'

/**
 * The boundary, not the content.
 *
 * Nothing here checks what a tenant wrote — the whole design is that it does
 * not matter, because of where it runs. What matters is that the confinement
 * stays exactly as strict as it is, and every one of these assertions is a
 * protection that a refactor could remove without anything looking broken.
 */

describe('the frame document', () => {
  const doc = frame.documentFor({ html: '<p>hi</p>', css: 'p{color:red}', js: 'void 0' })

  it('denies everything by default', () => {
    expect(frame.FRAME_CSP).toContain("default-src 'none'")
    expect(doc).toContain('Content-Security-Policy')
  })

  it('closes the network, which is what stops the data leaving', () => {
    // A document that can see the status data and can also reach the network is
    // a document that can post it somewhere. This is the load-bearing line.
    expect(frame.FRAME_CSP).toContain("connect-src 'none'")
    expect(frame.FRAME_CSP).toContain("form-action 'none'")
  })

  it('allows no remote image, because a URL is itself a channel', () => {
    // `img-src https:` would let a script encode anything it read into a path
    // and fetch it. `data:` cannot leave the document.
    expect(frame.FRAME_CSP).toContain('img-src data:')
    expect(frame.FRAME_CSP).not.toMatch(/img-src[^;]*https:/)
  })

  it('carries the bridge above the tenant script', () => {
    // The document must find `tern` already defined; the other order gives a
    // script that runs once and never sees any data.
    expect(doc.indexOf('window.tern')).toBeLessThan(doc.indexOf('void 0'))
  })
})

describe('what the document is handed', () => {
  const payload = frame.payloadFor({
    tenant: { custom: null, subscriberDisclaimer: 'x' },
    overall: { status: 'operational', affectedCount: 0 },
    groups: [],
    components: [{ id: 'c1', key: 'k', name: 'API', status: 'operational' }],
    incidents: [],
    maintenances: [],
    generatedAt: 'now',
  } as never)

  it('passes the status data', () => {
    expect(payload.components).toHaveLength(1)
    expect(payload.overall.status).toBe('operational')
  })

  it('passes nothing about the tenant itself', () => {
    // Confined is not a reason to hand it more than it needs. The settings, the
    // disclaimer and the branding are not the dashboard's business.
    expect(payload).not.toHaveProperty('tenant')
  })
})

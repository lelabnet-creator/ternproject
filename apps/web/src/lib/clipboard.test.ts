import { describe, expect, it, vi, afterEach } from 'vitest'
import { copyText } from './clipboard'

/**
 * The case that made this file exist: a plain-HTTP origin.
 *
 * `navigator.clipboard` is undefined outside a secure context, which is exactly
 * how a self-hosted instance is reached on a LAN. The old code called
 * `navigator.clipboard.writeText` straight, so on that origin it threw a
 * TypeError into a click handler and every Copy button in the admin did nothing
 * at all — no copy, no error. These tests hold the fallback, and hold the
 * promise that a refusal is reported rather than swallowed.
 *
 * The suite runs in node with no DOM, so the fallback's document is stubbed
 * down to the surface it actually touches. Adding jsdom to the whole monorepo
 * to reach six lines of it would cost more than it proves.
 */

type Stub = {
  appended: unknown[]
  removed: unknown[]
  execCommand: ReturnType<typeof vi.fn>
}

function stubDocument(execResult: boolean | (() => never)): Stub {
  const stub: Stub = {
    appended: [],
    removed: [],
    execCommand: vi.fn(typeof execResult === 'function' ? execResult : (): boolean => execResult),
  }

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => ({
        style: {},
        setAttribute: () => {},
        select: () => {},
        setSelectionRange: () => {},
      }),
      body: {
        appendChild: (node: unknown) => stub.appended.push(node),
        removeChild: (node: unknown) => stub.removed.push(node),
      },
      getSelection: () => ({ rangeCount: 0 }),
      execCommand: stub.execCommand,
    },
  })

  return stub
}

function setClipboard(value: unknown) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: value === undefined ? {} : { clipboard: value },
  })
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'document')
  Reflect.deleteProperty(globalThis, 'navigator')
  vi.restoreAllMocks()
})

describe('copyText', () => {
  it('uses the modern API when the context is secure', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })
    const doc = stubDocument(true)

    await expect(copyText('hello')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
    // No fallback, and nothing left in the document.
    expect(doc.execCommand).not.toHaveBeenCalled()
    expect(doc.appended).toHaveLength(0)
  })

  it('falls back to execCommand when navigator.clipboard is absent', async () => {
    // The plain-HTTP case that broke every Copy button. Nothing may throw, and
    // the text must still land.
    setClipboard(undefined)
    const doc = stubDocument(true)

    await expect(copyText('http://192.168.1.40:28999/badge/acme.svg')).resolves.toBe(true)
    expect(doc.execCommand).toHaveBeenCalledWith('copy')
  })

  it('falls back when the modern API rejects', async () => {
    // "Document is not focused", or a permission prompt refused.
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('not focused')) })
    const doc = stubDocument(true)

    await expect(copyText('x')).resolves.toBe(true)
    expect(doc.execCommand).toHaveBeenCalledWith('copy')
  })

  it('reports failure rather than claiming a copy', async () => {
    setClipboard(undefined)
    stubDocument(false)

    await expect(copyText('x')).resolves.toBe(false)
  })

  it('cleans up its textarea even when the copy throws', async () => {
    setClipboard(undefined)
    const doc = stubDocument(() => {
      throw new Error('nope')
    })

    await expect(copyText('x')).resolves.toBe(false)
    expect(doc.appended).toHaveLength(1)
    expect(doc.removed).toEqual(doc.appended)
  })
})

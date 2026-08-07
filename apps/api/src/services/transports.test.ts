import { createTransport } from 'nodemailer'
import { describe, expect, it } from 'vitest'

/**
 * What actually goes on the wire for an unsubscribe.
 *
 * Written after chasing a reported defect that turned out not to exist: the
 * claim in BACKLOG.md was that `List-Unsubscribe` never reached the wire. It
 * does, and it always did — the header folds onto a continuation line once it
 * runs long, and any check that greps for lines beginning `List-` reads a
 * correctly folded header as an empty one. That misreading is the trap these
 * tests exist to stop the next person falling into.
 *
 * The real breakage was the address the header pointed at, which is covered in
 * `unsubscribe.integration.test.ts`.
 */

const capture = createTransport({ streamTransport: true, buffer: true })

async function headBlockOf(message: Record<string, unknown>): Promise<string> {
  const info = await capture.sendMail({
    from: 'tern@example.com',
    to: 'reader@example.com',
    subject: 'Status update',
    text: 'body',
    ...message,
  })
  return (info.message as Buffer).toString().split(/\r?\n\r?\n/)[0]!
}

/** The shape `unsubscribeUrlFor` produces: a base URL, a path, and a signed ref. */
const REAL_URL =
  'https://status.example.com/api/v1/unsubscribe/YjE5ZTQ0NTMtN2QzMS00YTFmLWI3MmM.9f2b1c7d4e5a6b8c9d0e1f2a3b4c5d6e'

describe('a long List-Unsubscribe', () => {
  it('reaches the wire, folded rather than dropped', async () => {
    const head = await headBlockOf({
      headers: { 'List-Unsubscribe': `<${REAL_URL}>` },
    })

    // The trap: this line really is bare, and the value really is on the next
    // one. Assert on the whole header block, never on one line.
    expect(head).toContain('List-Unsubscribe:')
    expect(head).toContain(REAL_URL)
    expect(head).toMatch(/List-Unsubscribe:\r?\n\s+</)
  })

  it('folds the same way through nodemailer’s own list option', async () => {
    // Kept as a control. If this ever stops holding, the reported defect was
    // real after all and this file is where that shows up.
    const head = await headBlockOf({ list: { unsubscribe: { url: REAL_URL } } })
    expect(head).toContain(REAL_URL)
  })
})

describe('one-click', () => {
  it('travels beside the address it acts on', async () => {
    const head = await headBlockOf({
      headers: {
        'List-Unsubscribe': `<${REAL_URL}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    })

    expect(head).toContain(REAL_URL)
    expect(head).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click')
  })

  it('is not what the list option produces', async () => {
    // The reason this code writes raw headers: `list` has no way to say
    // one-click, and one-click is what bulk senders now require.
    const head = await headBlockOf({ list: { unsubscribe: { url: REAL_URL } } })
    expect(head).not.toContain('List-Unsubscribe-Post')
  })

  it('is absent entirely when there is no address to unsubscribe from', async () => {
    // A client shown List-Unsubscribe-Post with no usable List-Unsubscribe
    // draws a button that silently does nothing.
    expect(await headBlockOf({})).not.toContain('List-Unsubscribe')
  })
})

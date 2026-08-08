import { useEffect, useRef, useState } from 'react'
import type { StatusSummary } from '../../lib/api'

/**
 * A page the tenant wrote, rendered where it cannot reach anything.
 *
 * The document is theirs — HTML, CSS and script, as written, which is what a
 * free layout actually requires: the alternative is per-breakpoint coordinates
 * in the schema and a drag editor that then owes a keyboard equivalent nobody
 * has designed.
 *
 * What makes that storable rather than reckless is where it runs, not what is
 * in it. The frame carries `sandbox="allow-scripts"` and deliberately **not**
 * `allow-same-origin`, so the document lives in an opaque origin: it cannot
 * read this page's cookies, cannot touch its DOM, cannot reach `localStorage`,
 * and cannot use the session of whoever is looking. A CSP inside it denies the
 * network outright, so nothing it learns can leave. It has no way to navigate
 * the top frame and no way to submit a form.
 *
 * The consequence, and the reason this shape was chosen: the status data is
 * handed in by `postMessage` rather than fetched. The document never needs the
 * network, so the network can be closed.
 *
 * Sanitising instead would be the weaker answer — a filter is a list of things
 * someone eventually gets around, and it would imply a safety that the list,
 * not the boundary, was providing.
 */

/**
 * Denies everything, then allows the two things a layout is made of.
 *
 * `connect-src 'none'` is the load-bearing one: it stops `fetch`, `XHR`,
 * `sendBeacon` and websockets, so a document that can see the status data has
 * no way to send it anywhere. `img-src` allows `data:` only, because an
 * external image URL is itself an exfiltration channel — the path carries
 * whatever the script chose to put in it.
 */
const FRAME_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

/**
 * What the document is given, and the shape it is promised.
 *
 * A deliberate subset of the summary: components, groups, incidents,
 * maintenances and the overall state. Not the tenant's settings, and nothing
 * that is not already on the public page — the frame is confined, but that is
 * no reason to hand it more than it needs.
 */
function payloadFor(data: StatusSummary) {
  return {
    overall: data.overall,
    groups: data.groups,
    components: data.components.map((c) => ({
      id: c.id,
      key: c.key,
      name: c.name,
      description: c.description,
      groupId: c.groupId,
      status: c.status,
      latencyMs: c.latencyMs,
      value: c.value,
      valueUnit: c.valueUnit,
      valueLabel: c.valueLabel,
      lastCheckAt: c.lastCheckAt,
    })),
    incidents: data.incidents,
    maintenances: data.maintenances,
    generatedAt: data.generatedAt,
  }
}

/**
 * The bridge, injected above the tenant's own script.
 *
 * It exposes `tern.data` and `tern.onUpdate(fn)`, and reports the document's
 * height back so the frame can be sized to its content — an iframe has no
 * intrinsic height, and a fixed one would either clip a long page or leave a
 * gap under a short one.
 */
const BRIDGE = `
<script>
(function () {
  var listeners = []
  window.tern = {
    data: null,
    onUpdate: function (fn) {
      listeners.push(fn)
      if (window.tern.data) fn(window.tern.data)
    },
  }
  window.addEventListener('message', function (event) {
    if (!event.data || event.data.type !== 'tern:data') return
    window.tern.data = event.data.payload
    listeners.forEach(function (fn) {
      try { fn(event.data.payload) } catch (e) { console.error(e) }
    })
  })
  function reportHeight() {
    var h = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    )
    parent.postMessage({ type: 'tern:height', height: h }, '*')
  }
  window.addEventListener('load', reportHeight)
  window.addEventListener('resize', reportHeight)
  if (window.ResizeObserver) {
    new ResizeObserver(reportHeight).observe(document.documentElement)
  }
})()
</script>`

function documentFor(custom: { html: string; css: string; js: string }): string {
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">
<style>${custom.css}</style>
</head><body>
${custom.html}
${BRIDGE}
<script>${custom.js}</script>
</body></html>`
}

export const __testables = { documentFor, payloadFor, FRAME_CSP }

export function CustomDashboard({ data }: { data: StatusSummary }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(320)

  const custom = data.tenant.custom

  // Rebuilt only when the document itself changes. Keying on the data would
  // reload the frame every twenty seconds and throw away whatever the tenant's
  // script had drawn.
  const [srcDoc, setSrcDoc] = useState('')
  useEffect(() => {
    setSrcDoc(custom ? documentFor(custom) : '')
  }, [custom?.html, custom?.css, custom?.js])

  // Fresh data on every poll, over the same channel the document already
  // listens on — no reload, no flicker, no refetch from inside the frame.
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ type: 'tern:data', payload: payloadFor(data) }, '*')
  }, [data])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Only from this frame, and only the one message it is allowed to send.
      // The origin is opaque so it cannot be compared; the source can.
      if (event.source !== frame.current?.contentWindow) return
      const message = event.data as { type?: string; height?: number }
      if (message?.type !== 'tern:height' || typeof message.height !== 'number') return
      setHeight(Math.min(20_000, Math.max(120, Math.round(message.height))))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  if (!custom || custom.html.trim() === '') {
    return (
      <section className="page-group">
        <p style={{ margin: 0, color: 'var(--color-fg-subtle)' }}>
          This page uses a custom layout, and none has been written yet.
        </p>
      </section>
    )
  }

  return (
    <iframe
      ref={frame}
      title="Status dashboard"
      srcDoc={srcDoc}
      // No `allow-same-origin`: with it, the document would share this page's
      // origin and every guarantee above would be gone.
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={() => {
        frame.current?.contentWindow?.postMessage(
          { type: 'tern:data', payload: payloadFor(data) },
          '*',
        )
      }}
      style={{ width: '100%', height, border: 0, display: 'block' }}
    />
  )
}

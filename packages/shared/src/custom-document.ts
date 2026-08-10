/**
 * The document a `custom` page starts from.
 *
 * ── Why this exists as a starting point rather than a blank page ─────────────
 *
 * `custom` hands the page over: TERN draws none of its own widgets, the
 * document is given the data and paints it. That is the whole point of the
 * mode, and it made the mode unusable — three empty textareas and a rendered
 * page saying nothing has been written yet. Nobody writes a dashboard, a data
 * bridge and a stylesheet from an empty box to find out whether the idea is
 * worth pursuing. Modifying something that already works is a different task,
 * and a far smaller one.
 *
 * ── Why it lives here and not in the seed ───────────────────────────────────
 *
 * It used to be a constant in `packages/db/src/seed.ts`, applied to the demo
 * tenant alone. So the one complete example of the feature existed, was
 * visible on the demo, and was reachable by nobody using the product. Moved
 * here, the demo and the editor's starting point are the same text — an
 * example that drifts from what the demo shows would be worse than none, since
 * the demo is where anybody looks first to see what the mode can do.
 *
 * ── What it demonstrates, on purpose ────────────────────────────────────────
 *
 * `tern.onUpdate` — the only contract the document has with the page. It fires
 * on load and on every refresh, so a document that redraws inside it stays live
 * without polling anything. The rest is ordinary HTML and CSS.
 *
 * Status is a word before it is a colour: the tile prints the state and puts
 * the hue on its edge as a second channel. That is the rule the rest of this
 * product follows, and an example is where a rule gets copied from.
 */
export interface CustomDocument {
  html: string
  css: string
  js: string
}

/**
 * `pageName` is the only thing filled in: the heading is the first line anybody
 * edits, and starting it on somebody else's company name is the kind of detail
 * that makes an example feel like it was meant for a different product.
 */
export function starterDocument(pageName = 'Status'): CustomDocument {
  return {
    html: `<div class="wall">
  <header>
    <h1>${pageName}</h1>
    <p id="summary">…</p>
  </header>
  <section id="tiles" class="tiles"></section>
  <section id="notes" class="notes"></section>
</div>`,

    css: `:root { color-scheme: dark }
* { box-sizing: border-box }
body {
  margin: 0;
  padding: 24px;
  background: #0d1117;
  color: #e6edf3;
  font: 14px/1.5 system-ui, sans-serif;
}
.wall { display: grid; gap: 20px }
header h1 { margin: 0; font-size: 20px; letter-spacing: -0.01em }
header p { margin: 4px 0 0; color: #9198a1 }

/* Four across on a wall, and however many fit anywhere else. No breakpoint to
   keep in sync with anything — the minimum decides. */
.tiles { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)) }
.tile {
  padding: 14px;
  border: 1px solid #30363d;
  border-radius: 10px;
  background: #161b22;
  border-left-width: 3px;
}
.tile b { display: block; font-size: 12px; color: #9198a1; font-weight: 500 }
.tile .state { font-size: 15px; font-weight: 600; text-transform: capitalize }
.tile .metric { margin-top: 6px; font-size: 12px; color: #9198a1; font-variant-numeric: tabular-nums }

/* State is a word first. The rule on the edge is a second channel, never the
   only one — the same rule the rest of this product follows. */
.operational { border-left-color: #22a15c }
.degraded    { border-left-color: #eab308 }
.partial     { border-left-color: #ea580c }
.down        { border-left-color: #be123c }
.maintenance { border-left-color: #0369a1 }
.unknown     { border-left-color: #6b7280 }

.notes { display: grid; gap: 10px }
.note { padding: 12px 14px; border: 1px solid #30363d; border-left: 3px solid #eab308; border-radius: 8px }
.note h2 { margin: 0 0 4px; font-size: 14px }
.note p { margin: 0; color: #9198a1; font-size: 13px }`,

    js: `tern.onUpdate(function (data) {
  var operational = data.components.filter(function (c) { return c.status === 'operational' }).length
  document.getElementById('summary').textContent =
    operational + ' of ' + data.components.length + ' components operational'

  document.getElementById('tiles').innerHTML = data.components.map(function (c) {
    var metric = c.value != null
      ? c.value.toFixed(0) + ' ' + (c.valueUnit || '')
      : c.latencyMs != null ? c.latencyMs + ' ms' : ''
    return '<div class="tile ' + c.status + '">' +
      '<b>' + c.name + '</b>' +
      '<span class="state">' + c.status + '</span>' +
      (metric ? '<div class="metric">' + metric + '</div>' : '') +
    '</div>'
  }).join('')

  var notes = data.incidents.concat(data.maintenances)
  document.getElementById('notes').innerHTML = notes.map(function (n) {
    var body = n.latestUpdate ? n.latestUpdate.body : (n.body || '')
    return '<div class="note"><h2>' + n.title + '</h2><p>' + body + '</p></div>'
  }).join('')
})`,
  }
}

#!/usr/bin/env node
//
// Renders a Markdown page in `docs/` to a self-contained HTML file beside it,
// and to a second copy under the web app's `public/` so the signed-in portal
// can link to it at `/docs/<page>.html`.
//
//   node scripts/build-docs.mjs                  # every page in PAGES
//   node scripts/build-docs.mjs docs/admin-guide.md
//
// Two destinations rather than one because the two readers are in different
// places. The copy beside the Markdown is for someone at a shell with the
// repository — see the last paragraph of this comment. The copy under
// `public/` is for someone signed into the admin, who has a browser and no
// checkout. Both are written by this one run from the one Markdown source, so
// neither can drift from it; hand-editing either is the only way to break that,
// and the footer of every rendered page says not to.
//
// Why a script rather than a second file written by hand: the HTML is the same
// document as the Markdown, and two copies of one document is one copy free to
// drift. The Markdown is the source; this only re-renders it.
//
// Why a renderer written here rather than a dependency: the repository has no
// Markdown library, and pulling one in — with its transitive tree, its
// advisories and its lockfile churn — to format one page is out of proportion.
// The price is that this understands a subset of Markdown and nothing more:
//
//   headings (#..####)   fenced code (```)   tables (GFM pipes, with alignment)
//   lists (- and 1., nested by indentation)  blockquotes (>)   rules (---)
//   inline: `code`  **strong**  _em_  [text](url)
//
// Anything outside that subset is emitted as a paragraph, verbatim. Written
// down here so the constraint is a known one rather than a surprise found in
// the output.
//
// The result is one file with no external request in it: styles inline, script
// inline, no font, no image, no fetch. A page an operator can read on the
// machine that is broken, from a copy on a USB stick, with no network.
//
// It did say "no script" until the sidebar and the search box landed. The rule
// that mattered was never "no script" — it was "nothing this page cannot carry
// itself", and a search that reads the document already in the reader's DOM
// carries itself. What the rule still forbids, and what search would have been
// the easy excuse for, is a CDN, a font, a web worker or a request to anything.
// With the script removed the page is still a whole document: the contents list
// is written into the HTML, and the search box is the one element that hides
// itself when nothing is there to run it.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Who each page is written for.
 *
 * The two guides are not two halves of one document — they are one product
 * described to two different people, and a reader who lands on the wrong one
 * wastes a page finding out. So the pair is declared here once and every page
 * prints the whole set at the top with its own entry marked: you can see that
 * the other reader exists, and reach them, from either page.
 *
 * This is also the list of pages rendered when the script is run with no
 * argument. A page passed on the command line that is not in this list still
 * renders — it simply gets no reader row, which is the right answer for a page
 * whose audience nobody has decided.
 */
const READERS = [
  {
    source: 'docs/admin-guide.md',
    icon: 'server',
    label: 'Operators',
    hint: 'Installing an instance and keeping it alive',
  },
  {
    source: 'docs/user-guide.md',
    icon: 'user-round',
    label: 'Everyday users',
    hint: 'Working the screens, day to day',
  },
]

const PAGES = READERS.map((reader) => reader.source)

/**
 * The second destination, served verbatim by Vite at `/docs/…` in development
 * and copied into the bundle by `vite build` for production. A directory under
 * `public/` rather than an import, because these pages are whole documents with
 * their own styles — nothing here belongs in the app's module graph.
 */
const WEB_PUBLIC_DOCS = 'apps/web/public/docs'

/**
 * Where a relative `*.md` link points once the page is HTML.
 *
 * Sibling Markdown files are not rendered — only the pages in PAGES are — so a
 * link to `./operations.md` would resolve to a file the reader does not have.
 * Sending it to the repository is the honest destination: it is where that page
 * actually lives, and it is readable.
 */
const REPO_BLOB = 'https://github.com/lelabnet-creator/ternproject/blob/main'

// ── brand ────────────────────────────────────────────────────────────────────

/**
 * The mark, drawn here rather than linked.
 *
 * `public/brand/tern-mark.svg` is the same artwork and would be one line
 * instead of six — but an `<img src>` is an external request, and the whole
 * point of these pages is that they open with no network and no neighbouring
 * files. Inline it is.
 *
 * The geometry is not free either. The logo system sheet specifies an optical
 * correction by rendered size, which `TernMark.tsx` encodes as `geometryFor`:
 * at 30px that is a 10-unit stroke and a 5-unit eye. Those two numbers are why
 * this is not simply the 40px artwork scaled down — a monoline mark reduced
 * naively goes thin and muddy, and its eye becomes a smudge.
 *
 * The viewBox stays on the system's 160 grid for the same reason it does in the
 * component: the coordinates then match the source sheet exactly.
 */
const MARK = `<svg class="mark" width="30" height="30" viewBox="0 0 160 160" fill="none" aria-hidden="true"><path d="M30 112 C19 86 30 50 62 44 C84 40 96 50 98 60 L130 66 L98 72" stroke="currentColor" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" /><circle cx="76" cy="59" r="5" fill="currentColor" /></svg>`

/**
 * Icon geometry, copied from `lucide-react` — the set the product itself draws.
 *
 * Copied rather than imported: this script has no dependencies and resolves
 * nothing out of `apps/web/node_modules`, which is what lets it run from a bare
 * checkout. The cost is that these are a snapshot. That is an acceptable cost
 * for decoration — an icon a version out of date is still the right glyph — and
 * it would not be for anything the reader has to act on.
 *
 * Same viewBox, same stroke convention, so a chapter marked `activity` here is
 * the glyph on the admin's Controls tab, not merely one like it.
 */
const ICONS = {
  server: [
    ['rect', { width: '20', height: '8', x: '2', y: '2', rx: '2', ry: '2' }],
    ['rect', { width: '20', height: '8', x: '2', y: '14', rx: '2', ry: '2' }],
    ['line', { x1: '6', x2: '6.01', y1: '6', y2: '6' }],
    ['line', { x1: '6', x2: '6.01', y1: '18', y2: '18' }],
  ],
  'user-round': [
    ['circle', { cx: '12', cy: '8', r: '5' }],
    ['path', { d: 'M20 21a8 8 0 0 0-16 0' }],
  ],
  box: [
    [
      'path',
      {
        d: 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z',
      },
    ],
    ['path', { d: 'm3.3 7 8.7 5 8.7-5' }],
    ['path', { d: 'M12 22V12' }],
  ],
  'clipboard-check': [
    ['rect', { width: '8', height: '4', x: '8', y: '2', rx: '1', ry: '1' }],
    ['path', { d: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2' }],
    ['path', { d: 'm9 14 2 2 4-4' }],
  ],
  download: [
    ['path', { d: 'M12 15V3' }],
    ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }],
    ['path', { d: 'm7 10 5 5 5-5' }],
  ],
  'sliders-horizontal': [
    ['path', { d: 'M10 5H3' }],
    ['path', { d: 'M12 19H3' }],
    ['path', { d: 'M14 3v4' }],
    ['path', { d: 'M16 17v4' }],
    ['path', { d: 'M21 12h-9' }],
    ['path', { d: 'M21 19h-5' }],
    ['path', { d: 'M21 5h-7' }],
    ['path', { d: 'M8 10v4' }],
    ['path', { d: 'M8 12H3' }],
  ],
  database: [
    ['ellipse', { cx: '12', cy: '5', rx: '9', ry: '3' }],
    ['path', { d: 'M3 5V19A9 3 0 0 0 21 19V5' }],
    ['path', { d: 'M3 12A9 3 0 0 0 21 12' }],
  ],
  'circle-arrow-up': [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'm16 12-4-4-4 4' }],
    ['path', { d: 'M12 16V8' }],
  ],
  activity: [
    [
      'path',
      {
        d: 'M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2',
      },
    ],
  ],
  radar: [
    ['path', { d: 'M19.07 4.93A10 10 0 0 0 6.99 3.34' }],
    ['path', { d: 'M4 6h.01' }],
    ['path', { d: 'M2.29 9.62A10 10 0 1 0 21.31 8.35' }],
    ['path', { d: 'M16.24 7.76A6 6 0 1 0 8.23 16.67' }],
    ['path', { d: 'M12 18h.01' }],
    ['path', { d: 'M17.99 11.66A6 6 0 0 1 15.77 16.67' }],
    ['circle', { cx: '12', cy: '12', r: '2' }],
    ['path', { d: 'm13.41 10.59 5.66-5.66' }],
  ],
  route: [
    ['circle', { cx: '6', cy: '19', r: '3' }],
    ['path', { d: 'M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15' }],
    ['circle', { cx: '18', cy: '5', r: '3' }],
  ],
  mail: [
    ['path', { d: 'm22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7' }],
    ['rect', { x: '2', y: '4', width: '20', height: '16', rx: '2' }],
  ],
  shield: [
    [
      'path',
      {
        d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
      },
    ],
  ],
  'life-buoy': [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'm4.93 4.93 4.24 4.24' }],
    ['path', { d: 'm14.83 9.17 4.24-4.24' }],
    ['path', { d: 'm14.83 14.83 4.24 4.24' }],
    ['path', { d: 'm9.17 14.83-4.24 4.24' }],
    ['circle', { cx: '12', cy: '12', r: '4' }],
  ],
  'triangle-alert': [
    ['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }],
    ['path', { d: 'M12 9v4' }],
    ['path', { d: 'M12 17h.01' }],
  ],
  'columns-2': [
    ['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }],
    ['path', { d: 'M12 3v18' }],
  ],
  'log-in': [
    ['path', { d: 'm10 17 5-5-5-5' }],
    ['path', { d: 'M15 12H3' }],
    ['path', { d: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4' }],
  ],
  compass: [
    [
      'path',
      {
        d: 'm16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z',
      },
    ],
    ['circle', { cx: '12', cy: '12', r: '10' }],
  ],
  siren: [
    ['path', { d: 'M7 18v-6a5 5 0 1 1 10 0v6' }],
    ['path', { d: 'M5 21a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2z' }],
    ['path', { d: 'M21 12h1' }],
    ['path', { d: 'M18.5 4.5 18 5' }],
    ['path', { d: 'M2 12h1' }],
    ['path', { d: 'M12 2v1' }],
    ['path', { d: 'm4.929 4.929.707.707' }],
    ['path', { d: 'M12 12v6' }],
  ],
  'calendar-clock': [
    ['path', { d: 'M16 14v2.2l1.6 1' }],
    ['path', { d: 'M16 2v4' }],
    ['path', { d: 'M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5' }],
    ['path', { d: 'M3 10h5' }],
    ['path', { d: 'M8 2v4' }],
    ['circle', { cx: '16', cy: '16', r: '6' }],
  ],
  'layout-grid': [
    ['rect', { width: '7', height: '7', x: '3', y: '3', rx: '1' }],
    ['rect', { width: '7', height: '7', x: '14', y: '3', rx: '1' }],
    ['rect', { width: '7', height: '7', x: '14', y: '14', rx: '1' }],
    ['rect', { width: '7', height: '7', x: '3', y: '14', rx: '1' }],
  ],
  'shield-check': [
    [
      'path',
      {
        d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
      },
    ],
    ['path', { d: 'm9 12 2 2 4-4' }],
  ],
  'scroll-text': [
    ['path', { d: 'M15 12h-5' }],
    ['path', { d: 'M15 8h-5' }],
    ['path', { d: 'M19 17V5a2 2 0 0 0-2-2H4' }],
    [
      'path',
      {
        d: 'M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3',
      },
    ],
  ],
  zap: [
    [
      'path',
      {
        d: 'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z',
      },
    ],
  ],
  hash: [
    ['line', { x1: '4', x2: '20', y1: '9', y2: '9' }],
    ['line', { x1: '4', x2: '20', y1: '15', y2: '15' }],
    ['line', { x1: '10', x2: '8', y1: '3', y2: '21' }],
    ['line', { x1: '16', x2: '14', y1: '3', y2: '21' }],
  ],
}

/**
 * The glyph beside each chapter, by anchor slug.
 *
 * Keyed on the slug rather than matched on words, so the mapping is exact and
 * greppable — and so a chapter that is renamed falls back to `hash` instead of
 * quietly picking up the wrong picture. A missing icon is a small loss; a
 * confident wrong one is worse than none.
 *
 * Where a chapter names something the reader can also click in the product, the
 * glyph is the one on that screen's tab. That is the whole value of these: not
 * decoration, but the same object wearing the same face in both places.
 */
const CHAPTER_ICONS = {
  // Administrator guide — the order things happen in.
  'what-an-instance-is': 'box',
  'before-you-install': 'clipboard-check',
  installing: 'download',
  configuration: 'sliders-horizontal',
  'where-the-data-lives': 'database',
  upgrading: 'circle-arrow-up',
  'watching-the-instance': 'activity',
  'the-agents': 'radar',
  'behind-a-reverse-proxy': 'route',
  'mail-and-notifications': 'mail',
  'security-and-what-is-yours-to-do': 'shield',
  'when-something-is-wrong': 'life-buoy',
  'known-limitations-that-affect-operations': 'triangle-alert',

  // User guide — one chapter per screen, and the rail's own icons.
  'the-two-halves': 'columns-2',
  'signing-in': 'log-in',
  'the-guided-tour': 'compass',
  controls: 'activity',
  'declaring-and-running-an-incident': 'siren',
  'maintenance-windows': 'calendar-clock',
  'the-page-layout': 'layout-grid',
  agents: 'radar',
  'subscribers-and-notifications': 'mail',
  badges: 'shield-check',
  logs: 'scroll-text',
}

/** The glyph for a chapter nobody has mapped. Neutral on purpose. */
const DEFAULT_CHAPTER_ICON = 'hash'

/**
 * The shortest path through each guide.
 *
 * Both of these pages are long, and both are ordered the way the work happens
 * rather than the way a first afternoon goes. That is the right order for the
 * second read and the wrong one for the first: someone who has just been handed
 * a machine wants four steps, not thirteen chapters.
 *
 * So this is a route, not a summary. Every step points into the chapter that
 * explains it and stops there — the moment a step tries to explain something it
 * becomes a second copy of the page, and the second copy is the one that goes
 * out of date.
 *
 * `code` names a section whose first fenced block is lifted into the step
 * verbatim at render time. Nothing here restates a command: the block shown is
 * the block in the document, so the two cannot disagree.
 *
 * Every `anchor` is checked against the page's real headings when it renders, and
 * an unknown one fails the build. A rename would otherwise leave the one part of
 * the page a newcomer reads first pointing at nothing.
 */
const QUICKSTART = {
  'docs/admin-guide.md': {
    goal: 'From an empty directory to a page answering, in about ten minutes.',
    steps: [
      {
        text: 'Check the machine: Docker with Compose v2, and somewhere to put a volume.',
        anchor: 'before-you-install',
      },
      {
        text: 'Run the installer in an empty directory. It asks three questions.',
        anchor: 'installing',
        code: 'installing',
      },
      {
        text: 'Open the address it prints and claim the first admin account — the window closes once somebody does.',
        anchor: 'installing',
      },
      {
        text: 'Set the public URL and the mail settings, then back up APP_SECRET somewhere that is not the database.',
        anchor: 'configuration',
      },
    ],
  },
  'docs/user-guide.md': {
    goal: 'From an account somebody handed you to a component on the public page.',
    steps: [
      { text: 'Sign in at /app/<your-page>.', anchor: 'signing-in' },
      {
        text: 'Create one control: one service, one endpoint, one nightly job.',
        anchor: 'controls',
      },
      {
        text: 'Run the script TERN hands you, or let a probe do the checking.',
        anchor: 'the-generated-scripts',
      },
      { text: 'Put it on the public page and pick the density.', anchor: 'the-page-layout' },
    ],
  },
}

/**
 * One icon as SVG.
 *
 * The geometry is stored as lucide stores it — `[tag, attributes]` — and
 * serialised generically, because the set is not all `<path>`: there are rects,
 * circles, ellipses and lines in there, and a serialiser that assumed paths
 * would silently drop half of `server` and all of `layout-grid`.
 */
function renderIcon(name, size = 18) {
  const nodes = ICONS[name]
  if (!nodes) return ''

  const children = nodes
    .map(([tag, attributes]) => {
      const written = Object.entries(attributes)
        .map(([key, value]) => `${key}="${escapeHtml(String(value))}"`)
        .join(' ')
      return `<${tag} ${written} />`
    })
    .join('')

  return (
    `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="1.75" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${children}</svg>`
  )
}

// ── inline ───────────────────────────────────────────────────────────────────

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * Rewrites a link as the HTML file needs it.
 *
 * `#anchor` and absolute URLs are left alone. A relative `.md` target becomes a
 * repository URL, fragment preserved, because that file is not published beside
 * this one.
 */
function resolveHref(href, sourceDir) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return href
  if (!href.includes('.md')) return href

  const [path, fragment] = href.split('#')
  const target = join(sourceDir, path).replace(/\\/g, '/').replace(/^\.\//, '')
  return `${REPO_BLOB}/${target}${fragment ? `#${fragment}` : ''}`
}

/**
 * Inline markup.
 *
 * Code spans are lifted out to a sentinel before anything else runs and put back
 * at the end. Splitting the string on backticks instead — the first thing that
 * comes to mind — cuts every construct that spans a code span in half: a bold
 * run around one, or a link whose label contains one, then never matches. The
 * sentinel keeps the string whole while making the code content untouchable.
 */
function renderInline(text, sourceDir) {
  const spans = []
  const held = text.replace(/`([^`]+)`/g, (_m, body) => {
    spans.push(`<code>${escapeHtml(body)}</code>`)
    return `\u0000${spans.length - 1}\u0000`
  })

  return (
    escapeHtml(held)
      .replace(
        /\[([^\]]+)\]\(([^)\s]+)\)/g,
        (_m, label, href) => `<a href="${resolveHref(href, sourceDir)}">${label}</a>`,
      )
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w])_([^_]+)_(?!\w)/g, '$1<em>$2</em>')
      // NUL stands in for an extracted code span precisely because Markdown
      // can never contain one, which is what makes it a safe placeholder.
      // eslint-disable-next-line no-control-regex
      .replace(/\u0000(\d+)\u0000/g, (_m, index) => spans[Number(index)])
  )
}

// ── blocks ───────────────────────────────────────────────────────────────────

/** A stable, readable anchor. Duplicates get a numeric suffix rather than collide. */
function slugify(text, taken) {
  const base =
    text
      .toLowerCase()
      .replace(/`/g, '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'

  let slug = base
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`
  taken.add(slug)
  return slug
}

function splitRow(line) {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function alignmentsFrom(line) {
  return splitRow(line).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return ' style="text-align:center"'
    if (right) return ' style="text-align:right"'
    return ''
  })
}

const isTableDelimiter = (line) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-')

/**
 * Lists, including nested ones.
 *
 * Indentation decides depth: two spaces per level, which is what Prettier
 * produces for this repository's Markdown. A continuation line — an indented
 * line that is not itself a bullet — joins the item above it, so a wrapped
 * sentence stays one paragraph rather than becoming a second item.
 */
function renderList(lines, index, sourceDir) {
  const items = []
  let i = index
  const first = lines[i]
  const indent = first.search(/\S/)
  const ordered = /^\s*\d+[.)]\s/.test(first)
  const marker = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/

  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      // A blank line ends the list unless the next line continues it.
      const next = lines[i + 1]
      if (next === undefined || next.search(/\S/) < indent || next.trim() === '') break
      i++
      continue
    }

    const currentIndent = line.search(/\S/)
    if (currentIndent < indent) break

    if (currentIndent === indent && marker.test(line)) {
      items.push({ text: line.replace(marker, ''), children: [] })
      i++
      continue
    }

    if (currentIndent > indent) {
      const item = items[items.length - 1]
      if (/^\s*([-*]|\d+[.)])\s/.test(line)) {
        const [html, consumed] = renderList(lines, i, sourceDir)
        item.children.push(html)
        i = consumed
      } else {
        item.text += ` ${line.trim()}`
        i++
      }
      continue
    }

    break
  }

  const tag = ordered ? 'ol' : 'ul'
  const body = items
    .map((item) => `<li>${renderInline(item.text, sourceDir)}${item.children.join('')}</li>`)
    .join('\n')

  return [`<${tag}>\n${body}\n</${tag}>`, i]
}

function renderMarkdown(markdown, sourceDir) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const html = []
  const headings = []
  const taken = new Set()
  let title = null
  let titleHtml = ''
  let i = 0

  /*
   * The first fenced block under each heading — including the headings above it.
   *
   * `open` is the stack of headings we are currently inside, so one code block
   * registers against every level that contains it: the block under "The normal
   * path" is also the first block of "Installing", which is the level the quick
   * start asks for. Recording only the innermost heading would leave a chapter
   * looking as if it had no command in it at all.
   */
  const firstCode = {}
  const open = []

  /*
   * How much of the body comes before the first chapter.
   *
   * The quick start goes between that opening and the chapters, not above it.
   * A page whose first words are step 1 has skipped saying who it is for, and
   * the sentence that says so is one line long — cheap to read, and the thing
   * that stops the wrong reader spending ten minutes on the wrong route.
   */
  let ledeLength = null

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '') {
      i++
      continue
    }

    // Fenced code. Wrapped in its own scroller so a long line moves the block
    // and never the page.
    const fence = line.match(/^\s*```(\S*)\s*$/)
    if (fence) {
      const body = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++])
      i++
      for (const section of open) {
        if (firstCode[section.id] === undefined) firstCode[section.id] = body.join('\n')
      }
      const language = fence[1] ? ` data-language="${escapeHtml(fence[1])}"` : ''
      html.push(
        `<div class="scroll-x"><pre${language}><code>${escapeHtml(
          body.join('\n'),
        )}</code></pre></div>`,
      )
      continue
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length
      const text = heading[2].trim()
      if (level === 1 && title === null) {
        // Held back rather than pushed into the body: the page's own furniture
        // — the mark, and who the page is for — goes above the title, and the
        // contents box below it. Emitting the h1 inline here would put the
        // title under its own table of contents, which is where it used to be.
        title = text.replace(/`/g, '')
        // Identified so the search can send a reader back to the opening
        // paragraphs, which are a section like any other and the only one with
        // no heading of its own to point at.
        titleHtml = `<h1 id="top">${renderInline(text, sourceDir)}</h1>`
      } else {
        const id = slugify(text, taken)
        if (level === 2 && ledeLength === null) ledeLength = html.length
        while (open.length > 0 && open[open.length - 1].level >= level) open.pop()
        open.push({ level, id })
        // Chapters only. A level-3 heading is a step inside a chapter, and a
        // glyph on every one of them turns a page into a sticker album.
        const icon = level === 2 ? (CHAPTER_ICONS[id] ?? DEFAULT_CHAPTER_ICON) : null
        if (level <= 3) headings.push({ level, id, icon, text: text.replace(/`/g, '') })
        html.push(
          `<h${level} id="${id}">${icon ? renderIcon(icon, 20) : ''}<a class="anchor" href="#${id}">${renderInline(
            text,
            sourceDir,
          )}</a></h${level}>`,
        )
      }
      i++
      continue
    }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      html.push('<hr />')
      i++
      continue
    }

    // Table: a pipe row followed by a delimiter row. Without the delimiter it is
    // prose that happens to contain a pipe, and treating it as a table would be
    // the worse guess.
    if (line.includes('|') && isTableDelimiter(lines[i + 1] ?? '')) {
      const alignments = alignmentsFrom(lines[i + 1])
      const head = splitRow(line)
      i += 2

      const body = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        body.push(splitRow(lines[i]))
        i++
      }

      const headRow = head
        .map((cell, n) => `<th${alignments[n] ?? ''}>${renderInline(cell, sourceDir)}</th>`)
        .join('')
      const bodyRows = body
        .map(
          (row) =>
            `<tr>${row
              .map((cell, n) => `<td${alignments[n] ?? ''}>${renderInline(cell, sourceDir)}</td>`)
              .join('')}</tr>`,
        )
        .join('\n')

      html.push(
        `<div class="scroll-x"><table>\n<thead><tr>${headRow}</tr></thead>\n<tbody>\n${bodyRows}\n</tbody>\n</table></div>`,
      )
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const body = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      html.push(`<blockquote>${renderInline(body.join(' '), sourceDir)}</blockquote>`)
      continue
    }

    if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
      const [listHtml, consumed] = renderList(lines, i, sourceDir)
      html.push(listHtml)
      i = consumed
      continue
    }

    // Paragraph: everything up to a blank line or the start of another block.
    const paragraph = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^\s*(#{1,4}\s|```|>|---+\s*$)/.test(lines[i]) &&
      !/^\s*([-*]|\d+[.)])\s+/.test(lines[i])
    ) {
      paragraph.push(lines[i].trim())
      i++
    }
    html.push(`<p>${renderInline(paragraph.join(' '), sourceDir)}</p>`)
  }

  const cut = ledeLength ?? html.length
  return {
    lede: html.slice(0, cut).join('\n\n'),
    body: html.slice(cut).join('\n\n'),
    headings,
    title,
    titleHtml,
    firstCode,
    ids: taken,
  }
}

// ── page ─────────────────────────────────────────────────────────────────────

/**
 * Both themes, and both signals.
 *
 * `prefers-color-scheme` covers a reader who never touches anything. The colours
 * are named once as custom properties so the dark block overrides values rather
 * than repeating rules.
 */
const STYLES = `
:root {
  color-scheme: light dark;

  /* The marque's own three, from the logo system sheet and identical to the
     values in the product's tokens.css. Fixed in both themes: they are the
     brand's colours and they mean the same thing in the dark. */
  --brand-ink: #0d2a3f;
  --brand-paper: #edf2f5;
  --brand-accent: #f2653c;

  /* Everything else is derived from the ink's hue, which is what stops this
     page from being a generic document that happens to carry a logo. The greys
     the page used before were warm and belonged to nothing. */
  --bg: var(--brand-paper);
  --surface: #ffffff;
  --text: var(--brand-ink);
  --muted: #5a7183;
  --rule: #d3dee5;
  /* 6.4:1 on paper. The link colour cannot be the coral: that sits within a few
     ΔE of the product's \`partial\` status orange, and this page documents a
     status page — see the note in tokens.css. The coral appears once, as the
     rule across the top, where nothing can read it as a service state. */
  --accent: #175a86;
  --chip: var(--brand-ink);
  --code-bg: #e3eaef;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1a24;
    --surface: #132635;
    --text: #dfe8ee;
    --muted: #90a4b3;
    --rule: #24384a;
    --accent: #79bbe4;
    /* Not the ink itself: against this background it would be a filled chip
       with no visible edge. Two steps up the same hue keeps the shape. */
    --chip: #1f4560;
    --code-bg: #16293a;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  padding: 0;
  /* The one place the coral is spent. A 3px rule across the top of the page:
     unmistakably the brand, and not a word of text, so it cannot be misread. */
  border-top: 3px solid var(--brand-accent);
  background: var(--bg);
  color: var(--text);
  font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
        "Helvetica Neue", Arial, sans-serif;
  overflow-wrap: break-word;
}

/*
 * One column until there is room for two.
 *
 * Stacked, the order is the reading order — mark, guide, search, contents, then
 * the document — which is also the order a screen reader takes and the order it
 * prints in. The wide layout only moves that first group into a column beside
 * the text; nothing is added, removed or re-ordered for it, so there is one
 * document and not two.
 */
.shell { max-width: 76rem; margin: 0 auto; padding: 2.25rem 1.25rem 5rem; }
main { max-width: 46rem; }

@media (min-width: 64rem) {
  .shell {
    display: grid;
    grid-template-columns: 17rem minmax(0, 1fr);
    gap: 3.5rem;
    /* Or the sidebar stretches to the length of the document and its sticky
       position has nothing left to travel through. */
    align-items: start;
  }
  .sidebar {
    position: sticky;
    top: 2.25rem;
    /* Its own scroller. A contents list longer than the window is the normal
       case here, and a sidebar that clips it silently is worse than one that
       scrolls. */
    max-height: calc(100dvh - 4.5rem);
    overflow-y: auto;
    /* Room for the scrollbar so it never sits on the words. */
    padding-right: 0.5rem;
  }
}

/* Deep-linked headings land clear of the top edge rather than flush against
   it, which is where \`scrollIntoView\` and a plain \`#anchor\` both put them. */
h1[id], h2[id], h3[id], h4[id] { scroll-margin-top: 1.5rem; }

h1, h2, h3, h4 { line-height: 1.25; font-weight: 650; }
h1 { font-size: 2rem; margin: 0 0 1.25rem; letter-spacing: -0.02em; }
h2 {
  display: flex;
  align-items: center;
  /* The glyph and the first letter are two flex children with nothing between
     them otherwise. Same distance the admin's rail uses for the same pairing. */
  gap: 0.6rem;
  font-size: 1.4rem;
  margin: 3.25rem 0 1rem;
  padding-top: 1.25rem;
  border-top: 1px solid var(--rule);
}
h3 { font-size: 1.1rem; margin: 2.25rem 0 0.75rem; }
h4 { font-size: 1rem; margin: 1.75rem 0 0.5rem; color: var(--muted); }
p, ul, ol, blockquote { margin: 0 0 1rem; }
li { margin: 0.35rem 0; }
li > ul, li > ol { margin: 0.35rem 0 0.35rem; }
a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }
a.anchor { color: inherit; text-decoration: none; }
a.anchor:hover { text-decoration: underline; text-decoration-color: var(--rule); }
hr { border: 0; border-top: 1px solid var(--rule); margin: 2.5rem 0; }
code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.875em;
  background: var(--code-bg);
  border-radius: 4px;
  padding: 0.12em 0.35em;
}
pre {
  margin: 0;
  padding: 0.9rem 1rem;
  background: var(--code-bg);
  border: 1px solid var(--rule);
  border-radius: 6px;
}
pre code { background: none; padding: 0; font-size: 0.83rem; line-height: 1.55; }
blockquote {
  margin-left: 0;
  padding: 0.1rem 0 0.1rem 1rem;
  border-left: 3px solid var(--rule);
  color: var(--muted);
}
/* Wide content scrolls inside its own box. The page itself never does. */
.scroll-x { overflow-x: auto; margin: 0 0 1.25rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
th, td {
  text-align: left;
  vertical-align: top;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--rule);
}
th { font-weight: 600; white-space: nowrap; }
tbody tr:last-child td { border-bottom: 0; }
/* ── Brand ─────────────────────────────────────────────────────────────────── */

.masthead {
  display: flex;
  /* Stacked rather than spread: in a 17rem column there is no width to spread
     across, and the same stack reads correctly at every other size. */
  flex-direction: column;
  align-items: flex-start;
  gap: 0.4rem;
  margin: 0 0 1.5rem;
  padding-bottom: 1.25rem;
  border-bottom: 1px solid var(--rule);
}
.lockup { display: inline-flex; align-items: center; color: var(--text);
  /* 0.28 × the mark, which is the ratio the lockup is set at on the system
     sheet and what TernWordmark computes for every other placement. */
  gap: 8.4px; }
.mark { flex: none; }
.wordmark {
  /* A neutral grotesque, as the sheet sets it — never the monospace, which in
     this product belongs to numbers and timestamps rather than to the name. */
  font-family: Helvetica, Arial, system-ui, sans-serif;
  font-weight: 500;
  letter-spacing: -0.018em;
  font-size: 25.5px;
  line-height: 1;
}
.eyebrow {
  margin: 0;
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--muted);
}

.readers { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0 0 1.25rem; }
.reader {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.4rem 0.8rem;
  border: 1px solid var(--rule);
  border-radius: 999px;
  background: var(--surface);
  color: var(--muted);
  font-size: 0.85rem;
  font-weight: 600;
  text-decoration: none;
}
a.reader:hover { color: var(--text); border-color: var(--accent); }
/* Filled, not merely tinted: which guide you are reading is the one thing this
   row exists to say, and colour alone would say it to fewer readers. */
.reader.is-current { background: var(--chip); border-color: var(--chip); color: #ffffff; }

.icon { flex: none; }
h2 > .icon { color: var(--accent); }

/* ── Quick start ───────────────────────────────────────────────────────────── */

/* The one chapter heading with no rule above it. Every other h2 is separated
   from what came before; this one belongs to the title it sits under. */
.quickstart-heading {
  margin: 2rem 0 0.75rem;
  padding-top: 0;
  border-top: 0;
  font-size: 1.2rem;
}
.quickstart {
  margin: 0 0 3rem;
  padding: 1.25rem 1.5rem 1.25rem 1.25rem;
  background: var(--surface);
  border: 1px solid var(--rule);
  /* The edge that says this is a route and not a chapter. The accent rather
     than the coral: the coral is the page's one brand mark and stays that. */
  border-left: 3px solid var(--accent);
  border-radius: 8px;
}
.quickstart-goal { margin: 0 0 1rem; color: var(--muted); font-size: 0.92rem; }
.quickstart ol {
  margin: 0;
  /* Room for a two-digit marker without the text stepping right for it. */
  padding-left: 1.4rem;
}
.quickstart li { margin: 0 0 1rem; }
.quickstart li:last-child { margin-bottom: 0; }
.quickstart li::marker { color: var(--muted); font-weight: 600; font-size: 0.9rem; }
.step-text { margin: 0; }
.quickstart .scroll-x { margin: 0.5rem 0 0.4rem; }
.quickstart pre { font-size: 0.95em; }
/* Deliberately quiet, and deliberately last in the step: the sentence is the
   instruction, and this is only where the instruction is explained. */
.step-link {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  margin-top: 0.15rem;
  font-size: 0.82rem;
  color: var(--muted);
  text-decoration: none;
}
.step-link:hover { color: var(--accent); text-decoration: underline; }

/* Present to a screen reader, absent to the eye. Used for the search field's
   label, which the placeholder only looks like it replaces. */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* ── Search ────────────────────────────────────────────────────────────────── */

/* Hidden in the markup and revealed by the script. A search box that stays on
   the page when nothing can run it is a control that swallows what you type. */
.search { margin: 0 0 1.25rem; }
.search input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--rule);
  border-radius: var(--radius, 8px);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 0.9rem;
}
.search input::placeholder { color: var(--muted); }
.search input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.results { margin: 0 0 2rem; font-size: 0.9rem; }
.results-count {
  margin: 0 0 0.5rem;
  font-size: 0.78rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.results ol { list-style: none; margin: 0; padding: 0; }
.results li { margin: 0 0 0.15rem; }
.results li a {
  display: block;
  padding: 0.45rem 0.6rem;
  border-radius: 6px;
  color: inherit;
  text-decoration: none;
}
.results li a:hover, .results li a:focus-visible { background: var(--surface); }
.result-title { display: block; font-weight: 600; color: var(--accent); }
.result-snippet {
  display: block;
  margin-top: 0.1rem;
  color: var(--muted);
  font-size: 0.83rem;
  line-height: 1.5;
}
.results mark {
  /* The chip colour at a tenth, so the hit is visible without the yellow
     highlighter a browser gives \`mark\` by default — which on this page's paper
     reads as a warning rather than as a match. */
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: inherit;
  border-radius: 2px;
  padding: 0 0.1em;
}
.results-other { margin: 0.75rem 0 0; font-size: 0.83rem; }

/* ── Contents ──────────────────────────────────────────────────────────────── */

nav.toc { font-size: 0.92rem; }
nav.toc p { margin: 0 0 0.5rem; font-weight: 600; font-size: 0.78rem;
  text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
nav.toc ol { list-style: none; margin: 0; padding: 0; }
nav.toc li { margin: 0; }
nav.toc a {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.25rem 0.6rem;
  /* The rail the reading position moves down. Transparent until it is yours,
     so the list has one edge rather than twenty-four. */
  border-left: 2px solid transparent;
  color: var(--muted);
  text-decoration: none;
}
nav.toc a:hover { color: var(--text); }
/* Where you are. Weight and a solid edge, never colour alone. */
nav.toc a.is-current { color: var(--text); font-weight: 600; border-left-color: var(--accent); }
nav.toc a.is-current .icon { color: var(--accent); }
nav.toc .icon { color: var(--muted); }
/* 16px of glyph plus the 0.45rem gap, so a sub-heading's first letter lands
   under its chapter's first letter rather than under its icon. */
nav.toc li.level-3 a { padding-left: 2.05rem; font-size: 0.88rem; }

/* Stacked, the contents come before the document, and a full chapter list is a
   screenful to scroll past before reaching the first word. Capped and scrolled,
   it is a box you can skim or skip. The wide layout removes the cap: there the
   sidebar has a column to itself and its own scroller. */
@media (max-width: 63.999rem) {
  nav.toc { max-height: 40vh; overflow-y: auto; }
  .sidebar { margin: 0 0 2.5rem; }
}

footer {
  max-width: 46rem;
  margin: 4rem 0 0;
  padding-top: 1.25rem;
  border-top: 1px solid var(--rule);
  color: var(--muted);
  font-size: 0.85rem;
}
`.trim()

function renderTableOfContents(headings) {
  if (headings.length === 0) return ''
  const items = headings
    .map(
      (heading) =>
        `<li class="level-${heading.level}"><a href="#${heading.id}">${
          // The same glyph the chapter itself carries, so the contents box reads
          // as a map of the page rather than a second, unrelated list of words.
          heading.icon ? renderIcon(heading.icon, 16) : ''
        }${escapeHtml(heading.text)}</a></li>`,
    )
    .join('\n')
  return `<nav class="toc"><p>On this page</p>\n<ol>\n${items}\n</ol></nav>`
}

/**
 * Search, and the reading position in the contents.
 *
 * The index is the document. There is no build-time index embedded in the page
 * and no fetch for one: the whole text is already in the DOM by the time this
 * runs, so the script walks it once at load and searches what it finds. That is
 * why the page can be searched from a USB stick, and why adding a chapter to
 * the Markdown adds it to the search with no second step to forget.
 *
 * Its limit is the honest counterpart: one page is one corpus. Rather than
 * pretend otherwise, a query offers a link to the same query on the other
 * guide — `?q=`, which this script reads on load. Cross-guide search for the
 * cost of a query string, instead of every page carrying every other page.
 *
 * `String.raw` so the regular expressions below survive being written inside a
 * template literal: without it `\s` is an escape this file's parser eats before
 * the browser ever sees it.
 *
 * Which cuts both ways, and did. Escapes in here take ONE backslash, not two.
 * A doubled one reaches the browser as a literal backslash, so the diacritic
 * class in the fold below became a range running from "0" to the backslash
 * character — which quietly contains every capital letter. Case folding then
 * stopped folding capitals: searching for "Quick" found nothing while "uick"
 * found it. A doubled escape in here does not fail loudly; it silently changes
 * what the pattern means.
 */
const SCRIPT = String.raw`
(() => {
  const main = document.querySelector('main')
  const toc = document.querySelector('nav.toc')
  const form = document.querySelector('.search')
  const input = form && form.querySelector('input')
  const panel = document.querySelector('.results')
  if (!main || !toc || !form || !input || !panel) return

  // Nothing above this line touched the page. From here the script is running,
  // so the control it drives may appear.
  form.hidden = false

  /*
   * Case- and accent-folded, one output character per input character.
   *
   * The one-to-one part is load-bearing: an offset found in the folded text is
   * used to slice the original when highlighting, and a fold that changed
   * length — 'ß' to 'ss', say — would underline the wrong letters a little
   * further along every line. Any character whose fold is not a single
   * character is left exactly as it was.
   */
  const fold = (text) => {
    let out = ''
    for (let i = 0; i < text.length; i++) {
      const folded = text[i].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      out += folded.length === 1 ? folded : text[i]
    }
    return out
  }

  // ── The index: whatever the document turned out to be ──────────────────────

  /*
   * Like textContent, but with a space where one block ends and the next
   * begins.
   *
   * textContent alone welds them: two table cells reading "APP_SECRET" and
   * "Read by the entrypoint" come back as "APP_SECRETRead by the entrypoint",
   * and that word appears in a snippet exactly as glued. Inline elements are
   * deliberately not separated — a code span in the middle of a sentence is
   * part of that sentence, and spacing it out would break a phrase search
   * across it.
   */
  const BLOCK = /^(P|DIV|PRE|BLOCKQUOTE|UL|OL|LI|TABLE|THEAD|TBODY|TR|TD|TH|DL|DT|DD|H4|HR)$/
  const textOf = (node) => {
    let out = ''
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) out += child.nodeValue
      else if (child.nodeType === Node.ELEMENT_NODE) {
        out += textOf(child)
        if (BLOCK.test(child.tagName)) out += ' '
      }
    }
    return out
  }

  const sections = []
  let current = null
  for (const node of main.children) {
    if (/^H[123]$/.test(node.tagName)) {
      current = { id: node.id, title: node.textContent.trim(), body: '' }
      sections.push(current)
    } else if (current && node.tagName !== 'FOOTER') {
      // Everything under a heading belongs to it, tables and code included: the
      // environment variable someone is hunting for is in a table cell, not in
      // a sentence.
      current.body += ' ' + textOf(node) + ' '
    }
  }
  for (const section of sections) {
    section.text = section.body.replace(/\s+/g, ' ').trim()
    section.foldedTitle = fold(section.title)
    section.folded = fold(section.title + ' ' + section.text)
  }

  // ── Matching ───────────────────────────────────────────────────────────────

  /* Every term must appear, anywhere in the section. Substring rather than
     whole-word because half of what is looked up here is a fragment of an
     identifier — "APP_SEC", "docker comp" — and a word-boundary match finds
     neither. Sections whose heading matches sort first; the sort is stable, so
     everything else stays in the order the page reads. */
  const matches = (terms) =>
    sections
      .filter((section) => terms.every((term) => section.folded.includes(term)))
      .map((section) => ({
        section,
        score: terms.filter((term) => section.foldedTitle.includes(term)).length,
      }))
      .sort((a, b) => b.score - a.score)

  /** The window of text around the earliest hit, with an ellipsis where cut. */
  const excerpt = (section, terms) => {
    const folded = fold(section.text)
    let at = -1
    for (const term of terms) {
      const found = folded.indexOf(term)
      if (found !== -1 && (at === -1 || found < at)) at = found
    }
    if (at === -1) return section.text.slice(0, 150)
    const from = Math.max(0, at - 50)
    const to = Math.min(section.text.length, from + 170)
    return (from > 0 ? '…' : '') + section.text.slice(from, to) + (to < section.text.length ? '…' : '')
  }

  /* Built as nodes rather than as a string of HTML. The text being marked up
     here is the reader's query crossed with the document, and assembling that
     into innerHTML is how a search box becomes an injection. */
  const highlight = (text, terms) => {
    const folded = fold(text)
    const spans = []
    for (const term of terms) {
      let at = folded.indexOf(term)
      while (at !== -1) {
        spans.push([at, at + term.length])
        at = folded.indexOf(term, at + term.length)
      }
    }
    spans.sort((a, b) => a[0] - b[0])

    const fragment = document.createDocumentFragment()
    let at = 0
    for (const [start, end] of spans) {
      if (start < at) continue // an overlap already covered by the previous mark
      fragment.append(text.slice(at, start))
      const mark = document.createElement('mark')
      mark.textContent = text.slice(start, end)
      fragment.append(mark)
      at = end
    }
    fragment.append(text.slice(at))
    return fragment
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  const otherGuide = document.querySelector('a.reader')

  const draw = (query) => {
    const terms = fold(query).split(/\s+/).filter(Boolean)
    panel.replaceChildren()

    if (terms.length === 0) {
      panel.hidden = true
      toc.hidden = false
      return
    }

    // The contents and the results are the same piece of furniture in two
    // states. Showing both would push the results below a list the reader has
    // just stopped using.
    toc.hidden = true
    panel.hidden = false

    const found = matches(terms)

    const count = document.createElement('p')
    count.className = 'results-count'
    count.textContent =
      found.length === 0
        ? 'Nothing on this page'
        : found.length + (found.length === 1 ? ' result' : ' results')
    panel.append(count)

    const list = document.createElement('ol')
    for (const { section } of found) {
      const item = document.createElement('li')
      const link = document.createElement('a')
      link.href = '#' + section.id

      const title = document.createElement('span')
      title.className = 'result-title'
      title.append(highlight(section.title, terms))

      const snippet = document.createElement('span')
      snippet.className = 'result-snippet'
      snippet.append(highlight(excerpt(section, terms), terms))

      link.append(title, snippet)
      item.append(link)
      list.append(item)
    }
    panel.append(list)

    if (otherGuide) {
      const line = document.createElement('p')
      line.className = 'results-other'
      const link = document.createElement('a')
      link.href = otherGuide.getAttribute('href') + '?q=' + encodeURIComponent(query)
      link.textContent = 'Also search: ' + otherGuide.textContent.trim()
      line.append(link)
      panel.append(line)
    }
  }

  // ── Going there ────────────────────────────────────────────────────────────

  /* Moving the keyboard and the screen reader to the heading, not only the
     viewport. A result that scrolls the page and leaves focus in the search box
     has moved the sighted reader and nobody else. A tabindex of -1 makes a
     heading focusable without putting it in the tab order. */
  const goTo = (id) => {
    const target = document.getElementById(id)
    if (!target) return
    target.setAttribute('tabindex', '-1')
    target.focus({ preventScroll: true })
    target.scrollIntoView({ block: 'start' })
  }

  panel.addEventListener('click', (event) => {
    const link = event.target.closest('a[href^="#"]')
    if (!link) return
    event.preventDefault()
    goTo(decodeURIComponent(link.hash.slice(1)))
  })

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const first = panel.querySelector('li a[href^="#"]')
    if (first) goTo(decodeURIComponent(first.hash.slice(1)))
  })

  input.addEventListener('input', () => draw(input.value))

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    input.value = ''
    draw('')
  })

  // The shortcut every documentation site has trained readers to try. Ignored
  // while they are typing somewhere else, which is the whole reason it needs a
  // guard rather than a bare listener.
  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
    const active = document.activeElement
    if (active && (active.tagName === 'INPUT' || active.isContentEditable)) return
    event.preventDefault()
    input.focus()
    input.select()
  })

  // ── The reading position ───────────────────────────────────────────────────

  const links = new Map()
  for (const link of toc.querySelectorAll('a[href^="#"]')) {
    links.set(decodeURIComponent(link.hash.slice(1)), link)
  }
  const anchors = [...main.querySelectorAll('h2[id], h3[id]')]

  /* The last heading that has passed the top of the window, not the first one
     visible in it: while you read the body of a chapter its own heading is
     already off screen above you, and marking the next one would tell you where
     you are about to be. */
  let scheduled = false
  const spy = () => {
    scheduled = false
    let currentId = null
    for (const heading of anchors) {
      if (heading.getBoundingClientRect().top > 120) break
      currentId = heading.id
    }
    for (const [id, link] of links) link.classList.toggle('is-current', id === currentId)
  }
  addEventListener(
    'scroll',
    () => {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(spy)
    },
    { passive: true },
  )
  spy()

  // ── Arriving with a query ──────────────────────────────────────────────────

  const asked = new URLSearchParams(location.search).get('q')
  if (asked) {
    input.value = asked
    draw(asked)
    input.focus()
  }
})()
`.trim()

/**
 * The route, rendered above the document it routes through.
 *
 * A heading and a card as siblings rather than a heading nested inside one, so
 * the block is a section like any other to everything that walks this page:
 * the search indexes it, the contents list it, the reading position marks it.
 * A card with the heading tucked inside would be invisible to all three.
 */
function renderQuickStart(source, { firstCode, ids, headings }) {
  const plan = QUICKSTART[source]
  if (!plan) return ''

  const steps = plan.steps
    .map(({ text, anchor, code }, index) => {
      if (!ids.has(anchor)) {
        throw new Error(
          `${source}: quick-start step ${index + 1} points at "#${anchor}", which is not a heading on this page. ` +
            `Rename the step's anchor in QUICKSTART, or restore the heading.`,
        )
      }
      if (code !== undefined && firstCode[code] === undefined) {
        throw new Error(
          `${source}: quick-start step ${index + 1} asks for the first code block under "#${code}", and that section has none.`,
        )
      }

      const target = headings.find((heading) => heading.id === anchor)
      const label = target ? target.text : anchor
      const block =
        code === undefined
          ? ''
          : `<div class="scroll-x"><pre><code>${escapeHtml(firstCode[code])}</code></pre></div>`

      return `<li>
  <p class="step-text">${escapeHtml(text)}</p>
  ${block}
  <a class="step-link" href="#${anchor}">${
    target && target.icon ? renderIcon(target.icon, 14) : ''
  }${escapeHtml(label)}</a>
</li>`
    })
    .join('\n')

  return `<h2 id="quick-start" class="quickstart-heading">${renderIcon('zap', 20)}<a class="anchor" href="#quick-start">Quick start</a></h2>
<div class="quickstart">
  <p class="quickstart-goal">${escapeHtml(plan.goal)}</p>
  <ol>
${steps}
  </ol>
</div>`
}

/** The field, and the box the results land in. Both inert without the script. */
function renderSearch() {
  return `<form class="search" role="search" hidden>
  <label class="sr-only" for="docs-search">Search this guide</label>
  <input id="docs-search" type="search" placeholder="Search this guide" title="Press / to search"
         autocomplete="off" autocorrect="off" spellcheck="false" />
</form>
<div class="results" aria-live="polite" hidden></div>`
}

/** The lockup: mark, name, and what this page is one of. */
function renderMasthead() {
  return `<header class="masthead">
  <span class="lockup">${MARK}<span class="wordmark">tern</span></span>
  <p class="eyebrow">Documentation</p>
</header>`
}

/**
 * Who this page is for, and who the other page is for.
 *
 * Both entries always render; only the current one is marked. A row that showed
 * the reader nothing but their own label would answer "am I in the right
 * place?" with "yes" and leave "then where is the other?" unanswered — which is
 * the question someone on the wrong page is actually asking.
 */
function renderReaders(source) {
  if (!READERS.some((reader) => reader.source === source)) return ''

  const items = READERS.map((reader) => {
    const current = reader.source === source
    const label = `${renderIcon(reader.icon, 17)}<span>${escapeHtml(reader.label)}</span>`
    // A span, not a link to itself: `aria-current` says which one you are on,
    // and a link that reloads the page you are already reading is a trap.
    return current
      ? `<span class="reader is-current" aria-current="page" title="${escapeHtml(reader.hint)}">${label}</span>`
      : `<a class="reader" href="./${basename(reader.source, '.md')}.html" title="${escapeHtml(
          reader.hint,
        )}">${label}</a>`
  }).join('\n')

  return `<nav class="readers" aria-label="Guides">\n${items}\n</nav>`
}

function renderPage({ title, titleHtml, lede, body, headings, source, firstCode, ids }) {
  const quickStart = renderQuickStart(source, { firstCode, ids, headings })

  // First in the contents because it is first on the page, and because the
  // reader who needs it most is the one who has not learned the chapter names
  // yet. Prepended here rather than in renderMarkdown: it is not a heading the
  // Markdown wrote, and the Markdown's own list should stay what the Markdown
  // says.
  const listed = quickStart
    ? [{ level: 2, id: 'quick-start', icon: 'zap', text: 'Quick start' }, ...headings]
    : headings

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="generator" content="scripts/build-docs.mjs" />
    <title>${escapeHtml(title)} — TERN</title>
    <style>
${STYLES}
    </style>
  </head>
  <body>
    <div class="shell">
      <aside class="sidebar">
${renderMasthead()}
${renderReaders(source)}
${renderSearch()}
${renderTableOfContents(listed)}
      </aside>
      <main>
${titleHtml}
${lede}
${quickStart}
${body}
        <footer>
          Rendered from <code>${escapeHtml(source)}</code> by
          <code>scripts/build-docs.mjs</code>. Edit the Markdown, not this file.
        </footer>
      </main>
    </div>
    <script>
${SCRIPT}
    </script>
  </body>
</html>
`
}

// ── entry ────────────────────────────────────────────────────────────────────

async function build(relativePath) {
  const source = relativePath.replace(/\\/g, '/')
  const markdown = await readFile(join(ROOT, source), 'utf8')
  const { lede, body, headings, title, titleHtml, firstCode, ids } = renderMarkdown(
    markdown,
    dirname(source),
  )

  const html = renderPage({
    title: title ?? basename(source, '.md'),
    titleHtml,
    lede,
    body,
    headings,
    source,
    firstCode,
    ids,
  })

  const sibling = source.replace(/\.md$/, '.html')
  const published = `${WEB_PUBLIC_DOCS}/${basename(source, '.md')}.html`

  await mkdir(join(ROOT, WEB_PUBLIC_DOCS), { recursive: true })
  await Promise.all([
    writeFile(join(ROOT, sibling), html, 'utf8'),
    writeFile(join(ROOT, published), html, 'utf8'),
  ])
  return [sibling, published]
}

const requested = process.argv.slice(2)
for (const page of requested.length > 0 ? requested : PAGES) {
  for (const out of await build(page)) console.warn(`→ ${out}`)
}

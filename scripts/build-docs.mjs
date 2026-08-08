#!/usr/bin/env node
//
// Renders a Markdown page in `docs/` to a self-contained HTML file beside it.
//
//   node scripts/build-docs.mjs                  # every page in PAGES
//   node scripts/build-docs.mjs docs/admin-guide.md
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
// The result is one file with no external request in it: styles inline, no
// font, no script, no image. A page an operator can read on the machine that is
// broken, from a copy on a USB stick, with no network.

import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Pages rendered when the script is run with no argument. */
const PAGES = ['docs/admin-guide.md', 'docs/user-guide.md']

/**
 * Where a relative `*.md` link points once the page is HTML.
 *
 * Sibling Markdown files are not rendered — only the pages in PAGES are — so a
 * link to `./operations.md` would resolve to a file the reader does not have.
 * Sending it to the repository is the honest destination: it is where that page
 * actually lives, and it is readable.
 */
const REPO_BLOB = 'https://github.com/lelabnet-creator/ternproject/blob/main'

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

  return escapeHtml(held)
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_m, label, href) => `<a href="${resolveHref(href, sourceDir)}">${label}</a>`,
    )
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])_([^_]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/\u0000(\d+)\u0000/g, (_m, index) => spans[Number(index)])
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
  let i = 0

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
        title = text.replace(/`/g, '')
        html.push(`<h1>${renderInline(text, sourceDir)}</h1>`)
      } else {
        const id = slugify(text, taken)
        if (level <= 3) headings.push({ level, id, text: text.replace(/`/g, '') })
        html.push(
          `<h${level} id="${id}"><a class="anchor" href="#${id}">${renderInline(
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

  return { body: html.join('\n\n'), headings, title }
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
  --bg: #fbfbfa;
  --surface: #ffffff;
  --text: #1c1c1a;
  --muted: #5f6360;
  --rule: #e2e2de;
  --accent: #1f6f5c;
  --code-bg: #f2f2ef;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16181a;
    --surface: #1c1f21;
    --text: #e6e7e4;
    --muted: #9aa09c;
    --rule: #2e3234;
    --accent: #6fc0a6;
    --code-bg: #232729;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  padding: 3rem 1.25rem 6rem;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
        "Helvetica Neue", Arial, sans-serif;
  overflow-wrap: break-word;
}
main { max-width: 46rem; margin: 0 auto; }
h1, h2, h3, h4 { line-height: 1.25; font-weight: 650; }
h1 { font-size: 2rem; margin: 0 0 1.5rem; letter-spacing: -0.02em; }
h2 {
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
nav.toc {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 8px;
  padding: 1rem 1.25rem;
  margin: 0 0 2.5rem;
  font-size: 0.92rem;
}
nav.toc p { margin: 0 0 0.5rem; font-weight: 600; font-size: 0.8rem;
  text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
nav.toc ol { list-style: none; margin: 0; padding: 0; }
nav.toc li { margin: 0.2rem 0; }
nav.toc li.level-3 { padding-left: 1.1rem; font-size: 0.88rem; }
footer {
  max-width: 46rem;
  margin: 4rem auto 0;
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
        `<li class="level-${heading.level}"><a href="#${heading.id}">${escapeHtml(
          heading.text,
        )}</a></li>`,
    )
    .join('\n')
  return `<nav class="toc"><p>On this page</p>\n<ol>\n${items}\n</ol></nav>`
}

function renderPage({ title, body, headings, source }) {
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
    <main>
${renderTableOfContents(headings)}
${body}
    </main>
    <footer>
      Rendered from <code>${escapeHtml(source)}</code> by
      <code>scripts/build-docs.mjs</code>. Edit the Markdown, not this file.
    </footer>
  </body>
</html>
`
}

// ── entry ────────────────────────────────────────────────────────────────────

async function build(relativePath) {
  const source = relativePath.replace(/\\/g, '/')
  const markdown = await readFile(join(ROOT, source), 'utf8')
  const { body, headings, title } = renderMarkdown(markdown, dirname(source))

  const out = source.replace(/\.md$/, '.html')
  await writeFile(
    join(ROOT, out),
    renderPage({ title: title ?? basename(source, '.md'), body, headings, source }),
    'utf8',
  )
  return out
}

const requested = process.argv.slice(2)
for (const page of requested.length > 0 ? requested : PAGES) {
  const out = await build(page)
  console.warn(`→ ${out}`)
}

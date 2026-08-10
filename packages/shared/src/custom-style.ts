/**
 * The stylesheet a `custom` page starts from.
 *
 * ── Why this exists as a starting point rather than a blank box ──────────────
 *
 * The same reason its predecessor did. `custom` used to hand the page over
 * entirely — a document of HTML, CSS and script rendered in a sandboxed frame —
 * and an empty box asked an operator to write a dashboard, a data bridge and a
 * stylesheet from nothing to find out whether the mode was worth using.
 * Modifying something that already works is a different task, and a far smaller
 * one.
 *
 * ── Why it is only CSS now ──────────────────────────────────────────────────
 *
 * Because the other half of the request turned out to be the block canvas. The
 * document mode existed to answer two questions — "put this where I want it"
 * and "make it look like us" — and the first one is answered better by blocks:
 * they draw the real component widgets, they are keyboard-reachable, and they
 * are the page rather than a rectangle embedded in it. What was left was the
 * styling, and styling does not need a sandbox to be styling. See
 * `apps/web/src/routes/public/TenantStyle.tsx` for the rest of that reasoning.
 *
 * ── What it demonstrates, on purpose ────────────────────────────────────────
 *
 * The `data-tern` selector contract — the one thing nobody can guess, and the
 * one thing that will not move under them when the markup inside a block is
 * refactored. The rest is ordinary CSS against the page's own custom
 * properties, which is what makes a tenant's palette a four-line change rather
 * than a rewrite.
 *
 * Status stays a word before it is a colour: nothing here removes a label to
 * leave a hue behind. That is the rule the rest of the product follows, and an
 * example is where a rule gets copied from.
 */

/**
 * `pageName` is filled into a comment: the first line anybody reads should say
 * which page they are editing, and an example that opens on somebody else's
 * company name feels like it was meant for a different product.
 */
export function starterStylesheet(pageName = 'Status'): string {
  return `/* ${pageName} — this stylesheet applies to your public page.
   The Design tab decides what is on the page and where; this decides how it
   looks. Every block is addressable by what it is: */

/* [data-tern="page"]        the page itself
   [data-tern="header"]      your logo and the page name
   [data-tern="pulse"]       the status ring
   [data-tern="subscribe"]   the subscribe box
   [data-tern="incidents"]   incidents and maintenance notes
   [data-tern="components"]  the component cards
   [data-tern="arrangement"] the grid your blocks sit on             */

/* The palette. These are the page's own variables, so changing them here
   restyles every card, border and label at once rather than one by one. */
[data-tern='page'] {
  --color-accent: #2f6feb;
  --radius-md: 14px;
}

/* Your own width. The page is 72rem by default, which is right for a laptop
   and narrow for a wall display. */
[data-tern='page'] {
  max-width: 80rem;
}

[data-tern='header'] {
  border-bottom-width: 2px;
}

/* The component cards. A shadow rather than a border reads lighter at a
   distance, which is where most status pages are actually read from. */
[data-tern='components'] article {
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.12);
}

/* Incidents keep their colour rule on the leading edge — that is a second
   channel beside the word, never a replacement for it. */
[data-tern='incidents'] .page-note {
  border-left-width: 4px;
}
`
}

/**
 * The tenant's stylesheet, on the tenant's page.
 *
 * The second half of `custom`, and the half that used to be something else. It
 * was a whole document — HTML, CSS and script — handed to a sandboxed iframe
 * that could reach nothing: no same-origin, a CSP denying the network outright,
 * and the status data pushed in over `postMessage` so the frame never needed a
 * connection. That reasoning was sound and is worth keeping written down,
 * because it explains why what follows is *smaller* rather than why it was
 * forgotten.
 *
 * What the frame cost was the page. A document confined enough to be safe
 * cannot reach React, so it redrew the charts approximately, could not use the
 * component widgets, and had to be embedded as a rectangle inside TERN's
 * layout — which is precisely the "custom is a sub-element of the page"
 * complaint. Meanwhile the two things operators actually reached for it for
 * were "put this where I want it" and "make it look like us". The first is the
 * block canvas. The second is a stylesheet, and a stylesheet does not need a
 * sandbox to be a stylesheet.
 *
 * So: CSS only, applied to the real page. Blocks say what is on the page and
 * where; this says what it looks like. If that turns out to be too little, the
 * `customHtml` and `customJs` columns are still in the database and the frame
 * above is still in the history — nothing was thrown away.
 *
 * ## What this does not claim
 *
 * CSS is not a sandbox and this does not pretend to be one. A stylesheet can
 * hide things, and the guard below only re-forces the handful that must never
 * disappear — the notices, the reader's controls, the incidents, the credit.
 * It is written to survive the accident and the obvious attempt; somebody
 * determined, editing their own page, will get past it. That is an acceptable
 * trade because the person writing this CSS is the operator of the page it
 * styles, and the data it could reveal is data the page already publishes.
 *
 * The other CSS risks are worth naming rather than hand-waving: `url()` in a
 * rule reaches the network, so a stylesheet can tell its author that the page
 * was opened. Nothing on this page is secret from its own readers, so what
 * leaks is a page view — which the operator's own analytics would tell them
 * anyway.
 */

/**
 * The parts of the page a stylesheet cannot take away.
 *
 * Last in the cascade and `!important`, so the ordinary `display: none` loses.
 * Deliberately short: it names four things, and each is there because a reader
 * who lost it would be misled rather than merely inconvenienced. A demo page
 * that stopped saying it was a demo; a reader with no way back to a legible
 * theme; a status page with its incidents hidden; a page that stopped saying
 * whose software it runs on.
 */
const GUARD = `
[data-tern-guard] {
  display: revert !important;
  visibility: visible !important;
  opacity: 1 !important;
  position: static !important;
  height: auto !important;
  max-height: none !important;
  overflow: visible !important;
  clip-path: none !important;
  transform: none !important;
  pointer-events: auto !important;
}
`

export function TenantStyle({ css }: { css: string }) {
  // Nothing rendered for a tenant who has not written any, rather than an empty
  // <style> element that would make the page look styled by someone.
  if (css.trim() === '') return null

  return (
    <>
      {/*
        Injected as written. There is no attempt to parse, scope or rewrite it:
        a CSS parser here would be a second, worse one, and a scoping prefix
        that had to be applied to arbitrary selectors is exactly the sort of
        list-based defence that eventually misses one. The boundary is the
        guard below and the fact that this stylesheet only ever loads on the
        page its own author administers.

        No nonce, because the app sets no Content-Security-Policy — checked
        rather than assumed. If one is ever added, this element is where it
        needs a nonce.
      */}
      <style data-tern-tenant-style="">{css}</style>
      <style data-tern-guard-style="">{GUARD}</style>
    </>
  )
}

export const __testables = { GUARD }

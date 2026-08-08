/**
 * What the whole suite agrees on.
 *
 * The tenant and the administrator are created once, by `first-run.spec.ts`,
 * and every later file signs in as this account through the saved storage
 * state. Kept here rather than repeated so a change to the password is one
 * edit instead of a hunt.
 */
export const TENANT = {
  name: 'Acme E2E',
  /** What the name folds down to — pinned because the routes are built from it. */
  slug: 'acme-e2e',
}

export const ADMIN = {
  name: 'Ada Lovelace',
  email: 'ada@acme.example',
  // Long rather than clever: the sign-up form enforces a minimum, and a test
  // that trips it fails on the fixture rather than on what it meant to check.
  password: 'correct-horse-battery-staple',
}

/** A control the suite creates and then looks for on the public page. */
export const CONTROL = {
  key: 'api-gateway',
  name: 'API gateway',
  url: 'https://example.com/',
}

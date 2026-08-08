import { expect, test } from '@playwright/test'
import { CONTROL, TENANT } from './fixtures'

/**
 * The page visitors actually read.
 *
 * Everything here is checked signed out where it matters: the public page is
 * the one surface with no account behind it, and a check performed while
 * carrying an administrator's cookie would not be checking what a visitor sees.
 */

test('it opens, names the tenant, and shows what the admin defined', async ({ browser }) => {
  const visitor = await browser.newContext()
  const page = await visitor.newPage()

  await page.goto(`/s/${TENANT.slug}`)

  await expect(page.getByText(TENANT.name).first()).toBeVisible()
  // Created in controls.spec.ts. This is the round trip the product exists for.
  await expect(page.getByText(CONTROL.name).first()).toBeVisible()

  await visitor.close()
})

test('it offers no way in', async ({ browser }) => {
  const visitor = await browser.newContext()
  const page = await visitor.newPage()

  await page.goto(`/s/${TENANT.slug}`)

  // No admin controls leak onto it. Not a styling question — these would be
  // real buttons pointed at real endpoints.
  await expect(page.getByRole('button', { name: 'New control' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /^Report an issue/ })).toHaveCount(0)

  await visitor.close()
})

test('an unknown page does not invent one', async ({ browser }) => {
  const visitor = await browser.newContext()
  const page = await visitor.newPage()

  await page.goto('/s/no-such-tenant')

  // It must not fall back to whichever page this instance happens to serve —
  // that would be somebody else's status page under a name they did not choose.
  await expect(page.getByText(TENANT.name)).toHaveCount(0)

  await visitor.close()
})

test('the guides are served to somebody with no account', async ({ browser }) => {
  const visitor = await browser.newContext()
  const page = await visitor.newPage()

  // The admin links here, but the file has to stand on its own: it is read by
  // an operator whose instance is broken, which is when signing in may not be
  // an option.
  const response = await page.request.get('/docs/user-guide.html')
  expect(response.status()).toBe(200)

  const html = await response.text()
  // Self-contained by design: no CDN, no font, no image, no fetch. Pinned
  // because it is the property that makes the guide readable with no network,
  // and the easiest one to lose by accident.
  expect(html).not.toMatch(/<script[^>]+src=/)
  expect(html).not.toMatch(/https?:\/\/[^"']*\.(css|js|woff2?)/)

  await visitor.close()
})

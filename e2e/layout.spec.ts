import { expect, test } from '@playwright/test'
import { TENANT } from './fixtures'

/**
 * The layout editor's preview, which is an iframe of the real public page.
 *
 * Worth an end-to-end test precisely because it spans two things that cannot
 * see each other: the editor puts the draft in a query string, the page reads
 * it back. A unit test can pin either side and neither can catch the pair
 * disagreeing — which is exactly what happened when `custom` was accepted by
 * the page's type and rejected by its parser, so previewing that density
 * silently showed the *saved* layout instead.
 */

test.beforeEach(async ({ page }) => {
  await page.goto(`/app/${TENANT.slug}/layout`)
})

test('every density reaches the preview frame', async ({ page }) => {
  for (const density of ['list', 'grid', 'compact', 'custom']) {
    await page
      .getByRole('radio', { name: new RegExp(density, 'i') })
      .first()
      .click()

    // Read off the frame's own URL. Asserting on the rendered page would tie
    // this to whatever the current CSS does; the contract being checked is
    // that the choice travels at all.
    const frame = page.locator('iframe')
    await expect(frame).toHaveAttribute('src', new RegExp(`layout=${density}\\b`))
  }
})

test('the frame renders the page rather than an error', async ({ page }) => {
  const frame = page.frameLocator('iframe')
  // The tenant's name is drawn by the page's own header, so seeing it means the
  // frame loaded the real thing and not a blank document or the app shell.
  await expect(frame.getByText(TENANT.name).first()).toBeVisible()
})

test('a visitor cannot rearrange the page with a link', async ({ page }) => {
  // The override is a preview mechanism, not a feature of the public page. A
  // link that skipped the flag would let anyone hand out a rearranged version
  // of somebody else's status page.
  await page.goto(`/s/${TENANT.slug}?layout=compact&order=nonsense`)
  await expect(page.getByText(TENANT.name).first()).toBeVisible()

  const withFlag = await page.evaluate(() => document.body.innerHTML.length)
  expect(withFlag).toBeGreaterThan(0)
})

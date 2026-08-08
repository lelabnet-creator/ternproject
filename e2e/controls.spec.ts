import { expect, test } from '@playwright/test'
import { CONTROL, TENANT } from './fixtures'

/**
 * Creating a control, and the warning that stops a check nobody would debug.
 *
 * The control created here is the one `public-page.spec.ts` looks for, which is
 * the other half of what this file tests: a thing defined in the admin has to
 * turn up on the page visitors read.
 */

test.describe.configure({ mode: 'serial' })

test('a control created in the admin exists', async ({ page }) => {
  await page.goto(`/app/${TENANT.slug}`)

  await page.getByRole('button', { name: 'New control' }).click()

  await page.getByLabel(/^Key/).fill(CONTROL.key)
  await page.getByLabel(/^Name/).fill(CONTROL.name)

  // The kind first, and it is not incidental: a control is `push` by default,
  // and a `push` control has no URL to give — the field only exists once the
  // editor is told something else does the checking. Filling a URL before
  // choosing HTTP waits on a field that will never appear.
  await page.getByLabel(/^What to check/).selectOption('http')
  await page.getByLabel(/^URL/).fill(CONTROL.url)

  await page.getByRole('button', { name: /^Create and continue/ }).click()

  // Back on the list, with it on it.
  await page.goto(`/app/${TENANT.slug}`)
  await expect(page.getByText(CONTROL.name).first()).toBeVisible()
})

test('an address that means this machine is called out before it is saved', async ({ page }) => {
  await page.goto(`/app/${TENANT.slug}`)
  await page.getByRole('button', { name: 'New control' }).click()

  await page.getByLabel(/^Key/).fill('loopback-check')
  await page.getByLabel(/^Name/).fill('Loopback check')
  await page.getByLabel(/^What to check/).selectOption('http')

  // The natural thing to type when monitoring your own machine — and, with the
  // agent measuring from inside its container, the one address it cannot reach.
  await page.getByLabel(/^URL/).fill('http://localhost:5432/')

  await expect(page.getByText(/will not mean this machine/i)).toBeVisible()

  // And it goes away when the address stops meaning that, rather than sticking
  // around as a permanent scold.
  await page.getByLabel(/^URL/).fill('https://example.com/health')
  await expect(page.getByText(/will not mean this machine/i)).toHaveCount(0)
})

test('a real address raises nothing', async ({ page }) => {
  await page.goto(`/app/${TENANT.slug}`)
  await page.getByRole('button', { name: 'New control' }).click()
  await page.getByLabel(/^What to check/).selectOption('http')

  await page.getByLabel(/^URL/).fill('https://status.example.com/health')
  await expect(page.getByText(/will not mean this machine/i)).toHaveCount(0)
})

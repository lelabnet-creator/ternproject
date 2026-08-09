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

/**
 * A file, refused and then applied.
 *
 * The two halves are one test because the interesting property is the sequence:
 * the same box that just refused a file has to accept it once the line it named
 * is fixed, and the preview in between has to leave the estate untouched. Split
 * in two, neither half would notice a screen that never clears its errors.
 */
test('a YAML file is checked in the browser, previewed, then applied', async ({ page }) => {
  await page.goto(`/app/${TENANT.slug}`)
  await page.getByRole('button', { name: 'Import YAML' }).click()

  const box = page.getByLabel(/^YAML/)

  // Two problems, both of them typos a person actually makes: a field named the
  // way the API's JSON would spell it, and a control that says it speaks HTTP
  // without saying to what.
  await box.fill(`controls:
  - key: imported.one
    name: Imported one
    kind: http
    config:
      timeout_ms: 5000
`)

  // No request is made to find this out — the shared parser runs in the tab.
  await expect(page.getByText('Unknown field "timeout_ms"')).toBeVisible()
  // More than one problem points at that line — the missing `url` has nowhere
  // of its own to be, so it lands on the config block it should have been in.
  await expect(page.getByText(/^line 6/).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Preview' })).toBeDisabled()

  await box.fill(`controls:
  - key: imported.one
    name: Imported one
    group: Imported
    kind: http
    config:
      url: https://example.com/health
`)

  await expect(page.getByText(/1 control ·/)).toBeVisible()

  await page.getByRole('button', { name: 'Preview' }).click()
  await expect(page.getByText('Preview — nothing was written')).toBeVisible()
  await expect(page.getByText('1 created · 0 updated')).toBeVisible()

  // The preview wrote nothing, so the list must still not have it.
  await page.goto(`/app/${TENANT.slug}`)
  await expect(page.getByText('Imported one')).toHaveCount(0)

  await page.getByRole('button', { name: 'Import YAML' }).click()
  await box.fill(`controls:
  - key: imported.one
    name: Imported one
    group: Imported
    kind: http
    config:
      url: https://example.com/health
`)
  await page.getByRole('button', { name: /^Import/ }).click()

  // The folder named in the file did not exist a moment ago; it is counted here
  // because the import created it on the way past.
  await expect(
    page.getByText(/Imported 1 new and 0 updated control, in 1 new folder/),
  ).toBeVisible()
  await expect(page.getByText('Imported one').first()).toBeVisible()
})

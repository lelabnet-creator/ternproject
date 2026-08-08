import { expect, test } from '@playwright/test'
import { ADMIN, TENANT } from './fixtures'

/**
 * The first visit to a brand new instance.
 *
 * This runs before everything else and is the reason the suite is serial: the
 * window it walks through exists exactly once per database, and the account it
 * creates is the one every later file signs in as.
 *
 * It is also the highest-stakes screen in the product. Until an administrator
 * exists, whoever opens `/app` becomes one — so "the window closes behind the
 * first person through it" is a security property, not a nicety, and it is
 * asserted here rather than assumed.
 */

test.describe.configure({ mode: 'serial' })

test('a fresh instance hands the admin to the first visitor, then to nobody', async ({
  page,
  context,
}) => {
  await page.goto('/app')

  // ── The page ───────────────────────────────────────────────────────────────
  await expect(page.getByRole('heading', { name: /set up this instance/i })).toBeVisible()

  // Anchored patterns rather than exact strings. `Field` wraps its label, its
  // input and its hint in one `<label>`, so an input's accessible name is
  // "Name Shown at the top of the public page." — the hint is part of it. `^`
  // also keeps "Password" from matching "Confirm password", which would be a
  // strict-mode violation rather than a wrong field.
  await page.getByLabel(/^Name/).fill(TENANT.name)
  // Typed rather than left to derive from the name: the suite builds URLs from
  // this, and a slug that changed with the folding rules would break the files
  // that come after in a way that looks like their fault.
  await page.getByLabel(/^Address/).fill(TENANT.slug)
  await page.getByRole('button', { name: 'Continue' }).click()

  // ── The account ────────────────────────────────────────────────────────────
  await page.getByLabel(/^Email/).fill(ADMIN.email)
  await page.getByLabel(/^Name/).fill(ADMIN.name)
  await page.getByLabel(/^Password/).fill(ADMIN.password)
  await page.getByLabel(/^Confirm password/).fill(ADMIN.password)
  await page.getByRole('button', { name: 'Create account' }).click()

  // ── Mail, which an instance is allowed not to have ────────────────────────
  const skip = page.getByRole('button', { name: 'Skip for now' })
  await expect(skip).toBeVisible()
  await skip.click()

  await page.getByRole('button', { name: 'Open the admin' }).click()

  // Signed in, inside the admin, on the tenant just named.
  await expect(page).toHaveURL(/\/app\//)
  await expect(page.getByText(TENANT.name).first()).toBeVisible()

  // A second wizard waits behind the first — appearance, then done — and it
  // covers the rail until it is dealt with. Dismissed here rather than in every
  // later file: it is part of arriving in the admin, and the specs that follow
  // are about what is there once you have arrived.
  //
  // Waited for rather than polled with `isVisible`. The first version asked
  // whether the button was there the instant the tenant's name appeared — and
  // the name appears in the wizard's own heading, so the question was put
  // before the wizard had mounted, answered "no", and left the wizard sitting
  // over every later assertion.
  const skipAppearance = page.getByRole('button', { name: 'Skip setup' })
  const rail = page.getByRole('link', { name: 'Controls', exact: true })

  // The settings endpoint is what the admin now consults to decide whether to
  // offer the appearance wizard — it moved off the public summary, which is
  // cached and answered with the state from before. Checked first, because if
  // this call fails the wizard silently never appears, and "no wizard" and "the
  // wizard was answered" look identical from the outside.
  const settings = await page.request.get(`/api/v1/${TENANT.slug}/settings`)
  expect(settings.status(), 'the admin must be able to read its own settings').toBe(200)

  await expect(skipAppearance.or(rail).first()).toBeVisible()

  if (await skipAppearance.isVisible()) {
    await skipAppearance.click()

    // Asserted separately from the rail. "Skip" marks the tenant configured
    // through the API and waits on the refetch; when that came back cached the
    // wizard reappeared, and a single assertion on the rail reported "Controls
    // not found" for what was really "the answer did not stick".
    await expect(skipAppearance).toHaveCount(0)

    const after = await page.request.get(`/api/v1/${TENANT.slug}/settings`)
    expect(
      (await after.json()).setupCompletedAt,
      'skipping the wizard must mark the tenant set up',
    ).toBeTruthy()
  }

  // The rail, which is the proof that every wizard is behind us.
  await expect(rail).toBeVisible()

  // And the guided tour, which opens on a tenant that has nothing in it yet.
  //
  // It is a spotlight over the whole admin: every later spec found its target
  // present in the accessibility tree and un-clickable underneath. Dismissed
  // here, once, for the same reason as the setup wizard — it belongs to
  // arriving in the admin, not to what the admin can do.
  const skipTour = page.getByRole('button', { name: /skip the tour/i })
  if (await skipTour.isVisible().catch(() => false)) {
    await skipTour.click()
    await expect(skipTour).toHaveCount(0)
  }

  // Handed to every later spec. Written only once the admin has actually
  // rendered, so a session captured mid-redirect cannot be saved.
  await context.storageState({ path: 'e2e/.auth/admin.json' })
})

test('the window is closed to the next visitor', async ({ browser }) => {
  // A different browser context: no cookies, no storage — the second person to
  // find the address. Before an administrator exists this page would have
  // offered them the wizard.
  const stranger = await browser.newContext()
  const page = await stranger.newPage()

  await page.goto('/app')

  await expect(page.getByRole('button', { name: 'Create account' })).toHaveCount(0)
  await expect(page.getByLabel(/password/i).first()).toBeVisible()

  await stranger.close()
})

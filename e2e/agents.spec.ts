import { expect, test } from '@playwright/test'
import { TENANT } from './fixtures'

/**
 * The fleet, on an instance that has only its own agent.
 *
 * `Agent-local-tern` is provisioned by the server at first run and runs as its
 * own container in the stack this suite starts — so its presence here is an
 * end-to-end fact, not a fixture: the API wrote `agent.toml`, the agent
 * container read it, paired without a PIN and reported.
 */

test.beforeEach(async ({ page }) => {
  await page.goto(`/app/${TENANT.slug}/agents`)
})

// The one test in this suite that waits on a schedule it does not control: the
// agent reports when its own timer comes round, not when Playwright asks.
test('the instance runs an agent for itself, and reports', async ({ page }) => {
  test.setTimeout(240_000)

  // `exact` because the fleet draws the name twice: once as the row's heading
  // and once inside the `<title>` of its status glyph, where it is followed by
  // a summary. Without it the locator matches both and Playwright refuses to
  // guess — correctly, since the two say different things.
  await expect(page.getByText('Agent-local-tern', { exact: true }).first()).toBeVisible()
  // `visible` because the same words are also inside the `<title>` of the row's
  // status glyph, which is a label for a screen reader and hidden from sight.
  // Matching it first made this assert that a hidden element was visible, which
  // it can never be — the test failed while the screen was perfectly correct.
  await expect(page.getByText('this instance').filter({ visible: true }).first()).toBeVisible()

  // Seen recently rather than merely listed. A row that was written and never
  // reported is the failure this distinguishes — and it looks identical until
  // you read the time.
  //
  // Given far longer than the suite's usual patience, and deliberately so. The
  // row appears the moment the API writes `agent.toml`; the first report comes
  // when the agent's own schedule brings it round, which on a stack that has
  // just started is a minute or two later. Waiting is what makes this assertion
  // mean something — shortening it would leave a test that passes on a row
  // nobody has heard from, which is the exact failure it exists to catch.
  await expect(async () => {
    await page.reload()
    await expect(
      page
        .getByText(/just now|seconds? ago|a minute ago|\d+ min/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible({ timeout: 10_000 })
  }).toPass({ timeout: 180_000 })
})

test('it cannot be revoked', async ({ page }) => {
  // Not drawn, rather than drawn and answering 409. The API refuses either way;
  // the point is that the admin does not offer the gesture.
  const row = page.locator('article, li, div').filter({ hasText: 'Agent-local-tern' }).last()
  await expect(row.getByRole('button', { name: 'Revoke' })).toHaveCount(0)
})

test('it says what it can and cannot see', async ({ page }) => {
  // The answer to "why is my check on localhost down", on the row of the thing
  // that answers it.
  const vantage = page.getByText(/Measures from inside its container/i)
  await expect(vantage).toBeVisible()

  await vantage.click()

  await expect(page.getByText(/Cannot reach/i)).toBeVisible()
  // The way out is stated, not left as an exercise.
  await expect(page.getByText('TERN_AGENT_NETWORK_MODE=host')).toBeVisible()
})

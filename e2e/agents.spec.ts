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

test('the instance runs an agent for itself, and reports', async ({ page }) => {
  await expect(page.getByText('Agent-local-tern')).toBeVisible()
  await expect(page.getByText('this instance')).toBeVisible()

  // Seen recently rather than merely listed. A row that was written and never
  // reported is the failure this distinguishes — and it looks identical until
  // you read the time.
  await expect(page.getByText(/just now|seconds? ago|a minute ago|\d+ min/i).first()).toBeVisible()
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

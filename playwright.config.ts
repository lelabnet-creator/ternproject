import { defineConfig, devices } from '@playwright/test'
import { BASE_URL } from './e2e/stack.mjs'

/**
 * The end-to-end suite: the product driven the way somebody uses it.
 *
 * It complements the unit and integration tests rather than repeating them.
 * Those pin rules — an assertion engine, a sizing calculation, a rate limit.
 * This one pins the parts no single module owns: the first-run window closing
 * behind the first administrator, a control created in the admin turning up on
 * the public page, a density choice surviving the trip through an iframe.
 *
 * ## Serial, and deliberately so
 *
 * One instance, one database, and a first-run window that exists exactly once.
 * These are not independent tests over a fixture — they are one session, and
 * running them in parallel would have two workers racing to become the first
 * administrator. `setup` runs first and hands its signed-in state to the rest
 * through `storageState`, which is also what keeps every later file from
 * re-implementing sign-in.
 */
export default defineConfig({
  testDir: './e2e',
  // A real instance behind every assertion, so the timeouts are those of a
  // browser talking to a server, not of a function call.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // The stack is built and started once, and a cold `docker compose build`
  // with an empty layer cache is minutes rather than seconds.
  globalTimeout: 20 * 60_000,
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    // Kept only for a failure. A trace per passing test is hundreds of
    // megabytes nobody opens.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'setup',
      testMatch: /first-run\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'admin',
      dependencies: ['setup'],
      testIgnore: /first-run\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        // Written by the first-run spec. Every other file starts signed in,
        // because signing in again in each of them would test the sign-in form
        // twelve times and everything else once.
        storageState: 'e2e/.auth/admin.json',
      },
    },
  ],
})

import { defineConfig } from 'vitest/config'

// A single root config rather than per-package projects: the workspaces share one
// runtime and one set of contracts, so a single `pnpm test` that sees everything is
// more useful than isolated suites that can drift apart.
export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.{test,spec,integration.test}.ts'],
    passWithNoTests: true,
    environment: 'node',
    setupFiles: ['apps/api/src/test/setup.ts'],
    // Integration suites share one PostgreSQL instance and one source IP for
    // rate limiting; running files in parallel makes both of those flaky for
    // reasons that have nothing to do with the code under test.
    fileParallelism: false,
  },
})

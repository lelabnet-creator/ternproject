import { defineConfig } from 'vitest/config'

// A single root config rather than per-package projects: the workspaces share one
// runtime and one set of contracts, so a single `pnpm test` that sees everything is
// more useful than isolated suites that can drift apart.
export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.{test,spec}.ts'],
    passWithNoTests: true,
    environment: 'node',
  },
})

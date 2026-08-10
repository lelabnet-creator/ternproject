import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/.turbo/**',
      'clients/agent/target/**',
      'clients/examples/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      // Status data flows through a lot of boundaries; explicit narrowing beats `any`.
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'smart'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    /*
     * Build scripts run in Node, from a terminal.
     *
     * `process` and `console` are the two things a script of this kind is made
     * of, and the browser-shaped defaults call both undefined. Scoped to
     * `scripts/` rather than relaxed globally, so the application code keeps
     * being told when it reaches for a global it does not have.
     */
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
    },
    rules: {
      'no-console': 'off',
    },
  },
  /*
   * The rules of hooks, on the React code.
   *
   * Absent until a hook was added below an early return in `StatusPage` and
   * shipped: it ran on the renders that had data and not on the ones that did
   * not, so the first render after the skeleton called a thirty-fifth hook
   * where there had been thirty-four and React threw before drawing anything.
   * Lint was green throughout, because nothing here was checking.
   *
   * `rules-of-hooks` is an error — it catches a class of bug that cannot be
   * caught by types and is invisible until the exact render order that trips
   * it. `exhaustive-deps` stays a warning: it is right most of the time and
   * wrong often enough that making it fail the build would teach people to
   * disable it.
   */
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  prettier,
)

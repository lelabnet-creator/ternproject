import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

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
  prettier,
)

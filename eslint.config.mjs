import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', '.wrangler/**', 'worker-configuration.d.ts', 'coverage/**', 'playwright-report/**', 'test-results/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,mjs}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'eqeqeq': ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error'
    }
  },
  {
    files: ['src/**/*.ts', 'examples/**/*.mjs'],
    languageOptions: { globals: globals.worker }
  },
  {
    files: ['public/**/*.mjs'],
    languageOptions: { globals: globals.browser }
  },
  {
    files: ['tests/**/*.{ts,mjs}', 'scripts/**/*.mjs', '*.config.mjs'],
    languageOptions: { globals: globals.node }
  },
  {
    // Playwright evaluate callbacks run in the page's browser context.
    files: ['tests/e2e/**/*.mjs'],
    languageOptions: { globals: globals.browser }
  }
);

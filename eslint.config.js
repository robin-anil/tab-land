import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'coverage/**', 'tests/screenshots/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.browser, ...globals.webextensions, ...globals.serviceworker } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },
  {
    files: ['tests/**/*.{js,mjs}', 'scripts/**/*.mjs', '*.config.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node, ...globals.browser, chrome: 'readonly' } },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }], 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
];

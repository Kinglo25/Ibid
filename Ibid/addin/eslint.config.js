import globals from 'globals';
import { ignores, baseRules, testOverrides, typescriptConfigs } from '../eslint.config.base.js';

export default [
  ...ignores,
  ...typescriptConfigs,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
        // Office.js is injected by the Word host, not bundled.
        Office: 'readonly',
        Word: 'readonly',
      },
    },
    ...baseRules,
  },
  {
    // Vite config runs in Node, not in the task pane.
    files: ['vite.config.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off' },
  },
  {
    ...testOverrides,
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
];

import globals from 'globals';
import { ignores, baseRules, testOverrides, typescriptConfigs } from '../eslint.config.base.js';

export default [
  ...ignores,
  ...typescriptConfigs,
  {
    files: ['**/*.ts', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, fetch: 'readonly', AbortController: 'readonly', Response: 'readonly' },
    },
    ...baseRules,
  },
  {
    // server.mjs is the process entry point and reports startup failures on stdout.
    files: ['server.mjs'],
    rules: { 'no-console': 'off' },
  },
  {
    ...testOverrides,
    languageOptions: { globals: { ...globals.node } },
  },
];

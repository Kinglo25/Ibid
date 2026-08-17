import globals from 'globals';
import { ignores, baseRules, testOverrides, typescriptConfigs } from '../eslint.config.base.js';

export default [
  ...ignores,
  ...typescriptConfigs,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      // Citation detection is platform-neutral: it must not reach for DOM or Node APIs.
      globals: globals.es2021,
    },
    ...baseRules,
  },
  {
    ...testOverrides,
    languageOptions: { globals: { ...globals.es2021, ...globals.node } },
  },
];

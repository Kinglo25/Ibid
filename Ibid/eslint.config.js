import globals from 'globals';
import { baseRules, typescriptConfigs } from './eslint.config.base.js';

/**
 * Root-level files only. Each workspace lints itself through its own
 * `eslint.config.js`; `npm run lint` runs all three. Workspaces are ignored here
 * so running `eslint .` from the repository root does not lint them twice under
 * the wrong globals.
 */
export default [
  { ignores: ['**/dist/**', '**/node_modules/**', 'addin/**', 'api/**', 'shared/**', 'samples/**'] },
  ...typescriptConfigs,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node } },
    ...baseRules,
  },
];

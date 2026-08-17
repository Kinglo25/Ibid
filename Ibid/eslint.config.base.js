import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Rules shared by every workspace. Each workspace has its own `eslint.config.js`
 * so `eslint .` behaves identically whether it runs from the repository root or
 * from inside a workspace: flat-config globs resolve against the config file's
 * own directory, so a single root config cannot serve both.
 */
export const ignores = [
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts', '**/samples/**'] },
];

/** Rules that apply to hand-written source in any workspace. */
export const baseRules = {
  rules: {
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    eqeqeq: ['error', 'always', { null: 'ignore' }],
    'no-var': 'error',
    'prefer-const': 'error',
    '@typescript-eslint/no-unused-vars': ['error', {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
    }],
    // The resolver deliberately narrows `unknown` at its boundaries; explicit
    // `any` stays an error so those narrowings are not quietly bypassed.
    '@typescript-eslint/no-explicit-any': 'error',
  },
};

/** Tests assert on runtime behaviour and legitimately need looser rules. */
export const testOverrides = {
  files: ['**/*.test.ts', '**/test/**/*.ts'],
  rules: {
    'no-console': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
  },
};

export const typescriptConfigs = [js.configs.recommended, ...tseslint.configs.recommended];

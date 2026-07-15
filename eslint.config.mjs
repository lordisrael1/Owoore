import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * eslint.config.mjs — pragmatic gate, not a style war.
 *
 * Scope: catch the mistake classes that hurt financial code — dead
 * imports/vars hiding refactor mistakes, accidental `any` creep, and
 * obviously-broken JS. Formatting is left alone, and `any` is a warning
 * (the codebase uses it deliberately at Express/Nomba boundaries).
 */
export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    rules: {
      // Unused code is where stale money-logic hides after refactors
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      // Deliberate at the Express/Nomba payload boundary — flag, don't fail
      '@typescript-eslint/no-explicit-any': 'warn',
      // `require()` inside functions is used for lazy circular-dep breaking
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    ignores: ['node_modules/', 'dist/', '*.log', 'coverage/'],
  },
);

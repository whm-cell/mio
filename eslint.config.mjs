import tseslint from 'typescript-eslint';
import { readFileSync } from 'node:fs';

const harness = JSON.parse(readFileSync(new URL('./harness.config.json', import.meta.url), 'utf8'));
const productionFiles = Object.entries(harness.sourceRoots)
  .filter(([, role]) => role === 'production')
  .map(([root]) => `${root}/**/*.ts`);

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'compute/dist/**',
      'contracts/compute/dist/**',
      'packages/foundation/dist/**',
      'coverage/**',
      '.runtime/**',
      '.work/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: productionFiles,
    rules: { 'no-console': 'error' },
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
    },
  },
);

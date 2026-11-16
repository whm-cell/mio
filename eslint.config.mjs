import tseslint from 'typescript-eslint';
import { readFileSync } from 'node:fs';
import { foundationPrimitives } from './scripts/harness/source-foundation.ts';

const harness = JSON.parse(readFileSync(new URL('./harness.config.json', import.meta.url), 'utf8'));
const productionFiles = Object.entries(harness.sourceRoots)
  .filter(([, role]) => role === 'production')
  .map(([root]) => `${root}/**/*.ts`);

const serviceSources = Object.values(harness.projects)
  .filter((project) => project.kind === 'service')
  .flatMap((project) => project.sources);
const serviceProductionFiles = Object.entries(harness.sourceRoots)
  .filter(([root, role]) => role === 'production' && serviceSources.includes(root))
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
      '.claude/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: productionFiles,
    rules: { 'no-console': 'error' },
  },
  {
    files: serviceProductionFiles,
    plugins: { foundation: { rules: { 'consumer-primitives': foundationPrimitives } } },
    rules: { 'foundation/consumer-primitives': 'error' },
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

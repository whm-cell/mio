import type { HarnessConfig } from '../scripts/harness/inventory.ts';

/** The isolated legacy fixture is independent of whichever projects the host declares. */
export function legacyHarness(): HarnessConfig {
  return {
    sourceRoots: {
      src: 'production',
      tests: 'test',
      'scripts/harness': 'development',
      'scripts/service': 'development',
    },
    developmentDependencies: {
      'scripts/harness': ['scripts/harness'],
      'scripts/service': [
        'scripts/service',
        'src/auth/config.ts',
        'src/conversations/config.ts',
        'src/conversations/schema.ts',
        'src/assets/config.ts',
        'src/assets/schema.ts',
        'src/providers/config.ts',
        'src/providers/schema.ts',
        'src/providers/store.ts',
        'src/providers/contracts.ts',
      ],
    },
    documentRoots: ['README.md', 'AGENTS.md', 'docs'],
    privateRoots: ['.work', '.runtime'],
    generatedRoots: ['node_modules', 'dist', 'coverage', '.git'],
    configurationFiles: [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig.json',
      'tsconfig.build.json',
      'eslint.config.mjs',
      'vitest.config.ts',
      'harness.config.json',
      '.gitignore',
      '.prettierignore',
      '.prettierrc.json',
      '.node-version',
      '.npmrc',
      'cordis.patch.yml',
      '.editorconfig',
    ],
  };
}

export function legacyTypecheck() {
  return {
    compilerOptions: {
      target: 'ES2024',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noImplicitOverride: true,
      noFallthroughCasesInSwitch: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      verbatimModuleSyntax: true,
      allowImportingTsExtensions: true,
      rewriteRelativeImportExtensions: true,
      erasableSyntaxOnly: true,
      types: ['node'],
      skipLibCheck: true,
    },
    include: ['src/**/*.ts', 'scripts/**/*.ts', 'tests/**/*.ts', 'vitest.config.ts'],
  };
}

export function legacyBuild() {
  return {
    extends: './tsconfig.json',
    compilerOptions: { rootDir: 'src', outDir: 'dist', declaration: true },
    include: ['src/**/*.ts'],
  };
}

import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import ts from 'typescript';
import { legacyHarness } from './guardrail-fixture.ts';

const project = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function put(root: string, path: string, text: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

interface FixtureJson {
  sourceRoots: Record<string, string>;
  developmentDependencies: Record<string, string[]>;
  generatedRoots: string[];
  configurationFiles: string[];
  projects: Record<
    string,
    {
      sources: string[];
      kind?: string;
      packageRoot?: string;
      typecheck?: string;
      build?: string;
      publicEntries?: { source: string; export: string }[];
      capabilities?: Record<string, string[]>;
      packageAdapters?: Record<string, string[]>;
    }
  >;
  compilerOptions: { paths?: Record<string, string[]>; noEmit?: boolean; rootDir?: string };
  include: string[];
  exports: Record<string, unknown>;
}

async function json(root: string, path: string, update: (value: FixtureJson) => void) {
  const value = JSON.parse(await readFile(join(root, path), 'utf8')) as FixtureJson;
  update(value);
  await put(root, path, JSON.stringify(value, null, 2));
}

function check(root: string) {
  const result = spawnSync(
    process.execPath,
    [join(project, 'scripts/harness/check-guardrails.ts'), root],
    {
      encoding: 'utf8',
    },
  );
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

function build(root: string, config: string) {
  const result = spawnSync(
    process.execPath,
    [require.resolve('typescript/bin/tsc'), '-p', config],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

/** Three projects are declared only in the fixture; no checker source is changed to add one. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mio-projects-'));
  scratch.push(root);
  const harness = legacyHarness();
  harness.sourceRoots['compute/src'] = 'production';
  harness.sourceRoots['contracts/compute/src'] = 'production';
  harness.generatedRoots.push(
    'compute/dist',
    'contracts/compute/dist',
    'compute/node_modules',
    'contracts/compute/node_modules',
  );
  for (const base of ['compute', 'contracts/compute'])
    harness.configurationFiles.push(
      `${base}/package.json`,
      `${base}/tsconfig.json`,
      `${base}/tsconfig.build.json`,
    );
  harness.projects = {
    app: {
      kind: 'service',
      packageRoot: '.',
      sources: ['src'],
      typecheck: 'tsconfig.json',
      build: 'tsconfig.build.json',
    },
    worker: {
      kind: 'service',
      packageRoot: 'compute',
      sources: ['compute/src'],
      typecheck: 'compute/tsconfig.json',
      build: 'compute/tsconfig.build.json',
    },
    protocol: {
      kind: 'contract',
      packageRoot: 'contracts/compute',
      sources: ['contracts/compute/src'],
      typecheck: 'contracts/compute/tsconfig.json',
      build: 'contracts/compute/tsconfig.build.json',
      publicEntries: [{ source: 'contracts/compute/src/index.ts', export: '.' }],
    },
  };
  const config = {
    compilerOptions: {
      target: 'ES2024',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      allowImportingTsExtensions: true,
      rewriteRelativeImportExtensions: true,
      types: [],
      skipLibCheck: true,
    },
    include: ['src/**/*.ts'],
  };
  const buildConfig = {
    extends: './tsconfig.json',
    compilerOptions: { rootDir: 'src', outDir: 'dist', declaration: true },
    include: ['src/**/*.ts'],
  };
  const inputs: Record<string, string> = {
    'README.md': '# Fixture\n',
    'harness.config.json': JSON.stringify(harness, null, 2),
    'package.json': JSON.stringify({ name: '@fixture/app', type: 'module' }),
    'tsconfig.json': JSON.stringify(config),
    'tsconfig.build.json': JSON.stringify(buildConfig),
    'src/index.ts': 'export const app = 1;\n',
    'src/private.ts': 'export interface PrivateApp { id: string }\n',
    'compute/package.json': JSON.stringify({
      name: '@fixture/worker',
      type: 'module',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    }),
    'compute/tsconfig.json': JSON.stringify(config),
    'compute/tsconfig.build.json': JSON.stringify(buildConfig),
    'compute/src/index.ts': 'export const worker = 1;\n',
    'compute/src/private.ts': 'export interface PrivateWorker { id: string }\n',
    'contracts/compute/package.json': JSON.stringify({
      name: '@fixture/protocol',
      type: 'module',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    }),
    'contracts/compute/tsconfig.json': JSON.stringify(config),
    'contracts/compute/tsconfig.build.json': JSON.stringify(buildConfig),
    'contracts/compute/src/index.ts':
      'export interface Job { id: string }\nexport function parseJob(id: string): Job { return { id }; }\n',
    'contracts/compute/src/private.ts': 'export interface Secret { id: string }\n',
  };
  for (const [file, text] of Object.entries(inputs)) await put(root, file, text);
  await mkdir(join(root, 'node_modules/@fixture'), { recursive: true });
  await symlink(join(root, 'compute'), join(root, 'node_modules/@fixture/worker'), 'dir');
  await symlink(
    join(root, 'contracts/compute'),
    join(root, 'node_modules/@fixture/protocol'),
    'dir',
  );
  return root;
}

it('accepts declared independent source roots and ordinary additional business files', async () => {
  const root = await fixture();
  await put(root, 'src/business/new.ts', 'export const ordinary = 1;\n');
  await put(root, 'compute/src/business/new.ts', 'export const ordinary = 2;\n');
  await mkdir(join(root, 'compute/node_modules'), { recursive: true });
  await symlink(
    join(project, 'node_modules/typescript'),
    join(root, 'compute/node_modules/typescript'),
  );
  const result = check(root);
  expect(result.status, result.output).toBe(0);
});

it('rejects unknown roles, overlapping roots and excluded source paths', async () => {
  const role = await fixture();
  await json(role, 'harness.config.json', (config) => {
    config.sourceRoots.src = 'prodution';
  });
  expect(check(role).output).toContain('SOURCE_ROLE_INVALID src');
  const overlap = await fixture();
  await json(overlap, 'harness.config.json', (config) => {
    config.sourceRoots['compute/src/nested'] = 'production';
  });
  expect(check(overlap).output).toContain('SOURCE_ROOT_OVERLAP');
  const excluded = await fixture();
  await json(excluded, 'harness.config.json', (config) => {
    config.generatedRoots.push('compute/src/hidden');
  });
  expect(check(excluded).output).toContain('EXCLUSION_SOURCE_OVERLAP');
  const hidden = await fixture();
  await json(hidden, 'harness.config.json', (config) => {
    config.generatedRoots.push('hidden-worker');
  });
  expect(check(hidden).output).toContain('EXCLUSION_GENERATED hidden-worker');
  const stolen = await fixture();
  await json(stolen, 'harness.config.json', (config) => {
    config.projects.worker!.sources.push('src');
  });
  expect(check(stolen).output).toContain('PROJECT_ROOT_SOURCE');
});

it('rejects duplicate JSON keys and unsupported source languages', async () => {
  const duplicate = await fixture();
  const path = join(duplicate, 'harness.config.json');
  const text = await readFile(path, 'utf8');
  await writeFile(path, text.replace('"src": "production"', '"src": "production", "src": "test"'));
  expect(check(duplicate).output).toContain('HARNESS_DUPLICATE_KEY src');
  const source = await fixture();
  await put(source, 'compute/src/worker.py', 'print(1)\n');
  expect(check(source).output).toContain('SOURCE_UNSUPPORTED compute/src/worker.py');
  const unknown = await fixture();
  await put(unknown, 'new-worker/main.rs', 'fn main() {}\n');
  expect(check(unknown).output).toContain('FILE_UNCLASSIFIED new-worker/main.rs');
});

it('checks each production root against its own typecheck and executable build inputs', async () => {
  const root = await fixture();
  await put(root, 'compute/src/extra.ts', 'export const extra = 1;\n');
  await json(root, 'compute/tsconfig.json', (config) => {
    config.include = ['src/index.ts'];
  });
  await json(root, 'compute/tsconfig.build.json', (config) => {
    config.include = ['src/index.ts'];
  });
  const omitted = check(root);
  expect(omitted.output).toContain('SOURCE_NOT_TYPECHECKED compute/src/extra.ts');
  expect(omitted.output).toContain('SOURCE_NOT_BUILT compute/src/extra.ts');
  const noEmit = await fixture();
  await json(noEmit, 'compute/tsconfig.build.json', (config) => {
    config.compilerOptions.noEmit = true;
  });
  expect(check(noEmit).output).toContain('PROJECT_BUILD_EMIT worker');
  const wrongRoot = await fixture();
  await json(wrongRoot, 'compute/tsconfig.build.json', (config) => {
    config.compilerOptions.rootDir = 'src/deep';
  });
  expect(check(wrongRoot).output).toContain('SOURCE_NOT_BUILT compute/src/index.ts');
});

it('permits a project test root while rejecting another service as an explicit compiler input', async () => {
  const root = await fixture();
  await put(root, 'compute/tests/worker.test.ts', 'export const fixture = 1;\n');
  await json(root, 'harness.config.json', (config) => {
    config.sourceRoots['compute/tests'] = 'test';
  });
  await json(root, 'compute/tsconfig.json', (config) => {
    config.include.push('tests/**/*.ts');
  });
  const allowed = check(root);
  expect(allowed.status, allowed.output).toBe(0);
  await json(root, 'tsconfig.json', (config) => {
    config.include.push('compute/src/**/*.ts');
  });
  await json(root, 'tsconfig.build.json', (config) => {
    config.include.push('compute/src/**/*.ts');
  });
  const denied = check(root);
  expect(denied.status, denied.output).toBe(1);
  expect(denied.output).toContain('PROJECT_TYPECHECK_FOREIGN app: compute/src/index.ts');
  expect(denied.output).toContain('PROJECT_BUILD_FOREIGN app: compute/src/index.ts');
});

it('checks aliases using build options as well as typecheck options', async () => {
  const root = await fixture();
  await json(root, 'tsconfig.json', (config) => {
    config.compilerOptions.paths = { '@chosen': ['./contracts/compute/src/index.ts'] };
  });
  await json(root, 'tsconfig.build.json', (config) => {
    config.compilerOptions.paths = { '@chosen': ['./compute/src/private.ts'] };
  });
  await put(root, 'src/index.ts', "export type { Job } from '@chosen';\n");
  expect(check(root).output).toContain('PROJECT_DEPENDENCY src/index.ts');
});

it('rejects cross-service imports, aliases, type-only exports and reverse contract dependencies', async () => {
  const root = await fixture();
  await put(
    root,
    'src/index.ts',
    "export type { PrivateWorker } from '../compute/src/private.ts';\n",
  );
  expect(check(root).output).toContain('PROJECT_DEPENDENCY src/index.ts');
  await put(root, 'src/index.ts', 'export const app = 1;\n');
  await json(root, 'compute/tsconfig.json', (config) => {
    config.compilerOptions.paths = { '@app-private': ['../src/private.ts'] };
  });
  await put(root, 'compute/src/index.ts', "export type { PrivateApp } from '@app-private';\n");
  expect(check(root).output).toContain('PROJECT_DEPENDENCY compute/src/index.ts');
  await put(root, 'compute/src/index.ts', 'export const worker = 1;\n');
  build(root, 'compute/tsconfig.build.json');
  await put(root, 'src/index.ts', "export { worker } from '@fixture/worker';\n");
  expect(check(root).output).toContain('PROJECT_DEPENDENCY src/index.ts');
  await put(root, 'src/index.ts', 'export const app = 1;\n');
  await put(
    root,
    'contracts/compute/src/index.ts',
    "export type { PrivateApp } from '../../../src/private.ts';\n",
  );
  expect(check(root).output).toContain('PROJECT_DEPENDENCY contracts/compute/src/index.ts');
});

it('keeps development dependencies scoped when a workspace package resolves as external', async () => {
  const root = await fixture();
  build(root, 'compute/tsconfig.build.json');
  await json(root, 'tsconfig.json', (config) => {
    config.include.push('scripts/**/*.ts');
  });
  await put(root, 'scripts/harness/use.ts', "export { worker } from '@fixture/worker';\n");
  const result = check(root);
  expect(result.status, result.output).toBe(1);
  expect(result.output).toContain('DEVELOPMENT_DEPENDENCY scripts/harness/use.ts');
});

it('rejects an external alias to a same-name service outside the repository', async () => {
  const root = await fixture();
  const neighbor = await mkdtemp(join(tmpdir(), 'mio-neighbor-'));
  scratch.push(neighbor);
  await put(
    neighbor,
    'package.json',
    JSON.stringify({
      name: '@fixture/app',
      version: '1.0.0',
      type: 'module',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    }),
  );
  await put(neighbor, 'dist/index.d.ts', 'export declare const value: string;\n');
  await put(neighbor, 'dist/index.js', "export const value = 'neighbor';\n");
  await symlink(neighbor, join(root, 'node_modules/foreign-alias'), 'dir');
  await put(root, 'src/index.ts', "export { value } from 'foreign-alias';\n");
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const resolved = ts.resolveModuleName(
    'foreign-alias',
    join(root, 'src/index.ts'),
    parsed.options,
    ts.sys,
  ).resolvedModule;
  expect(resolved?.isExternalLibraryImport).toBe(true);
  expect(resolved?.packageId?.name).toBe('@fixture/app');
  expect(await realpath(resolved!.resolvedFileName)).toBe(
    await realpath(join(neighbor, 'dist/index.d.ts')),
  );
  build(root, 'tsconfig.build.json');
  const result = check(root);
  expect(result.status, result.output).toBe(1);
  expect(result.output).toContain('RUNTIME_DEPENDENCY src/index.ts: ../');
});

it.each([
  ['test', 'tests/target.ts', 'tests/**/*.ts'],
  ['development', 'scripts/harness/target.ts', 'scripts/**/*.ts'],
])('rejects an external alias to a same-project %s target', async (_role, target, include) => {
  const root = await fixture();
  await put(root, target, 'export const value = 1;\n');
  await put(
    root,
    'node_modules/local-alias/package.json',
    JSON.stringify({ name: '@fixture/app', version: '1.0.0', types: 'index.d.ts' }),
  );
  await symlink(join(root, target), join(root, 'node_modules/local-alias/index.d.ts'));
  await json(root, 'tsconfig.json', (config) => {
    config.include.push(include);
  });
  await put(root, 'src/index.ts', "export { value } from 'local-alias';\n");
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const resolved = ts.resolveModuleName(
    'local-alias',
    join(root, 'src/index.ts'),
    parsed.options,
    ts.sys,
  ).resolvedModule;
  expect(resolved?.isExternalLibraryImport).toBe(true);
  expect(await realpath(resolved!.resolvedFileName)).toBe(await realpath(join(root, target)));
  const result = check(root);
  expect(result.status, result.output).toBe(1);
  expect(result.output).toContain(`RUNTIME_DEPENDENCY src/index.ts: ${target}`);
});

it('preserves own production imports, public contract output and normal external packages', async () => {
  const root = await fixture();
  await put(
    root,
    'node_modules/@fixture/validator/package.json',
    JSON.stringify({
      name: '@fixture/validator',
      type: 'module',
      exports: { '.': { types: './index.d.ts', default: './index.js' } },
    }),
  );
  await put(
    root,
    'node_modules/@fixture/validator/index.d.ts',
    'export declare const valid: boolean;\n',
  );
  await put(root, 'node_modules/@fixture/validator/index.js', 'export const valid = true;\n');
  await put(
    root,
    'src/index.ts',
    "export type { PrivateApp } from './private.ts';\nexport { parseJob } from '@fixture/protocol';\nexport { valid } from '@fixture/validator';\n",
  );
  build(root, 'contracts/compute/tsconfig.build.json');
  build(root, 'tsconfig.build.json');
  const result = check(root);
  expect(result.status, result.output).toBe(0);
});

it('allows only the declared public contract build entry for service tooling', async () => {
  const root = await fixture();
  build(root, 'contracts/compute/tsconfig.build.json');
  await json(root, 'harness.config.json', (config) => {
    config.developmentDependencies['scripts/service']!.push('contracts/compute/dist/index.d.ts');
  });
  await json(root, 'tsconfig.json', (config) => {
    config.include.push('scripts/**/*.ts');
  });
  await put(root, 'scripts/service/use.ts', "export { parseJob } from '@fixture/protocol';\n");
  const allowed = check(root);
  expect(allowed.status, allowed.output).toBe(0);
  await put(
    root,
    'scripts/service/use.ts',
    "export type { Secret } from '../../contracts/compute/src/private.ts';\n",
  );
  const denied = check(root);
  expect(denied.status, denied.output).toBe(1);
  expect(denied.output).toContain('DEVELOPMENT_DEPENDENCY scripts/service/use.ts');
});

it('permits a contract internal module and an ordinary external validator, but not another contract', async () => {
  const root = await fixture();
  const base = 'contracts/shared';
  await put(
    root,
    `${base}/package.json`,
    JSON.stringify({
      name: '@fixture/shared',
      type: 'module',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    }),
  );
  await put(
    root,
    `${base}/tsconfig.json`,
    await readFile(join(root, 'contracts/compute/tsconfig.json'), 'utf8'),
  );
  await put(
    root,
    `${base}/tsconfig.build.json`,
    await readFile(join(root, 'contracts/compute/tsconfig.build.json'), 'utf8'),
  );
  await put(root, `${base}/src/index.ts`, 'export interface Other { id: string }\n');
  await put(
    root,
    'node_modules/@fixture/validator/package.json',
    JSON.stringify({ name: '@fixture/validator', type: 'module', types: 'index.d.ts' }),
  );
  await put(
    root,
    'node_modules/@fixture/validator/index.d.ts',
    'export function validate(value: string): string;\n',
  );
  await json(root, 'harness.config.json', (config) => {
    config.sourceRoots[`${base}/src`] = 'production';
    config.generatedRoots.push(`${base}/dist`);
    config.configurationFiles.push(
      `${base}/package.json`,
      `${base}/tsconfig.json`,
      `${base}/tsconfig.build.json`,
    );
    config.projects.shared = {
      kind: 'contract',
      packageRoot: base,
      sources: [`${base}/src`],
      typecheck: `${base}/tsconfig.json`,
      build: `${base}/tsconfig.build.json`,
      publicEntries: [{ source: `${base}/src/index.ts`, export: '.' }],
    };
  });
  await put(
    root,
    'contracts/compute/src/index.ts',
    "export type { Secret } from './private.ts';\nexport { validate } from '@fixture/validator';\n",
  );
  const allowed = check(root);
  expect(allowed.status, allowed.output).toBe(0);
  await put(
    root,
    'contracts/compute/src/index.ts',
    "export type { Other } from '../../shared/src/index.ts';\n",
  );
  const denied = check(root);
  expect(denied.status, denied.output).toBe(1);
  expect(denied.output).toContain('PROJECT_DEPENDENCY contracts/compute/src/index.ts');
});

it('permits reviewed contract source and built exports while rejecting private source and dist', async () => {
  const root = await fixture();
  await put(
    root,
    'src/index.ts',
    "export type { Job } from '../contracts/compute/src/index.ts';\n",
  );
  expect(check(root).status).toBe(0);
  await put(
    root,
    'src/index.ts',
    "export type { Secret } from '../contracts/compute/src/private.ts';\n",
  );
  expect(check(root).output).toContain('PROJECT_DEPENDENCY src/index.ts');
  await put(root, 'src/index.ts', "export { parseJob } from '@fixture/protocol';\n");
  build(root, 'contracts/compute/tsconfig.build.json');
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const resolved = ts.resolveModuleName(
    '@fixture/protocol',
    join(root, 'src/index.ts'),
    parsed.options,
    ts.sys,
  ).resolvedModule;
  expect(resolved?.isExternalLibraryImport).toBe(true);
  expect(check(root).status).toBe(0);
  const runtime = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { parseJob } from '@fixture/protocol'; console.log(parseJob('ok').id)",
    ],
    { cwd: root, encoding: 'utf8' },
  );
  expect(runtime.status, runtime.stderr).toBe(0);
  expect(runtime.stdout.trim()).toBe('ok');
  await put(
    root,
    'src/index.ts',
    "export type { Secret } from '../contracts/compute/dist/private.d.ts';\n",
  );
  expect(check(root).output).toContain('PROJECT_DEPENDENCY src/index.ts');
  await put(root, 'src/index.ts', "export type { Secret } from '@fixture/protocol/private';\n");
  expect(check(root).output).toContain('PROJECT_IMPORT_UNRESOLVED src/index.ts');
});

it('requires exports to select emitted JavaScript and matching declarations', async () => {
  const onlyTypes = await fixture();
  await json(onlyTypes, 'contracts/compute/package.json', (pkg) => {
    pkg.exports['.'] = { types: './dist/index.d.ts', default: './dist/index.d.ts' };
  });
  expect(check(onlyTypes).output).toContain('PROJECT_EXPORT_RUNTIME protocol');
  const sourceRuntime = await fixture();
  await json(sourceRuntime, 'contracts/compute/package.json', (pkg) => {
    pkg.exports['.'] = { types: './dist/index.d.ts', default: './src/index.ts' };
  });
  expect(check(sourceRuntime).output).toContain('PROJECT_EXPORT_RUNTIME protocol');
  const wrongTypes = await fixture();
  await json(wrongTypes, 'contracts/compute/package.json', (pkg) => {
    pkg.exports['.'] = { types: './dist/private.d.ts', default: './dist/index.js' };
  });
  expect(check(wrongTypes).output).toContain('PROJECT_EXPORT_TYPES protocol');
  const array = await fixture();
  await json(array, 'contracts/compute/package.json', (pkg) => {
    pkg.exports['.'] = ['./dist/index.js'];
  });
  expect(check(array).output).toContain('PROJECT_EXPORTS protocol');
});

it('permits only exact service adapters for builtins, COS and AMQP', async () => {
  const root = await fixture();
  await put(
    root,
    'node_modules/amqplib/package.json',
    JSON.stringify({ name: 'amqplib', types: 'index.d.ts' }),
  );
  await put(root, 'node_modules/amqplib/index.d.ts', 'export interface Channel { id: string }\n');
  await put(
    root,
    'compute/src/adapters/fs.ts',
    "export const fs = process.getBuiltinModule('node:fs');\n",
  );
  await put(
    root,
    'compute/src/adapters/ffmpeg.ts',
    "export { spawn } from 'node:child_process';\n",
  );
  await put(root, 'compute/src/adapters/cos.ts', "export type * from 'cos-nodejs-sdk-v5';\n");
  await put(
    root,
    'compute/src/adapters/journal.ts',
    "export { DatabaseSync } from 'node:sqlite';\n",
  );
  await put(root, 'compute/src/adapters/rabbitmq.ts', "export type { Channel } from 'amqplib';\n");
  await put(root, 'src/integrations/rabbitmq.ts', "export type { Channel } from 'amqplib';\n");
  await json(root, 'harness.config.json', (config) => {
    config.projects.worker!.capabilities = {
      fs: ['compute/src/adapters/fs.ts'],
      child_process: ['compute/src/adapters/ffmpeg.ts'],
      sqlite: ['compute/src/adapters/journal.ts'],
    };
    config.projects.worker!.packageAdapters = {
      'cos-nodejs-sdk-v5': ['compute/src/adapters/cos.ts'],
      amqplib: ['compute/src/adapters/rabbitmq.ts'],
    };
    config.projects.app!.packageAdapters = { amqplib: ['src/integrations/rabbitmq.ts'] };
  });
  expect(check(root).status).toBe(0);
  await json(root, 'compute/tsconfig.json', (config) => {
    config.compilerOptions.paths = {
      'cos-alias': [require.resolve('cos-nodejs-sdk-v5')],
      'amqp-alias': [join(root, 'node_modules/amqplib/index.d.ts')],
    };
  });
  await put(root, 'compute/src/adapters/cos.ts', "export type * from 'cos-alias';\n");
  await put(
    root,
    'compute/src/adapters/rabbitmq.ts',
    "export type { Channel } from 'amqp-alias';\n",
  );
  expect(check(root).status).toBe(0);
  await put(root, 'compute/src/adapters/fs-extra.ts', "export { readFile } from 'fs/promises';\n");
  expect(check(root).output).toContain('RUNTIME_CAPABILITY compute/src/adapters/fs-extra.ts');
  await rm(join(root, 'compute/src/adapters/fs-extra.ts'));
  await put(
    root,
    'src/index.ts',
    "export const fs = globalThis['process']['getBuiltinModule']('node:fs');\n",
  );
  expect(check(root).output).toContain('RUNTIME_CAPABILITY src/index.ts');
  await put(root, 'src/index.ts', 'export const app = 1;\n');
  await put(root, 'compute/src/index.ts', "export type * from 'cos-alias';\n");
  expect(check(root).output).toContain('COS_ADAPTER compute/src/index.ts');
  await put(root, 'compute/src/index.ts', "export type { Channel } from 'amqp-alias';\n");
  expect(check(root).output).toContain('AMQP_ADAPTER compute/src/index.ts');
  await put(root, 'compute/src/index.ts', "export { DatabaseSync } from 'node:sqlite';\n");
  expect(check(root).output).toContain('RUNTIME_CAPABILITY compute/src/index.ts');
  await put(root, 'compute/src/index.ts', 'export const worker = 1;\n');
  await put(
    root,
    'compute/src/adapters/fs.ts',
    'export const builtin = process.getBuiltinModule(process.argv[2]);\n',
  );
  expect(check(root).output).toContain('DYNAMIC_BUILTIN compute/src/adapters/fs.ts');
});

it('rejects out-of-project adapters and unknown package allowances', async () => {
  const wrong = await fixture();
  await json(wrong, 'harness.config.json', (config) => {
    config.projects.worker!.capabilities = { fs: ['src/index.ts'] };
  });
  expect(check(wrong).output).toContain('PROJECT_ADAPTERS worker');
  const unknown = await fixture();
  await json(unknown, 'harness.config.json', (config) => {
    config.projects.worker!.packageAdapters = { pg: ['compute/src/index.ts'] };
  });
  expect(check(unknown).output).toContain('PROJECT_ADAPTERS worker: unsupported pg');
});

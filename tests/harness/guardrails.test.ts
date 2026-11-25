import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, expect, it } from 'vitest';
import { legacyBuild, legacyHarness, legacyTypecheck } from './fixtures/guardrail-fixture.ts';
import { runGuardrails } from '../../scripts/harness/check-guardrails.ts';
import { loadConfig } from '../../scripts/harness/inventory.ts';

const project = resolve('.');
const scratch: string[] = [];
it.each([
  ['src/profile.ts', 0],
  ['src/other.ts', 1],
  ['src/dsh/profile.ts', 1],
] as const)(
  'limits the formal Profile entry edge into the main plugin: %s',
  async (file, status) => {
    const target = file.startsWith('src/dsh/') ? '../plugin.ts' : './plugin.ts';
    const root = await fixture({
      'src/plugin.ts': 'export const apply = 1;',
      [file]: `export { apply } from '${target}';`,
    });
    const result = await check(root);
    expect(result.status, result.output).toBe(status);
    if (status) expect(result.output).toContain(`ADAPTER_DIRECTION ${file}`);
  },
);
it.each(['src/other.ts', 'src/conversations/indirect.ts', 'src/dsh/indirect.ts'])(
  'rejects production imports and re-exports of the Profile entry: %s',
  async (file) => {
    const target = file === 'src/other.ts' ? './profile.ts' : '../profile.ts';
    const root = await fixture({
      'src/plugin.ts': 'export const apply = 1;',
      'src/profile.ts': "export { apply } from './plugin.ts';",
      [file]: `export { apply } from '${target}';`,
    });
    const result = await check(root);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(`ADAPTER_DIRECTION ${file}: src/profile.ts`);
  },
);
it.each([
  '@earendil-works/pi-ai',
  '@earendil-works/pi-ai/models',
  '@earendil-works/pi-ai/api/openai-completions.lazy',
])('confines the exact pi-ai public entry %s to the DSH adapter', async (entry) => {
  for (const [file, status] of [
    ['src/dsh/pi.ts', 0],
    ['src/dsh-extra/pi.ts', 1],
    ['src/providers/pi.ts', 1],
  ] as const) {
    const root = await fixture({ [file]: `export type * from '${entry}';` });
    await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir');
    const result = await check(root);
    expect(result.status, result.output).toBe(status);
    if (status) expect(result.output).toContain('DSH_BOUNDARY');
  }
});
it('recognizes a pi-ai type alias and rejects business imports of the local DSH adapter', async () => {
  const root = await fixture({ 'src/providers/alias.ts': "export type * from 'pi-alias';" });
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir');
  const path = join(root, 'tsconfig.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.compilerOptions.paths = {
    'pi-alias': [fileURLToPath(import.meta.resolve('@earendil-works/pi-ai/models'))],
  };
  await writeFile(path, JSON.stringify(config));
  expect((await check(root)).output).toContain('DSH_BOUNDARY');
  await writeFile(join(root, 'src/providers/alias.ts'), "export type * from '../dsh/pi.ts';");
  await mkdir(join(root, 'src/dsh'), { recursive: true });
  await writeFile(join(root, 'src/dsh/pi.ts'), 'export interface Value { id: string }');
  expect((await check(root)).output).toContain('DSH_BOUNDARY');
});
it.each([
  'src/materials/service.ts',
  'src/materials/http.ts',
  'src/admin/service.ts',
  'src/admin/http.ts',
])('keeps materials outside framework adapters: %s', async (file) => {
  const root = await fixture({
    'src/dsh/vision.ts': 'export const value=1;',
    [file]: "export {value} from '../dsh/vision.ts';",
  });
  expect((await check(root)).output).toContain('DSH_BOUNDARY');
});
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it.each([
  ['src/integrations/cos.ts', 0],
  ['src/integrations/cos-extra.ts', 1],
  ['src/assets/service.ts', 1],
] as const)('limits COS package imports, including type-only imports: %s', async (file, status) => {
  const root = await fixture({ [file]: "export type * from 'cos-nodejs-sdk-v5';" });
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir');
  const result = await check(root);
  expect(result.status, result.output).toBe(status);
  if (status) expect(result.output).toContain('COS_ADAPTER');
});

it('rejects the COS package under a business import alias', async () => {
  const root = await fixture({ 'src/assets/service.ts': "export type * from 'storage-alias';" });
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir');
  const path = join(root, 'tsconfig.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.compilerOptions.paths = {
    'storage-alias': [createRequire(import.meta.url).resolve('cos-nodejs-sdk-v5')],
  };
  await writeFile(path, JSON.stringify(config));
  expect((await check(root)).output).toContain('COS_ADAPTER');
});

it.each([
  ['scripts/service/import-provider-route.ts', 'src/providers/store.ts', 0],
  ['scripts/service/migrate-materials.ts', 'src/materials/config.ts', 0],
  ['scripts/service/migrate-materials.ts', 'src/materials/schema.ts', 0],
  ['scripts/service/migrate-materials.ts', 'src/materials/auth-schema.ts', 0],
  ['scripts/service/migrate-materials.ts', 'src/materials/auth-store.ts', 1],
  ['scripts/service/migrate-materials.ts', 'src/materials/service.ts', 1],
  ['scripts/service/import-provider-route.ts', 'src/providers/catalog.ts', 1],
  ['scripts/service/import-provider-route.ts', 'src/providers/contracts.ts', 0],
  ['scripts/service/import-provider-route.ts', 'src/providers/service.ts', 1],
  ['scripts/service/import-provider-route.ts', 'src/providers-extra/store.ts', 1],
  ['scripts/harness/deploy.ts', 'src/providers/store.ts', 1],
] as const)(
  'keeps deployment imports exact, including type aliases: %s -> %s',
  async (caller, target, status) => {
    const root = await fixture({
      [target]: 'export interface Value { id: string }',
      [caller]: "export type { Value } from 'deployment-target';",
    });
    const path = join(root, 'tsconfig.json');
    const config = JSON.parse(await readFile(path, 'utf8'));
    config.compilerOptions.paths = { 'deployment-target': [join(root, target)] };
    await writeFile(path, JSON.stringify(config));
    const result = await check(root);
    expect(result.status, result.output).toBe(status);
    if (status) expect(result.output).toContain('DEVELOPMENT_DEPENDENCY');
  },
);

it.each([
  ['src/conversations/store.ts', 0],
  ['src/conversations/schema.ts', 0],
  ['src/conversations/service.ts', 1],
  ['src/conversations-extra/store.ts', 1],
  ['src/providers/store.ts', 0],
  ['src/providers/schema.ts', 0],
  ['src/materials/store.ts', 0],
  ['src/materials/schema.ts', 0],
  ['src/materials/auth-store.ts', 0],
  ['src/materials/auth-schema.ts', 0],
  ['src/materials/auth-service.ts', 1],
  ['src/materials/service.ts', 1],
  ['src/materials-extra/store.ts', 1],
  ['src/providers/service.ts', 1],
  ['src/providers-extra/store.ts', 1],
  ['src/assets/store.ts', 0],
  ['src/assets/schema.ts', 0],
  ['src/assets/service.ts', 1],
  ['src/assets-extra/store.ts', 1],
  ['src/compute/transcode/store.ts', 0],
  ['src/compute/store.ts', 1],
  ['src/compute/schema.ts', 0],
  ['src/compute/media/schema.ts', 0],
  ['src/compute/media/store.ts', 0],
  ['src/compute/observability/store.ts', 0],
  ['src/compute/observability/control.ts', 0],
  ['src/compute/observability/queries.ts', 0],
  ['src/compute/observability/schema.ts', 0],
  ['src/compute/observability/http.ts', 1],
  ['src/compute/database.ts', 0],
  ['src/compute/media/service.ts', 1],
  ['src/compute/media/store-extra.ts', 1],
  ['src/compute-extra/media/store.ts', 1],
  ['src/compute/capacity.ts', 0],
  ['src/compute-extra/capacity.ts', 1],
  ['src/compute/transcode/service.ts', 1],
  ['src/compute-extra/transcode/store.ts', 1],
  ['src/generations/image/store.ts', 0],
  ['src/generations/video/store.ts', 0],
  ['src/generations/video/execution-store.ts', 0],
  ['src/generations/transaction.ts', 0],
  ['src/generations/schema.ts', 0],
  ['src/generations/store.ts', 1],
  ['src/generations/video/service.ts', 1],
  ['src/generations/image/service.ts', 1],
  ['src/generations-extra/image/store.ts', 1],
  ['src/admin/store.ts', 0],
  ['src/admin/schema.ts', 0],
  ['src/admin/service.ts', 1],
] as const)(
  'limits business PostgreSQL imports to reviewed conversation/provider adapters: %s',
  async (file, status) => {
    const root = await fixture({ [file]: "export type { PoolConfig } from 'pg';" });
    await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir');
    const result = await check(root);
    expect(result.status, result.output).toBe(status);
    if (status) expect(result.output).toContain('AUTH_ADAPTER');
  },
);

it.each([
  ['src/conversations/store.ts', 'database-alias', 'pg', 0],
  ['src/conversations/store.ts', 'pg', 'better-auth', 1],
  ['src/providers/store.ts', 'database-alias', 'pg', 0],
  ['src/providers/store.ts', 'pg', 'better-auth', 1],
  ['src/providers/service.ts', 'database-alias', 'pg', 1],
  ['src/assets/store.ts', 'database-alias', 'pg', 0],
  ['src/assets/store.ts', 'pg', 'better-auth', 1],
  ['src/assets/service.ts', 'database-alias', 'pg', 1],
  ['src/compute/transcode/store.ts', 'database-alias', 'pg', 0],
  ['src/compute/transcode/store.ts', 'pg', 'better-auth', 1],
  ['src/compute/transcode/service.ts', 'database-alias', 'pg', 1],
  ['src/generations/image/store.ts', 'database-alias', 'pg', 0],
  ['src/generations/schema.ts', 'database-alias', 'pg', 0],
  ['src/generations/image/service.ts', 'database-alias', 'pg', 1],
  ['src/generations/image/store.ts', 'pg', 'better-auth', 1],
  ['src/admin/store.ts', 'database-alias', 'pg', 0],
  ['src/admin/schema.ts', 'database-alias', 'pg', 0],
  ['src/admin/service.ts', 'database-alias', 'pg', 1],
  ['src/admin/store.ts', 'pg', 'better-auth', 1],
] as const)(
  'keeps package identity checks behind database aliases: %s, %s -> %s',
  async (file, alias, target, status) => {
    const root = await fixture({
      [file]: `import type * as Driver from '${alias}'; export type Value = typeof Driver;`,
    });
    await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir');
    const configPath = join(root, 'tsconfig.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.compilerOptions.paths = { [alias]: [createRequire(import.meta.url).resolve(target)] };
    await writeFile(configPath, JSON.stringify(config));
    const result = await check(root);
    expect(result.status, result.output).toBe(status);
    if (status) expect(result.output).toContain('AUTH_ADAPTER');
  },
);

async function fixture(extra: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'mio-guard-'));
  scratch.push(root);
  await writeFile(join(root, 'harness.config.json'), JSON.stringify(legacyHarness()));
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify(legacyTypecheck()));
  await writeFile(join(root, 'tsconfig.build.json'), JSON.stringify(legacyBuild()));
  for (const [file, text] of Object.entries({
    'README.md': '# Fixture\n',
    'src/value.ts': 'export const value = 1;\n',
    ...extra,
  })) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), text);
  }
  return root;
}

function checkCli(root: string, env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(
    process.execPath,
    [join(project, 'scripts/harness/check-guardrails.ts'), root],
    {
      encoding: 'utf8',
      env,
    },
  );
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

async function check(root: string, env?: NodeJS.ProcessEnv) {
  if (env !== undefined) return checkCli(root, env);
  return runGuardrails(root);
}

it.each([
  ['src/generations/image/files.ts', "export { readFile } from 'fs';", 0],
  ['src/generations/video/media.ts', "export { readFile } from 'node:fs/promises';", 0],
  ['src/generations/files.ts', "export { readFile } from 'fs';", 1],
  ['src/generations/video-media.ts', "export { readFile } from 'fs';", 1],
  ['src/generations/video/media-extra.ts', "export { readFile } from 'fs';", 1],
  ['src/generations/image/files.ts', "export { readFile } from 'node:fs/promises';", 0],
  ['src/generations/image/files.ts', "export const fs = process.getBuiltinModule('node:fs');", 0],
  [
    'src/generations/image/files.ts',
    "export const fs = globalThis['process']['getBuiltinModule']('node:fs');",
    0,
  ],
  ['src/generations/image/files-extra.ts', "export { readFile } from 'fs/promises';", 1],
  ['src/generations-extra/image/files.ts', "export { readFile } from 'node:fs';", 1],
  ['src/generations/image/service.ts', "export const fs = process.getBuiltinModule('fs');", 1],
  ['src/generations/image/files.ts', "export { spawn } from 'node:child_process';", 1],
  ['src/generations/image/files.ts', "export { DatabaseSync } from 'node:sqlite';", 1],
] as const)(
  'confines A durable filesystem access to the exact adapter: %s %s',
  async (file, code, status) => {
    const root = await fixture({ [file]: code });
    const result = await check(root);
    expect(result.status, result.output).toBe(status);
    if (status) expect(result.output).toContain(`RUNTIME_CAPABILITY ${file}`);
  },
);

it('builds a self-contained legacy fixture independent of the host project declarations', async () => {
  const root = await fixture({});
  const config = JSON.parse(await readFile(join(root, 'harness.config.json'), 'utf8')) as {
    projects?: unknown;
    sourceRoots: Record<string, string>;
  };
  expect(config.projects).toBeUndefined();
  expect(
    Object.keys(config.sourceRoots).filter((root) => config.sourceRoots[root] === 'production'),
  ).toEqual(['src']);
  const result = await check(root);
  expect(result.status, result.output).toBe(0);
});

it.each([
  ['src/integrations/redis.ts', 0],
  ['src/auth/limit.ts', 1],
  ['src/plugin.ts', 1],
  ['scripts/service/redis-helper.ts', 1],
  ['tests/redis-fixture.ts', 0],
] as const)(
  'keeps Redis driver imports in the public adapter and test fixtures: %s',
  async (file, status) => {
    const root = await fixture({ [file]: "export { createClient } from '@redis/client';" });
    await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir');
    const result = await check(root);
    expect(result.status, result.output).toBe(status);
    if (status) expect(result.output).toContain('REDIS_ADAPTER');
  },
);

it.each(['src/auth/limit.ts', 'scripts/service/redis-helper.ts'])(
  'checks Redis package ownership behind a paths alias in %s',
  async (file) => {
    const root = await fixture({
      [file]: "export type { RedisClientOptions } from 'driver-alias';",
    });
    await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir');
    const configPath = join(root, 'tsconfig.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.compilerOptions.paths = {
      'driver-alias': [createRequire(import.meta.url).resolve('@redis/client')],
    };
    await writeFile(configPath, JSON.stringify(config));
    const result = await check(root);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('REDIS_ADAPTER');
  },
);

it.each(['src/auth/value.ts', 'tests/value.ts', 'scripts/service/value.ts'])(
  'rejects a reverse Redis dependency on %s',
  async (target) => {
    const root = await fixture({
      [target]: 'export interface Value { id: string }',
      'src/integrations/redis.ts': `export type { Value } from '../../${target}';`,
    });
    const result = await check(root);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('REDIS_DIRECTION');
  },
);

it('allows plugin/auth consumers of public Redis but denies migration tools', async () => {
  const root = await fixture({
    'src/integrations/redis.ts': 'export interface Resource { close(): void }',
    'src/plugin.ts': "export type { Resource } from './integrations/redis.ts';",
    'src/auth/limit.ts': "export type { Resource } from '../integrations/redis.ts';",
  });
  expect((await check(root)).status).toBe(0);
  await mkdir(join(root, 'scripts/service'), { recursive: true });
  await writeFile(
    join(root, 'scripts/service/migrate.ts'),
    "export type { Resource } from '../../src/integrations/redis.ts';",
  );
  const result = await check(root);
  expect(result.status, result.output).toBe(1);
  expect(result.output).toContain('DEVELOPMENT_DEPENDENCY');
});

it('works without personal records; reports a long, low-branch function without blocking it', async () => {
  const root = await fixture({
    'src/long.ts': `export function list() {\nreturn [\n${Array.from({ length: 320 }, (_, i) => `${i},`).join('\n')}\n];\n}\n`,
    'src/new-file.ts': "import { value } from './value.ts';\nexport const next = value + 1;\n",
    '.work/unselected.md': '[ignored](absent-file)\n',
  });
  const result = await check(root);
  expect(result.output).toContain('longestFunction=324');
  expect(result.output).toContain('decisionNodes=0');
  expect(result.status, result.output).toBe(0);
});

it.each([
  ['unsupported extension', { 'src/worker.py': 'print(1)' }, 'SOURCE_UNSUPPORTED'],
  [
    'extensionless source',
    { 'scripts/harness/worker': '#!/usr/bin/env node\nconsole.log(1)' },
    'SOURCE_UNSUPPORTED',
  ],
  ['unclassified new module', { 'worker/run.ts': 'export const run = 1;' }, 'FILE_UNCLASSIFIED'],
  [
    'unsupported top-level task area',
    { 'tasks/wrong.md': '# Wrong task location' },
    'FILE_UNCLASSIFIED',
  ],
  [
    'framework crossing',
    { 'src/other.ts': "export type { Context } from '@deepseek-ai/cordis';" },
    'DSH_BOUNDARY',
  ],
  [
    'runtime imports tooling',
    {
      'src/other.ts': "import '../scripts/harness/tool.ts';",
      'scripts/harness/tool.ts': 'export {};',
    },
    'RUNTIME_DEPENDENCY',
  ],
  [
    'dynamic execution',
    { 'src/other.ts': "import { exec } from 'node:child_process';\nexport { exec };" },
    'RUNTIME_CAPABILITY',
  ],
  ['private document link', { 'README.md': '[private](.work/note.md)' }, 'LINK_PRIVATE'],
  [
    'broken reference link',
    { 'README.md': '[missing][target]\n\n[target]: missing.md' },
    'LINK_MISSING',
  ],
  [
    'circular dependency',
    {
      'src/a.ts': "export { b } from './b.ts';",
      'src/b.ts': "import './a.ts'; export const b = 1;",
    },
    'IMPORT_CYCLE',
  ],
] as const)('rejects %s with an actionable nonzero result', async (_name, files, diagnostic) => {
  const result = await check(await fixture(files));
  expect(result.status, result.output).toBe(1);
  expect(result.output).toContain(diagnostic);
});

it.each(['src/other.ts', 'src/plugin.ts', 'src/dsh/kernel.ts', 'src/dsh-other/kernel.ts'])(
  'checks a valid framework paths alias in %s and preserves local aliases and import-like text',
  async (file) => {
    const root = await fixture({
      'package.json': JSON.stringify({ type: 'module' }),
      [file]: "export type { Context } from 'runtime-alias';",
      'src/local.ts': `export { value } from 'local-alias';
// import '@deepseek-ai/not-a-package';
export const documentation = "import '@deepseek-ai/not-a-package'";`,
    });
    await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir');
    const manifestPath = createRequire(import.meta.url).resolve('@deepseek-ai/cordis/package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { types: string };
    const configPath = join(root, 'tsconfig.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.compilerOptions.paths = {
      'runtime-alias': [join(dirname(manifestPath), manifest.types)],
      'local-alias': ['./src/value.ts'],
    };
    await writeFile(configPath, JSON.stringify(config));
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
    expect(parsed.errors).toEqual([]);
    const diagnostics = ts.getPreEmitDiagnostics(
      ts.createProgram(parsed.fileNames, parsed.options),
    );
    expect(
      diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')),
    ).toEqual([]);
    const result = await check(root);
    const allowed = file === 'src/plugin.ts' || file === 'src/dsh/kernel.ts';
    expect(result.status, result.output).toBe(allowed ? 0 : 1);
    if (!allowed) expect(result.output).toContain(`DSH_BOUNDARY ${file}`);
  },
);

it.each([
  ['@deepseek-ai/cordis', 'directory'],
  ['@example/library', 'directory'],
  ['@deepseek-ai/cordis', 'file'],
  ['@example/library', 'file'],
] as const)(
  'checks the owning package %s through a %s symlink with an unrelated package or directory name',
  async (name, link) => {
    const root = await fixture({
      'package.json': JSON.stringify({ type: 'module' }),
      '.runtime/vendor/package.json': JSON.stringify({ name, version: '1.0.0', type: 'module' }),
      '.runtime/vendor/lib/index.d.ts': 'export interface Context { id: string }',
      'src/other.ts': "export type { Context } from 'runtime-alias';",
    });
    await mkdir(join(root, 'node_modules'));
    const configPath = join(root, 'tsconfig.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.compilerOptions.types = [];
    if (link === 'directory') {
      await symlink(join(root, '.runtime/vendor'), join(root, 'node_modules/indirect'), 'dir');
      config.compilerOptions.paths = {
        'runtime-alias': ['./node_modules/indirect/lib/index.d.ts'],
      };
    } else {
      await mkdir(join(root, 'node_modules/runtime-alias/lib'), { recursive: true });
      await writeFile(
        join(root, 'node_modules/runtime-alias/package.json'),
        JSON.stringify({
          name: '@example/wrapper',
          version: '1.0.0',
          type: 'module',
          types: 'lib/index.d.ts',
        }),
      );
      await symlink(
        join(root, '.runtime/vendor/lib/index.d.ts'),
        join(root, 'node_modules/runtime-alias/lib/index.d.ts'),
      );
    }
    await writeFile(configPath, JSON.stringify(config));
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
    expect(parsed.errors).toEqual([]);
    const diagnostics = ts.getPreEmitDiagnostics(
      ts.createProgram(parsed.fileNames, parsed.options),
    );
    expect(
      diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')),
    ).toEqual([]);
    const result = await check(root);
    expect(result.status, result.output).toBe(name.startsWith('@deepseek-ai/') ? 1 : 0);
    if (name.startsWith('@deepseek-ai/'))
      expect(result.output).toContain('DSH_BOUNDARY src/other.ts');
  },
);

it.each([
  ['framework with format-only metadata', '@deepseek-ai/cordis', undefined, false, 1],
  ['ordinary package with format-only metadata', '@example/library', undefined, false, 0],
  [
    'named ordinary child of a framework package',
    '@deepseek-ai/cordis',
    '@example/child',
    false,
    0,
  ],
  [
    'named framework child of an ordinary package',
    '@example/library',
    '@deepseek-ai/cordis',
    false,
    1,
  ],
  [
    'anonymous dependency nested inside a framework package',
    '@deepseek-ai/cordis',
    undefined,
    true,
    0,
  ],
] as const)(
  'resolves package ownership for %s',
  async (_label, outerName, childName, nestedDependency, expectedStatus) => {
    const base = nestedDependency
      ? 'node_modules/vendor/node_modules/anonymous'
      : 'node_modules/vendor';
    const root = await fixture({
      'package.json': JSON.stringify({ name: '@example/application', type: 'module' }),
      'node_modules/vendor/package.json': JSON.stringify({
        name: outerName,
        version: '1.0.0',
        type: 'module',
      }),
      [`${base}/dist/package.json`]: JSON.stringify({
        type: 'module',
        ...(childName ? { name: childName, version: '1.0.0' } : {}),
      }),
      [`${base}/dist/index.d.ts`]: 'export interface Context { id: string }',
      'src/other.ts': "export type { Context } from 'runtime-alias';",
    });
    const configPath = join(root, 'tsconfig.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.compilerOptions.types = [];
    config.compilerOptions.paths = { 'runtime-alias': [`./${base}/dist/index.d.ts`] };
    await writeFile(configPath, JSON.stringify(config));
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
    expect(parsed.errors).toEqual([]);
    const diagnostics = ts.getPreEmitDiagnostics(
      ts.createProgram(parsed.fileNames, parsed.options),
    );
    expect(
      diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')),
    ).toEqual([]);
    const result = await check(root);
    expect(result.status, result.output).toBe(expectedStatus);
    if (expectedStatus === 1) expect(result.output).toContain('DSH_BOUNDARY src/other.ts');
  },
);

it('accepts same-module development imports and rejects harness/service/type-export crossings', async () => {
  const root = await fixture({
    'scripts/harness/value.ts': 'export const value = 1;',
    'scripts/harness/use.ts': "export { value } from './value.ts';",
    'scripts/service/value.ts': 'export interface Config { port: number }',
  });
  expect((await check(root)).status).toBe(0);
  await writeFile(
    join(root, 'scripts/harness/use.ts'),
    "export type { Config } from '../service/value.ts';",
  );
  expect((await check(root)).output).toContain('DEVELOPMENT_DEPENDENCY');
  await writeFile(join(root, 'scripts/harness/use.ts'), "export { value } from './value.ts';");
  await writeFile(join(root, 'scripts/service/use.ts'), "import '../harness/value.ts';");
  expect((await check(root)).output).toContain('DEVELOPMENT_DEPENDENCY');
});

it('keeps service tooling access to generation contracts exact in the checked-in configuration', async () => {
  const cutover = 'scripts/service/generation-cutover.ts';
  const root = await fixture({
    [cutover]: "import '../../src/generations/image/contracts.ts';",
    'scripts/service/legacy-video-routes.ts': "import '../../src/generations/video/contracts.ts';",
    'src/generations/image/contracts.ts': 'export const version = 1;',
    'src/generations/video/contracts.ts': 'export const version = 1;',
    'src/generations/image/service.ts': 'export const service = 1;',
    'src/generations/contracts.ts': 'export const version = 1;',
  });
  const config = legacyHarness();
  config.developmentDependencies = (await loadConfig(project)).developmentDependencies;
  await writeFile(join(root, 'harness.config.json'), JSON.stringify(config));
  const allowed = await check(root);
  expect(allowed.status, allowed.output).toBe(0);
  for (const path of ['src/generations/image/service.ts', 'src/generations/contracts.ts']) {
    await writeFile(join(root, cutover), "import '../../" + path + "';");
    const forbidden = await check(root);
    expect(forbidden.output).toContain('DEVELOPMENT_DEPENDENCY ' + cutover + ': ' + path);
  }
});

it('checks aliases and dynamic targets across development boundaries, and includes development cycles', async () => {
  const root = await fixture({
    // Keep resolution independent of the enclosing worktree's package type.
    'package.json': JSON.stringify({ type: 'commonjs' }),
    'scripts/harness/a.ts': "import '@service/value';",
    'scripts/service/value.ts': 'export const value = 1;',
  });
  const path = join(root, 'tsconfig.json');
  const config = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8'));
  config.compilerOptions.paths = { '@service/*': ['./scripts/service/*'] };
  await writeFile(path, JSON.stringify(config));
  expect((await check(root)).output).toContain('DEVELOPMENT_DEPENDENCY');
  await writeFile(
    join(root, 'scripts/harness/a.ts'),
    'const target = "../service/value.ts"; void import(target);',
  );
  expect((await check(root)).output).toContain('DYNAMIC_IMPORT');
  await writeFile(join(root, 'scripts/harness/a.ts'), "import './b.ts';");
  await writeFile(join(root, 'scripts/harness/b.ts'), "export * from './a.ts';");
  expect((await check(root)).output).toContain('IMPORT_CYCLE');
});

it('refuses an undeclared script location and a development root with no dependency rules', async () => {
  const root = await fixture({ 'scripts/loose.ts': 'export const value = 1;' });
  expect((await check(root)).output).toContain('FILE_UNCLASSIFIED');
  await rm(join(root, 'scripts/loose.ts'));
  const path = join(root, 'harness.config.json');
  const config = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8'));
  delete config.developmentDependencies;
  await writeFile(path, JSON.stringify(config));
  expect((await check(root)).output).toContain('DEVELOPMENT_RULE_MISSING');
});

it('resolves conditional package aliases in the actual import or require mode', async () => {
  const root = await fixture({
    'package.json': JSON.stringify({
      type: 'module',
      imports: {
        '#tool': {
          import: './scripts/service/value.ts',
          require: './scripts/harness/value.ts',
        },
      },
    }),
    'scripts/harness/value.ts': 'export const value = 1;',
    'scripts/service/value.ts': 'export const value = 2;',
    'scripts/harness/use.ts': "import { value } from '#tool'; export { value };",
  });
  expect((await check(root)).output).toContain('DEVELOPMENT_DEPENDENCY');
  await writeFile(
    join(root, 'scripts/harness/use.ts'),
    "export type Value = typeof import('#tool');",
  );
  expect((await check(root)).output).toContain('DEVELOPMENT_DEPENDENCY');
  await writeFile(join(root, 'scripts/harness/use.ts'), "void import('#tool');");
  expect((await check(root)).output).toContain('DEVELOPMENT_DEPENDENCY');
  await writeFile(join(root, 'scripts/harness/use.ts'), "export const value = require('#tool');");
  expect((await check(root)).status).toBe(0);
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      type: 'module',
      imports: {
        '#tool': {
          import: './scripts/harness/value.ts',
          require: './scripts/service/value.ts',
        },
      },
    }),
  );
  expect((await check(root)).output).toContain('DEVELOPMENT_DEPENDENCY');
  await writeFile(
    join(root, 'scripts/harness/use.ts'),
    "import { value } from '#tool'; export { value }; ",
  );
  expect((await check(root)).status).toBe(0);
});

function git(root: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

it('reports tracked private and configured generated files, including nested package outputs', async () => {
  const excluded = [
    '.work/record.txt',
    'compute/dist/worker.js',
    'contracts/compute/node_modules/package/package.json',
    'packages/foundation/dist/index.js',
  ];
  const root = await fixture({
    ...Object.fromEntries(excluded.map((path) => [path, 'private fixture content'])),
    '.env.example': 'PUBLIC_TEMPLATE=value',
  });
  const config = { ...legacyHarness(), generatedRoots: (await loadConfig(project)).generatedRoots };
  await writeFile(join(root, 'harness.config.json'), JSON.stringify(config));
  git(root, 'init', '-q');
  git(root, 'add', '-f', ...excluded, '.env.example');
  const result = await check(root);
  expect(result.status).toBe(1);
  expect(result.output).toContain('Git index: checked');
  expect(result.output.match(/INDEX_PRIVATE [^\n]+/g)?.sort()).toEqual(
    excluded.map((path) => `INDEX_PRIVATE ${path}`).sort(),
  );
  expect(result.output).not.toContain('private fixture content');
});

it('passes a source export and fails an unreadable index in regular and linked worktrees', async () => {
  const root = await fixture({});
  const noGit = { ...process.env, PATH: join(root, 'missing-directory') };
  const exported = await check(root, noGit);
  expect(exported.status, exported.output).toBe(0);
  expect(exported.output).toContain('Git index: unavailable (not verified)');

  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-qm',
    'fixture',
  );
  const worktree = `${root}-linked`;
  scratch.push(worktree);
  git(root, 'worktree', 'add', '-q', '--detach', worktree);
  expect((await readFile(join(worktree, '.git'), 'utf8')).startsWith('gitdir: ')).toBe(true);
  for (const checkout of [root, worktree]) {
    const available = await check(checkout);
    expect(available.status, available.output).toBe(0);
    expect(available.output).toContain('Git index: checked');
    const missingExecutable = await check(checkout, noGit);
    expect(missingExecutable.status, missingExecutable.output).toBe(1);
    expect(missingExecutable.output).toContain('INDEX_READ');
    const index = resolve(checkout, git(checkout, 'rev-parse', '--git-path', 'index'));
    await writeFile(index, 'Corrupted Git index fixture\n');
    const corruptIndex = await check(checkout);
    expect(corruptIndex.status, corruptIndex.output).toBe(1);
    expect(corruptIndex.output).toContain('INDEX_READ');
  }
});

it('requires projects when a second production root is classified', async () => {
  const root = await fixture({ 'worker/run.ts': "export const count: number = 'wrong';\n" });
  const configuration = JSON.parse(
    await (await import('node:fs/promises')).readFile(join(root, 'harness.config.json'), 'utf8'),
  ) as { sourceRoots: Record<string, string> };
  configuration.sourceRoots.worker = 'production';
  await writeFile(join(root, 'harness.config.json'), JSON.stringify(configuration));
  const result = await check(root);
  expect(result.status, result.output).toBe(1);
  expect(result.output).toContain('PROJECTS_REQUIRED');
});

it('rejects a legacy build that suppresses executable output', async () => {
  const root = await fixture({});
  const path = join(root, 'tsconfig.build.json');
  const config = JSON.parse(await readFile(path, 'utf8')) as {
    compilerOptions: { noEmit?: boolean };
  };
  config.compilerOptions.noEmit = true;
  await writeFile(path, JSON.stringify(config));
  expect((await check(root)).output).toContain('PROJECT_BUILD_EMIT root');
});

it('allows only the explicit service migration config edge and isolates auth packages', async () => {
  const root = await fixture({
    'src/auth/config.ts': 'export const value = 1;',
    'src/auth/service.ts': 'export const service = 1;',
    'scripts/service/migrate.ts':
      "import { value } from '../../src/auth/config.ts'; export { value };",
  });
  expect((await check(root)).status).toBe(0);
  await writeFile(
    join(root, 'scripts/service/migrate.ts'),
    "export { service } from '../../src/auth/service.ts';",
  );
  expect((await check(root)).output).toContain('DEVELOPMENT_DEPENDENCY');
  await writeFile(join(root, 'scripts/service/migrate.ts'), 'export {};');
  await writeFile(join(root, 'src/bypass.ts'), "import { Pool } from 'pg'; export { Pool };");
  expect((await check(root)).output).toContain('AUTH_ADAPTER');
  await rm(join(root, 'src/bypass.ts'));
  await writeFile(join(root, 'src/auth/service.ts'), "import { Pool } from 'pg'; export { Pool };");
  expect((await check(root)).status).toBe(0);
  await writeFile(join(root, 'src/bypass.ts'), "export { authOptions } from 'better-auth';");
  expect((await check(root)).output).toContain('AUTH_ADAPTER');
});

it.each([
  ['src/http-request.ts', 'HTTP_REQUEST_DEPENDENCY'],
  ['src/http-response.ts', 'HTTP_RESPONSE_DEPENDENCY'],
] as const)(
  'keeps HTTP primitive dependencies independent through resolved imports: %s',
  async (file, diagnostic) => {
    const root = await fixture({
      'src/contracts.ts': 'export interface ApiError { error: { code: string } }',
      'src/auth/value.ts': 'export interface AuthValue { id: string }',
      'src/assets/value.ts': 'export const asset = 1;',
      'src/plugin.ts': 'export const plugin = 1;',
      'scripts/harness/tool.ts': 'export const tool = 1;',
      'src/http-request.ts':
        "import type { IncomingMessage } from 'node:http'; export type Request = IncomingMessage;",
      'src/http-response.ts': `import type { ServerResponse } from 'node:http';
import type { ApiError } from './contracts.ts';
export function start(response: ServerResponse): ApiError { return { error: { code: String(response.statusCode) } }; }`,
      'src/assets/http.ts': "import '../http-request.ts'; import '../http-response.ts';",
      'src/compute/transcode/http.ts':
        "import '../../http-request.ts'; import '../../http-response.ts';",
    });
    expect((await check(root)).status).toBe(0);
    const configPath = join(root, 'tsconfig.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.compilerOptions.paths = {
      '@contract': ['./src/contracts.ts'],
      '@auth-value': ['./src/auth/value.ts'],
    };
    await writeFile(configPath, JSON.stringify(config));
    const helper = join(root, file);
    const allowed = [
      "export type { IncomingMessage } from 'node:http';",
      "export const http = () => import('node:http');",
      ...(file === 'src/http-response.ts' ? ["export type { ApiError } from '@contract';"] : []),
    ];
    for (const source of allowed) {
      await writeFile(helper, source);
      const result = await check(root);
      expect(result.status, source + result.output).toBe(0);
    }
    const rejected = [
      "import type { AuthValue } from './auth/value.ts'; export type Value = AuthValue;",
      "export type { AuthValue } from './auth/value.ts';",
      "import type { AuthValue } from '@auth-value'; export type Value = AuthValue;",
      "export type Value = import('@auth-value').AuthValue;",
      "export { plugin } from './plugin.ts';",
      "export { Pool } from 'pg';",
      "import '../scripts/harness/tool.ts';",
      "export { URL } from 'node:url';",
      "export { randomUUID } from 'node:crypto';",
      "export const asset = () => import('./assets/value.ts');",
      ...(file === 'src/http-request.ts' ? ["export type { ApiError } from '@contract';"] : []),
    ];
    for (const source of rejected) {
      await writeFile(helper, source);
      const result = await check(root);
      expect(result.status, source + result.output).toBe(1);
      expect(result.output, source).toContain(`${diagnostic} ${file}`);
    }
    config.compilerOptions.paths['node:http'] = ['./src/auth/value.ts'];
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(helper, "export type { IncomingMessage } from 'node:http';");
    const disguised = await check(root);
    expect(disguised.status, disguised.output).toBe(1);
    expect(disguised.output).toContain(`${diagnostic} ${file}`);
  },
);

it.each(['src/plugin.ts', 'src/auth/query.ts'])(
  'resolves database and authentication type aliases before checking the boundary in %s',
  async (file) => {
    const root = await fixture({
      'package.json': JSON.stringify({ type: 'module' }),
      [file]:
        "export type { Pool } from 'database-alias'; export type { BetterAuthOptions } from 'authentication-alias';",
    });
    await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir');
    const configPath = join(root, 'tsconfig.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.compilerOptions.paths = {
      'database-alias': [join(project, 'node_modules/@types/pg/index.d.ts')],
      'authentication-alias': [join(project, 'node_modules/better-auth/dist/index.d.mts')],
    };
    await writeFile(configPath, JSON.stringify(config));
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
    expect(parsed.errors).toEqual([]);
    const diagnostics = ts.getPreEmitDiagnostics(
      ts.createProgram(parsed.fileNames, parsed.options),
    );
    expect(
      diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')),
    ).toEqual([]);
    const result = await check(root);
    expect(result.status, result.output).toBe(file.startsWith('src/auth/') ? 0 : 1);
    if (file === 'src/plugin.ts') expect(result.output.match(/AUTH_ADAPTER/g)).toHaveLength(2);
  },
);

it('exits 0 on pass and 1 on failure when invoked directly through the CLI entrypoint', async () => {
  const passing = checkCli(await fixture({}));
  expect(passing.status, passing.output).toBe(0);
  expect(passing.output).toContain('Guardrails passed for the declared scope.');

  const failing = checkCli(await fixture({ 'src/worker.py': 'print(1)' }));
  expect(failing.status, failing.output).toBe(1);
  expect(failing.output).toContain('SOURCE_UNSUPPORTED');
});

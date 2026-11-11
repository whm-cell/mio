import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { checkDocuments } from '../scripts/harness/check-documents.ts';
import { inventory } from '../scripts/harness/inventory.ts';
import type { HarnessConfig, TaskDocument } from '../scripts/harness/inventory.ts';
import { headingAnchors, markdownLinks, parseMarkdown } from '../scripts/harness/markdown.ts';
import { taskDocumentFiles, taskIndex, writeTaskDocuments } from './task-documents-fixture.ts';
import { inspectTaskDocuments } from '../scripts/harness/task-documents.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const config: HarnessConfig = {
  sourceRoots: {},
  developmentDependencies: {},
  documentRoots: ['README.md', 'docs'],
  privateRoots: ['.work', '.runtime'],
  generatedRoots: ['.git'],
  configurationFiles: [],
};
const endpoint =
  '## GET /api/session\n\n身份：Cookie。\n\n输入：无正文。\n\n成功：会话或 null。\n\n错误：按本域约定。\n\n副作用：可能刷新会话。\n';
async function fixture(extra: Record<string, string> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mio-documents-')));
  roots.push(root);
  for (const [path, text] of Object.entries({
    'README.md': '[资料](docs/index.md)\n',
    'docs/index.md': '[API](apis/index.md) [指南](guide.md#api-使用-1)\n',
    'docs/guide.md': '# Guide\n\n## API 使用\n\n## API 使用\n',
    'docs/apis/index.md': '[认证](auth.md)\n',
    'docs/apis/auth.md': '# Auth\n\n' + endpoint,
    ...extra,
  })) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}
type FixtureConfig = HarnessConfig & { documents?: TaskDocument[] };
async function errors(root: string, configuration: FixtureConfig = config) {
  if (configuration.documents)
    await writeTaskDocuments(root, configuration.documents, 'docs/tasks/example');
  return (await checkDocuments(root, (await inventory(root, configuration)).files, configuration))
    .errors;
}

it('discovers active documents without private records and resolves duplicate, encoded and reference anchors', async () => {
  const root = await fixture({
    'docs/index.md':
      '[API](apis/index.md) [指南][guide]\n\n[guide]: guide.md#api-%E4%BD%BF%E7%94%A8-1\n',
  });
  expect(await errors(root)).toEqual([]);
  const tree = parseMarkdown(
    '# Real\n\n```md\n# Pretend\n```\n\n[ref][x]\n\n[x]: other.md#target\n',
  );
  expect([...headingAnchors(tree)]).toEqual(['real']);
  expect(markdownLinks(tree).links).toContain('other.md#target');
});

it('rejects missing active anchors, undiscoverable pages and an undiscoverable entry', async () => {
  const root = await fixture({
    'docs/guide.md': '# Guide\n\n## Renamed\n',
    'docs/orphan.md': '# Hidden contract\n',
  });
  expect(await errors(root)).toEqual(
    expect.arrayContaining([
      'LINK_ANCHOR docs/index.md: guide.md#api-使用-1',
      'DOCUMENT_UNREACHABLE docs/orphan.md',
    ]),
  );
  await writeFile(join(root, 'README.md'), '# Entry\n');
  expect(await errors(root)).toContain('DOCUMENT_UNREACHABLE docs/index.md');
});

it('allows the public root env template link but rejects private env links and template aliases', async () => {
  const root = await fixture({
    '.env.example': 'EXAMPLE=value\n',
    '.env': 'PRIVATE=value\n',
    '.env.test': 'PRIVATE=test\n',
    'docs/.env.example': 'PRIVATE=nested\n',
    'README.md': '[资料](docs/index.md) [模板](.env.example)\n',
  });
  expect(await errors(root)).toEqual([]);
  await writeFile(
    join(root, 'README.md'),
    '[资料](docs/index.md) [dev](.env) [test](.env.test) [nested](docs/.env.example)\n',
  );
  expect(await errors(root)).toEqual(
    expect.arrayContaining([
      'LINK_PRIVATE README.md: .env',
      'LINK_PRIVATE README.md: .env.test',
      'LINK_PRIVATE README.md: docs/.env.example',
    ]),
  );
  await writeFile(join(root, 'README.md'), '[资料](docs/index.md) [模板](.env.example)\n');
  await rm(join(root, '.env.example'));
  await symlink(join(root, '.env'), join(root, '.env.example'));
  expect(await errors(root)).toContain('LINK_PRIVATE README.md: .env.example');
});

it('recognizes real compatibility anchors without accepting tags inside HTML comments or scripts', async () => {
  const root = await fixture({
    'docs/index.md': '[API](apis/index.md) [Guide](guide.md#real-anchor)\n',
    'docs/guide.md':
      '# Guide\n\n<a id="real-anchor"></a>\n\n<!-- <a id="comment-anchor"></a> -->\n\n<script>const sample = \'<a id="script-anchor"></a>\';</script>\n',
  });
  expect(await errors(root)).toEqual([]);
  for (const anchor of ['comment-anchor', 'script-anchor']) {
    await writeFile(
      join(root, 'docs/index.md'),
      `[API](apis/index.md) [Guide](guide.md#${anchor})\n`,
    );
    expect(await errors(root)).toContain(`LINK_ANCHOR docs/index.md: guide.md#${anchor}`);
  }
});

it('does not exempt retired history directories from path, anchor or classification checks', async () => {
  const path = 'docs/tasks/history/old.md';
  const root = await fixture({
    [path]:
      '[old](../../guide.md#old-version-title) [private](../../../.work/log.md)\n\n/Users/someone/private\n',
  });
  const result = await errors(root);
  expect(result).toContain(`PERSONAL_PATH ${path}`);
  expect(result).toContain(`LINK_PRIVATE ${path}: ../../../.work/log.md`);
  expect(result.some((entry) => entry.startsWith(`LINK_ANCHOR ${path}`))).toBe(true);
  expect(result).toContain(`TASK_DOCUMENT_UNCLASSIFIED ${path}`);
});

it('checks unused link definitions and does not discover active contracts through result prose', async () => {
  const root = await fixture({
    'docs/index.md':
      '[API](apis/index.md) [Guide](guide.md) [Result](tasks/example/complete/note.md)\n',
    'docs/tasks/example/complete/note.md': '[Contract](../../../hidden.md)\n',
    'docs/hidden.md': '# Active contract\n',
    'docs/guide.md': '# Guide\n\n[unused]: ../.work/private.md\n',
  });
  const result = await errors(root);
  expect(result).toContain('LINK_PRIVATE docs/guide.md: ../.work/private.md');
  expect(result).toContain('DOCUMENT_UNREACHABLE docs/hidden.md');
});

it('keeps unused and shadowed definitions out of navigation while validating their destinations', async () => {
  const root = await fixture({
    'docs/index.md':
      '[API](apis/index.md) [Guide][chosen]\n\n[unused]: hidden.md\n[chosen]: guide.md\n[chosen]: hidden.md\n',
    'docs/hidden.md': '# Hidden contract\n',
  });
  expect(await errors(root)).toEqual(['DOCUMENT_UNREACHABLE docs/hidden.md']);
});

it('uses decoded, validated navigation paths for API domain discovery', async () => {
  const root = await fixture({ 'docs/apis/index.md': '[Auth](auth%2Emd#auth)\n' });
  expect(await errors(root)).toEqual([]);
});

it('rejects duplicate endpoint identities, malformed locations, missing fields and unlinked API domains', async () => {
  const root = await fixture({
    'docs/apis/other.md': '# Other\n\n' + endpoint + '\n## GTE /bad\n',
    'docs/apis/auth.md': '# Auth\n\n' + endpoint.replace('副作用：可能刷新会话。', ''),
  });
  const result = await errors(root);
  expect(result).toContain('API_DOMAIN_UNLINKED docs/apis/other.md');
  expect(result).toContain('API_FIELD docs/apis/auth.md: GET /api/session: 副作用');
  expect(result.some((entry) => entry.startsWith('API_DUPLICATE GET /api/session'))).toBe(true);
  expect(result).toContain('API_ENDPOINT_INVALID docs/apis/other.md: GTE /bad');
});

const taskConfig: FixtureConfig = {
  ...config,
  documents: [
    {
      identity: 'docs/old-prd.md',
      kind: 'prd',
      path: 'docs/tasks/example/prd.md',
      aliases: ['docs/old-prd.md'],
    },
  ],
};
async function taskFixture(extra: Record<string, string> = {}) {
  return fixture({
    'docs/index.md': '[API](apis/index.md) [Guide](guide.md) [Tasks](tasks/index.md)\n',
    'harness.config.json': JSON.stringify(config),
    ...taskDocumentFiles(taskConfig.documents!),
    'docs/tasks/index.md': taskIndex,
    'docs/tasks/example/prd.md': '# Requirement\n\n## Old section\n',
    'docs/old-prd.md':
      '# 资料已迁移\n\n[当前资料](../docs/tasks/example/prd.md)\n\n- <a id="old-section"></a>[Old section](../docs/tasks/example/prd.md#old-section)\n',
    ...extra,
  });
}

it('classifies task documents and keeps compatibility aliases as navigation leaves with real anchors', async () => {
  const root = await taskFixture();
  expect(await errors(root, taskConfig)).toEqual([]);
  await writeFile(
    join(root, 'docs/old-prd.md'),
    '# 资料已迁移\n\n[当前资料][current]\n\n[current]: ../docs/tasks/example/prd%2Emd?view=1\n',
  );
  expect(await errors(root, taskConfig)).toEqual([]);
  expect(headingAnchors(parseMarkdown('<a id="old-section"></a>\n'))).toContain('old-section');
  await writeFile(
    join(root, 'docs/old-prd.md'),
    '# 资料已迁移\n\n[当前资料](../docs/tasks/example/prd%2Emd?view=1)\n\n- <a id="old-section"></a>[Old section](../docs/tasks/example/prd%2Emd#old-section)\n',
  );
  expect(await errors(root, taskConfig)).toEqual([]);
  // A registered alias is a backward entry, not an alternate way to discover active task prose.
  await writeFile(
    join(root, 'docs/index.md'),
    '[API](apis/index.md) [Guide](guide.md) [Old](old-prd.md)\n',
  );
  expect(await errors(root, taskConfig)).toContain(
    'DOCUMENT_UNREACHABLE docs/tasks/example/prd.md',
  );
});

it('allows a stable identity without a redirect file while requiring real targets and declared aliases', async () => {
  const root = await taskFixture();
  const entry = { ...taskConfig.documents![0]!, aliases: [] };
  const registry = { ...taskConfig, documents: [entry] };
  await rm(join(root, entry.identity));
  await writeFile(join(root, 'harness.config.json'), JSON.stringify(config));
  expect(await errors(root, registry)).toEqual([]);
  // Retiring a navigation page does not make an ordinary Markdown link to it valid.
  await writeFile(join(root, entry.path), '# Requirement\n\n[Retired](../../old-prd.md)\n');
  expect((await errors(root, registry)).some((error) => error.includes('LINK_MISSING'))).toBe(true);
  await writeFile(join(root, entry.path), '# Requirement\n');
  expect(
    (await errors(root, taskConfig)).some((error) => error.includes('TASK_DOCUMENT_INVALID')),
  ).toBe(true);
  await rm(join(root, entry.path));
  expect(
    (await errors(root, registry)).some((error) => error.includes('TASK_DOCUMENT_INVALID')),
  ).toBe(true);
});

it('rejects a stable identity that shadows an existing ordinary document', async () => {
  const root = await taskFixture();
  const checked = await errors(root, {
    ...taskConfig,
    documents: [{ ...taskConfig.documents![0]!, identity: 'docs/guide.md', aliases: [] }],
  });
  expect(checked.some((error) => error.includes('TASK_DOCUMENT_IDENTITY'))).toBe(true);
});

it.each(['../outside.md', '.work/private.md', 'docs/../outside.md', 'docs/.env.secret.md'])(
  'rejects an unsafe stable identity even when it has no physical file: %s',
  async (identity) => {
    const root = await taskFixture();
    const checked = await errors(root, {
      ...taskConfig,
      documents: [{ ...taskConfig.documents![0]!, identity, aliases: [] }],
    });
    expect(checked.some((error) => error.includes('TASK_DOCUMENT_INVALID'))).toBe(true);
  },
);

it('rejects unknown task pages, lost result entries and discovery through historical prose', async () => {
  const root = await taskFixture({
    'docs/tasks/unknown.md': '# Unclassified\n',
    'docs/tasks/index.md': '# Broken result index\n',
    'docs/tasks/history/old.md': '# Retired history\n',
    'docs/index.md': '[API](apis/index.md) [Guide](guide.md) [History](tasks/history/old.md)\n',
  });
  expect(await errors(root, taskConfig)).toEqual(
    expect.arrayContaining([
      'TASK_DOCUMENT_UNCLASSIFIED docs/tasks/unknown.md',
      'DOCUMENT_UNREACHABLE docs/tasks/example/prd.md',
      'DOCUMENT_UNREACHABLE docs/tasks/index.md',
    ]),
  );
});

it('does not discover active requirements or current norms through accepted-result prose', async () => {
  const root = await taskFixture({
    'docs/index.md':
      '[API](apis/index.md) [Guide](guide.md) [Result](tasks/example/complete/note.md)\n',
    'docs/tasks/example/complete/note.md': '[Requirements](../prd.md) [Norm](../../../hidden.md)\n',
    'docs/hidden.md': '# Current normative page\n',
  });
  const checked = await errors(root, taskConfig);
  expect(checked).toContain('DOCUMENT_UNREACHABLE docs/tasks/example/prd.md');
  expect(checked).toContain('DOCUMENT_UNREACHABLE docs/hidden.md');
});

it('rejects duplicate identities, current paths and aliases, missing targets, and substantive alias prose', async () => {
  const root = await taskFixture({ 'docs/tasks/example/another.md': '# Another\n' });
  const first = taskConfig.documents![0]!;
  for (const entry of [
    { ...first },
    { ...first, identity: 'docs/tasks/example/prd.md', aliases: [] },
    {
      ...first,
      identity: 'docs/tasks/example/another.md',
      path: 'docs/tasks/example/another.md',
      aliases: ['docs/old-prd.md'],
    },
  ]) {
    const checked = await errors(root, { ...taskConfig, documents: [first, entry] });
    expect(checked.some((error) => error.includes('TASK_DOCUMENT_DUPLICATE'))).toBe(true);
  }
  expect(
    (
      await errors(root, {
        ...taskConfig,
        documents: [
          {
            identity: 'docs/tasks/missing.md',
            kind: 'proposal',
            path: 'docs/tasks/missing.md',
          },
        ],
      })
    ).some((error) => error.includes('TASK_DOCUMENT_INVALID')),
  ).toBe(true);
  await writeFile(
    join(root, 'docs/old-prd.md'),
    '# 资料已迁移\n\n[当前资料](../docs/tasks/example/prd.md)\n\nContinue maintaining a second specification here.\n',
  );
  expect(
    (await errors(root, taskConfig)).some((error) => error.startsWith('TASK_DOCUMENT_REDIRECT')),
  ).toBe(true);
});

it.each([
  '../outside.md',
  '.work/private.md',
  'docs/tasks/../outside.md',
  'docs/tasks/link.md',
  'tasks/wrong.md',
  'docs/tasks/complete/wrong.md',
])('rejects unsafe registered documents %s', async (path) => {
  const root = await taskFixture();
  if (path === 'docs/tasks/link.md')
    await symlink(join(root, 'docs/tasks/example/prd.md'), join(root, path));
  const checked = await errors(root, {
    ...taskConfig,
    documents: [{ identity: path, kind: 'proposal', path }],
  });
  expect(checked.some((error) => error.startsWith('TASK_DOCUMENT_INVALID'))).toBe(true);
});

it('offers the real read-only documents CLI without a member directory or an automatic migration', async () => {
  const root = await taskFixture();
  const configPath = join(root, 'harness.config.json');
  const raw = JSON.stringify({
    ...config,
    sourceRoots: { src: 'production' },
    configurationFiles: ['harness.config.json'],
  });
  await writeFile(configPath, raw);
  const result = spawnSync(
    process.execPath,
    [resolve('scripts/harness/work/cli.ts'), 'documents'],
    { cwd: root, encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    documents: [
      {
        kind: 'prd',
        identity: 'docs/old-prd.md',
        currentPath: 'docs/tasks/example/prd.md',
        aliases: ['docs/old-prd.md'],
        registry: 'docs/tasks/example/documents.json',
      },
    ],
    results: [
      {
        prd: 'docs/old-prd.md',
        report: null,
        records: null,
        keys: [],
        read: ['read-result', 'docs/old-prd.md'],
      },
    ],
    issues: [],
  });
  expect(await readFile(configPath, 'utf8')).toBe(raw);
  await expect(readFile(join(root, '.work/member.json'))).rejects.toHaveProperty('code', 'ENOENT');
});

it('registers shared pending proposals under their PRD and rejects orphan or misclassified designs', async () => {
  const proposal = 'docs/tasks/example/pending/choice.md';
  const root = await taskFixture({ [proposal]: '# Unadopted option\n' });
  const registry: FixtureConfig = {
    ...taskConfig,
    documents: [...taskConfig.documents!, { identity: proposal, path: proposal, kind: 'proposal' }],
  };
  await writeFile(join(root, 'harness.config.json'), JSON.stringify(config));
  await writeFile(join(root, 'docs/tasks/index.md'), taskIndex);
  expect(await errors(root, registry)).toEqual([]);
  registry.documents!.at(-1)!.kind = 'design';
  expect(
    (await errors(root, registry)).some((error) => error.includes('TASK_DOCUMENT_OWNER')),
  ).toBe(true);
  const orphan = 'docs/tasks/orphan/design.md';
  await mkdir(dirname(join(root, orphan)), { recursive: true });
  await writeFile(join(root, orphan), '# Unowned design\n');
  registry.documents!.at(-1)!.path = orphan;
  registry.documents!.at(-1)!.identity = orphan;
  expect(
    (await errors(root, registry)).some((error) => error.includes('TASK_DOCUMENT_OWNER')),
  ).toBe(true);
});

it('requires an independently named PRD directory with prd.md as its registered current path', async () => {
  const wrong = 'docs/tasks/example/another-prd.md';
  const root = await taskFixture({ [wrong]: '# Invalid second PRD\n' });
  const checked = await errors(root, {
    ...taskConfig,
    documents: [...taskConfig.documents!, { identity: wrong, path: wrong, kind: 'prd' }],
  });
  expect(checked.some((error) => error.startsWith('TASK_DOCUMENT_LOCATION'))).toBe(true);
});

it('validates local registry schemas, cross-PRD identity collisions and exact JSON classification', async () => {
  const root = await taskFixture();
  const registry = join(root, 'docs/tasks/example/documents.json');
  for (const value of [
    [],
    { version: 2, documents: taskConfig.documents },
    { version: 1, documents: [] },
    { version: 1, documents: taskConfig.documents, unknown: true },
  ]) {
    await writeFile(registry, JSON.stringify(value));
    expect((await inspectTaskDocuments(root, config)).errors.join()).toContain(
      'TASK_DOCUMENT_SCHEMA',
    );
  }
  await writeTaskDocuments(root, taskConfig.documents!, 'docs/tasks/example');
  const other = 'docs/tasks/another/prd.md';
  await mkdir(dirname(join(root, other)), { recursive: true });
  await writeFile(join(root, other), '# Another PRD\n');
  await writeTaskDocuments(
    root,
    [{ identity: 'docs/old-prd.md', kind: 'prd', path: other }],
    'docs/tasks/another',
  );
  expect((await inspectTaskDocuments(root, config)).errors.join()).toContain(
    'TASK_DOCUMENT_DUPLICATE',
  );
  await writeFile(join(root, 'docs/tasks/example/other.json'), '{}');
  expect((await inventory(root, config)).errors).toContain(
    "DOCUMENT_UNCLASSIFIED docs/tasks/example/other.json: declare the asset's purpose",
  );
  expect(
    (await inventory(root, config)).errors.some((error) => error.includes('documents.json')),
  ).toBe(false);
});

it('rejects symbolic registry files without weakening ordinary registry discovery', async () => {
  const root = await taskFixture();
  const registry = join(root, 'docs/tasks/example/documents.json');
  const bytes = await readFile(registry, 'utf8');
  await mkdir(join(root, '.work'), { recursive: true });
  const outside = join(root, '.work/registry.json');
  await writeFile(outside, bytes);
  await rm(registry);
  await symlink(outside, registry);
  expect((await inspectTaskDocuments(root, config)).errors.join()).toContain('WORK_SYMLINK');
  expect((await inventory(root, config)).errors).toContain(
    'INVENTORY_SYMLINK docs/tasks/example/documents.json: classify a real file',
  );
});

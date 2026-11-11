import { spawnSync } from 'node:child_process';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { format } from 'prettier';
import { inspectTaskDocuments } from '../../scripts/harness/task-documents.ts';
import { inventory, loadConfig } from '../../scripts/harness/inventory.ts';
import type { TaskDocument } from '../../scripts/harness/inventory.ts';
import { checkDocuments } from '../../scripts/harness/check-documents.ts';
import { taskDocumentFiles, taskIndex, taskIndexPath } from './fixtures/task-documents-fixture.ts';

const project = resolve('.');
const cli = join(project, 'scripts/harness/work/cli.ts');
const prd = 'docs/tasks/product/prd.md';
const index = 'docs/tasks/product/changes/index.md';
const roots: string[] = [];
const cardPath = (id: string) => `docs/tasks/product/changes/${id}/change.md`;
const card = (id: string, section = 'Flow') =>
  `# Change ${id}\n\n\`\`\`mio-change\n{"version":1,"type":"fix","section":"${section}"}\n\`\`\`\n\nPrivate detail for ${id}.\n`;
const registration = (id: string): TaskDocument => ({
  kind: 'change',
  identity: cardPath(id),
  path: cardPath(id),
});
function invoke(root: string, args: string[], input?: unknown) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    ...(input === undefined ? {} : { input: JSON.stringify(input) }),
  });
  return {
    ...result,
    output: `${result.stdout}\n${result.stderr}`,
    value: () => JSON.parse(result.stdout),
  };
}
async function fixture(ids: string[] = []) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mio-changes-')));
  roots.push(root);
  const config = await loadConfig(project);
  const documents: TaskDocument[] = [
    { kind: 'prd', identity: prd, path: prd },
    ...ids.map(registration),
  ];
  const files = {
    'harness.config.json': JSON.stringify(config),
    'package.json': '{"type":"module"}\n',
    '.gitignore': '.work/\n',
    'AGENTS.md': '[Docs](docs/index.md)\n',
    'README.md': '[Docs](docs/index.md)\n',
    'docs/index.md':
      '[Tasks](tasks/index.md) [Coordination](coordination.md) [Records](work-records.md)\n',
    'docs/coordination.md': '# Coordination\n',
    'docs/work-records.md': '# Records\n',
    [taskIndexPath]: taskIndex,
    [prd]: '# Product\n\n## Flow\n\n[Changes](changes/index.md)\n',
    ...taskDocumentFiles(documents),
    ...Object.fromEntries(ids.map((id) => [cardPath(id), card(id)])),
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  expect(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root }).status).toBe(0);
  return { root, config, documents };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('validates change ownership, stable paths, metadata and a unique real parent section', async () => {
  const { root, config, documents } = await fixture(['bug']);
  expect((await inspectTaskDocuments(root, config)).errors).toEqual([]);
  for (const source of [
    card('bug', 'Missing'),
    card('bug').replace('"version":1', '"version":2'),
    card('bug').replace('"fix"', '"other"'),
    card('bug') + '\n# Another title\n',
    card('bug') + '\n```mio-change\n{}\n```\n',
    card('bug') + '\n> # Nested title\n',
  ]) {
    await writeFile(join(root, cardPath('bug')), source);
    expect((await inspectTaskDocuments(root, config)).errors.join('\n')).toContain(
      'TASK_CHANGE_INVALID',
    );
  }
  await writeFile(join(root, cardPath('bug')), card('bug'));
  await writeFile(join(root, prd), '# Product\n\n## Flow\n\n## Flow\n');
  expect((await inspectTaskDocuments(root, config)).errors.join('\n')).toContain(
    'TASK_CHANGE_SECTION',
  );
  await writeFile(join(root, prd), '# Product\n\n## Flow\n');
  await writeFile(
    join(root, 'docs/tasks/product/documents.json'),
    JSON.stringify({
      version: 1,
      documents: [documents[0], { ...documents[1], identity: 'docs/tasks/product/old-change.md' }],
    }),
  );
  expect((await inspectTaskDocuments(root, config)).errors.join('\n')).toContain(
    'TASK_CHANGE_LOCATION',
  );
  const stable = { ...documents[1]!, identity: 'docs/tasks/retired/changes/bug/change.md' };
  await writeFile(
    join(root, 'docs/tasks/product/documents.json'),
    JSON.stringify({ version: 1, documents: [documents[0], stable] }),
  );
  expect((await inspectTaskDocuments(root, config)).errors).toEqual([]);
  await mkdir(dirname(join(root, stable.identity)), { recursive: true });
  await writeFile(
    join(root, stable.identity),
    '# 资料已迁移\n\n[当前资料](../../../product/changes/bug/change.md)\n',
  );
  await writeFile(
    join(root, 'docs/tasks/product/documents.json'),
    JSON.stringify({
      version: 1,
      documents: [documents[0], { ...stable, aliases: [stable.identity] }],
    }),
  );
  expect((await inspectTaskDocuments(root, config)).errors).toEqual([]);
  const designPath = 'docs/tasks/product/changes/bug/design.md';
  await writeFile(join(root, designPath), '# Design\n');
  const design = { kind: 'design', identity: designPath, path: designPath };
  await writeFile(
    join(root, 'docs/tasks/product/documents.json'),
    JSON.stringify({ version: 1, documents: [...documents, design] }),
  );
  expect((await inspectTaskDocuments(root, config)).errors).toEqual([]);
  await writeFile(
    join(root, 'docs/tasks/product/documents.json'),
    JSON.stringify({ version: 1, documents: [documents[0], design] }),
  );
  expect((await inspectTaskDocuments(root, config)).errors.join('\n')).toContain(
    'TASK_CHANGE_OWNER',
  );
  await rm(join(root, stable.identity));
  const foreign = { ...documents[1]!, path: 'docs/tasks/other/changes/bug/change.md' };
  await writeFile(
    join(root, 'docs/tasks/product/documents.json'),
    JSON.stringify({ version: 1, documents: [documents[0], foreign] }),
  );
  expect((await inspectTaskDocuments(root, config)).errors.join('\n')).toContain(
    'TASK_DOCUMENT_OWNER',
  );
});

it('recovers a missing and stale index through work exec and leaves identical output untouched', async () => {
  const { root, config } = await fixture(['bug', 'another']);
  const issues = async () =>
    (await checkDocuments(root, (await inventory(root, config)).files, config)).errors;
  expect((await issues()).join('\n')).toContain('TASK_CHANGE_INDEX_MISSING');
  const ensured = invoke(root, ['ensure', '--stdin'], {
    requirement: { source: prd, section: 'Flow', key: 'index' },
    plan: {
      goal: 'Generate the index',
      result: null,
      scope: [index],
      sources: [prd],
      authorization: 'Fixture user authorized the generator.',
      nonGoals: [],
      acceptance: [{ id: 'check', criterion: 'Index matches', method: 'review' }],
      nextAction: 'Generate index',
      stopCondition: 'Return the fixture result',
    },
  });
  expect(ensured.status, ensured.output).toBe(0);
  const { task, revision } = ensured.value();
  const started = invoke(root, ['update', task.id, '--stdin'], {
    revision,
    reason: 'Fixture authorized implementation',
    stage: 'C1_IMPLEMENTATION',
    plan: { nextAction: 'Generate index' },
  });
  expect(started.status, started.output).toBe(0);
  const generate = () =>
    invoke(root, ['exec', task.id, '--', process.execPath, cli, 'changes', prd, '--write-index']);
  const first = generate();
  expect(first.status, first.output).toBe(0);
  expect(first.output).toContain('"changed": true');
  expect(await issues()).toEqual([]);
  const original = await readFile(join(root, index), 'utf8');
  expect(original).toBe(await format(original, { parser: 'markdown', printWidth: 100 }));
  expect(await readFile(join(root, cardPath('bug')), 'utf8')).toBe(card('bug'));
  expect(original.indexOf('another')).toBeLessThan(original.indexOf('bug'));
  expect(invoke(root, ['sync', task.id, 'Reviewed index creation']).status).toBe(0);
  const before = await stat(join(root, index), { bigint: true });
  const repeated = generate();
  expect(repeated.status, repeated.output).toBe(0);
  expect(repeated.output).toContain('"changed": false');
  expect((await stat(join(root, index), { bigint: true })).mtimeNs).toBe(before.mtimeNs);
  await writeFile(join(root, index), 'outdated\n');
  expect((await issues()).join('\n')).toContain('TASK_CHANGE_INDEX_STALE');
  expect(invoke(root, ['sync', task.id, 'Reviewed the stale index fixture']).status).toBe(0);
  const fixed = generate();
  expect(fixed.status, fixed.output).toBe(0);
  expect(await readFile(join(root, index), 'utf8')).toBe(original);
  expect(await issues()).toEqual([]);
  expect(invoke(root, ['changes', prd, 'bug', '--write-index']).status).not.toBe(0);
  expect(invoke(root, ['changes', prd, '--write-index', '--limit', '1']).status).not.toBe(0);
  const docs = invoke(root, ['documents', '--select', '/documents', '--limit', '20']);
  expect(docs.status, docs.output).toBe(0);
  expect(docs.output).toContain('"kind": "change"');
});

it('refuses an empty index and unsafe output aliases without changing other files', async () => {
  const empty = await fixture();
  const none = invoke(empty.root, ['changes', prd, '--write-index']);
  expect(none.output).toContain('WORK_CHANGES_EMPTY');
  await expect(stat(join(empty.root, 'docs/tasks/product/changes'))).rejects.toThrow();

  const { root } = await fixture(['bug']);
  const source = join(root, 'docs/index.md');
  const original = await readFile(source, 'utf8');
  await link(source, join(root, index));
  expect(invoke(root, ['changes', prd, '--write-index']).output).toContain('WORK_CHANGES_INDEX');
  expect(await readFile(source, 'utf8')).toBe(original);
  await rm(join(root, index));
  await symlink(source, join(root, index));
  expect(invoke(root, ['changes', prd, '--write-index']).output).toContain('WORK_SYMLINK');
  expect(await readFile(source, 'utf8')).toBe(original);
});

it('pages only selected summaries or a single body and rejects stale continuations', async () => {
  const ids = Array.from({ length: 13 }, (_, index) => `bug-${String(index).padStart(2, '0')}`);
  const { root } = await fixture(ids);
  const listed = invoke(root, ['changes', prd, '--limit', '4']);
  expect(listed.status, listed.output).toBe(0);
  expect(listed.output).not.toContain('Private detail');
  const first = listed.value();
  expect(first.items.map((item: { id: string }) => item.id)).toEqual(ids.slice(0, 4));
  const next = invoke(root, first.page.next.argv);
  expect(next.status, next.output).toBe(0);
  expect(next.value().items.map((item: { id: string }) => item.id)).toEqual(ids.slice(4, 8));
  const selected = invoke(root, ['changes', prd, ids[0]!, '--limit', '20']);
  expect(selected.status, selected.output).toBe(0);
  expect(selected.output).not.toContain('bug-01');
  const bodyPage = selected.value();
  await writeFile(join(root, cardPath(ids[0]!)), card(ids[0]!) + 'More detail.\n');
  expect(invoke(root, bodyPage.page.next.argv).output).toContain('WORK_READ_STALE');
  await writeFile(
    join(root, cardPath(ids[4]!)),
    card(ids[4]!).replace('Change bug-04', 'Updated title'),
  );
  expect(invoke(root, first.page.next.argv).output).toContain('WORK_READ_STALE');
  expect(invoke(root, ['changes', prd, 'unknown']).output).toContain('change key not found');
});

it('reuses a task for the same problem while binding its card and shared registry', async () => {
  const { root, documents } = await fixture(['bug', 'sibling']);
  const requirement = { source: prd, section: 'Flow', key: 'bug' };
  const first = invoke(root, ['ensure', '--stdin'], {
    requirement,
    plan: {
      goal: 'Repair this issue',
      result: { prd, key: 'bug' },
      scope: [cardPath('bug')],
      sources: [cardPath('bug')],
      norms: { version: 2, paths: ['docs/coordination.md'], reason: 'Fixture rule applies.' },
      authorization: 'Fixture user authorized the repair.',
      acceptance: [{ id: 'check', criterion: 'Repair behavior', method: 'review' }],
      nextAction: 'Implement the repair',
      stopCondition: 'Return for fixture acceptance',
    },
  });
  expect(first.status, first.output).toBe(0);
  const created = first.value();
  const again = invoke(root, ['ensure', '--stdin'], { requirement });
  expect(again.status, again.output).toBe(0);
  expect(again.value()).toMatchObject({
    created: false,
    task: { id: created.task.id, result: { prd, key: 'bug' } },
  });
  await writeFile(join(root, cardPath('sibling')), card('sibling') + 'Changed unrelated body.\n');
  const unchanged = invoke(root, ['check', created.task.id]).value();
  expect(unchanged.candidate).toBe(created.assessment.candidate);
  expect(unchanged.ready).toBe(true);
  const added = cardPath('new-issue');
  await mkdir(dirname(join(root, added)), { recursive: true });
  await writeFile(join(root, added), card('new-issue'));
  await writeFile(
    join(root, 'docs/tasks/product/documents.json'),
    JSON.stringify({ version: 1, documents: [...documents, registration('new-issue')] }),
  );
  const changed = invoke(root, ['check', created.task.id]).value();
  expect(changed.candidate).not.toBe(created.assessment.candidate);
  expect(JSON.stringify(changed)).toContain('documents.json');
  const other = invoke(root, ['ensure', '--stdin'], {
    requirement: { ...requirement, key: 'new-issue' },
    plan: {
      goal: 'Repair an independent issue',
      result: { prd, key: 'new-issue' },
      scope: [added],
      sources: [added],
      norms: { version: 2, paths: ['docs/coordination.md'], reason: 'Fixture rule applies.' },
      authorization: 'Fixture user authorized the other issue.',
      acceptance: [{ id: 'check', criterion: 'Other repair behavior', method: 'review' }],
      nextAction: 'Implement the other repair',
      stopCondition: 'Return for fixture acceptance',
    },
  });
  expect(other.status, other.output).toBe(0);
  expect(other.value().task.id).not.toBe(created.task.id);
  expect(other.value().task.result.key).toBe('new-issue');
});

it('retains the change key and task across a PRD directory move and rejects a silent key rename', async () => {
  const { root } = await fixture(['bug']);
  const requirement = { source: prd, section: 'Flow', key: 'bug' };
  const first = invoke(root, ['ensure', '--stdin'], {
    requirement,
    plan: {
      goal: 'Repair this issue',
      result: { prd, key: 'bug' },
      scope: [cardPath('bug')],
      sources: [cardPath('bug')],
      norms: { version: 2, paths: ['docs/coordination.md'], reason: 'Fixture rule applies.' },
      authorization: 'Fixture user authorized the repair.',
      acceptance: [{ id: 'check', criterion: 'Repair behavior', method: 'review' }],
      nextAction: 'Implement the repair',
      stopCondition: 'Return for fixture acceptance',
    },
  });
  expect(first.status, first.output).toBe(0);
  const original = first.value();
  const movedPrd = 'docs/tasks/relocated/prd.md';
  const movedCard = 'docs/tasks/relocated/changes/bug/change.md';
  const registry = 'docs/tasks/relocated/documents.json';
  await rename(join(root, 'docs/tasks/product'), join(root, 'docs/tasks/relocated'));
  await mkdir(dirname(join(root, cardPath('bug'))), { recursive: true });
  await writeFile(
    join(root, cardPath('bug')),
    '# 资料已迁移\n\n[当前资料](../../../relocated/changes/bug/change.md)\n',
  );
  const relocated = [
    { kind: 'prd', identity: prd, path: movedPrd },
    { kind: 'change', identity: cardPath('bug'), path: movedCard, aliases: [cardPath('bug')] },
  ];
  await writeFile(join(root, registry), JSON.stringify({ version: 1, documents: relocated }));
  const list = invoke(root, ['changes', prd]);
  expect(list.status, list.output).toBe(0);
  expect(list.value().items).toMatchObject([{ id: 'bug', path: movedCard }]);
  const detail = invoke(root, ['changes', prd, 'bug']);
  expect(detail.status, detail.output).toBe(0);
  expect(detail.output).toContain('Change bug');
  const resumed = invoke(root, ['ensure', '--stdin'], { requirement });
  expect(resumed.status, resumed.output).toBe(0);
  expect(resumed.value()).toMatchObject({
    created: false,
    task: { id: original.task.id, result: { prd, key: 'bug' } },
  });
  const reconciled = invoke(root, ['update', original.task.id, '--stdin'], {
    revision: resumed.value().revision,
    reason: 'Fixture owner reviewed the PRD directory move.',
    plan: { scope: [movedCard], nextAction: 'Continue the same repair at its current path.' },
  });
  expect(reconciled.status, reconciled.output).toBe(0);
  expect(invoke(root, ['sync', original.task.id, 'Reviewed moved sources and scope']).status).toBe(
    0,
  );
  expect(invoke(root, ['check', original.task.id]).value().ready).toBe(true);

  const renamed = 'docs/tasks/relocated/changes/renamed/change.md';
  await mkdir(dirname(join(root, renamed)), { recursive: true });
  await rename(join(root, movedCard), join(root, renamed));
  await rm(join(root, cardPath('bug')));
  await writeFile(
    join(root, registry),
    JSON.stringify({
      version: 1,
      documents: [relocated[0], { ...relocated[1], path: renamed, aliases: [] }],
    }),
  );
  expect(invoke(root, ['changes', prd]).output).toContain('TASK_CHANGE_ID');
  expect(
    invoke(root, ['ensure', '--stdin'], {
      requirement: { ...requirement, key: 'renamed' },
      plan: { goal: 'Incorrect duplicate' },
    }).output,
  ).toContain('TASK_CHANGE_ID');
  const tasks = invoke(root, ['status']).value().tasks;
  expect(tasks.map((task: { id: string }) => task.id)).toEqual([original.task.id]);
});

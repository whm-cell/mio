import { writeTaskDocuments } from './fixtures/task-documents-fixture.ts';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { digest, draft, json } from '../../scripts/harness/work/records.ts';
import type { Task } from '../../scripts/harness/work/records.ts';
import {
  finiteOutput,
  outputBytes,
  readPage,
  selectValue,
} from '../../scripts/harness/work/output.ts';

const project = resolve('.');
const cli = join(project, 'scripts/harness/work/cli.ts');
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function invoke(root: string, args: string[], input?: unknown) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
    timeout: 10000,
    ...(input === undefined ? {} : { input: JSON.stringify(input) }),
  });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(outputBytes);
  return { status: result.status, output, value: () => JSON.parse(result.stdout) };
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mio-work-read-')));
  scratch.push(root);
  const config = JSON.parse(await readFile(join(project, 'harness.config.json'), 'utf8'));
  const files = {
    'harness.config.json': json(config),
    'package.json': '{"type":"module"}\n',
    '.gitignore': '.work/\n',
    'AGENTS.md': '# Development\n',
    'docs/api.md': '# API\n',
    'src/value.ts': 'export const value = 1;\n',
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
  for (const file of [
    'docs/coordination.md',
    'docs/work-records.md',
    'docs/engineering/testing.md',
  ]) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await cp(join(project, file), join(root, file));
  }
  expect(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root }).status).toBe(0);
  expect(invoke(root, ['init', 'alice']).status).toBe(0);
  return root;
}
const path = (root: string, id: string) => join(root, `.work/tasks/${id}/state.json`);
async function save(root: string, task: Task) {
  await mkdir(dirname(path(root, task.plan.id)), { recursive: true });
  await writeFile(path(root, task.plan.id), json(task));
}
async function ready(root: string, authorization = 'Fixture user authorizes this local probe.') {
  const ensured = invoke(root, ['ensure', '--stdin'], {
    requirement: { source: 'docs/api.md', section: 'API', key: 'probe' },
    plan: {
      goal: 'Verify progressive reads.',
      result: null,
      scope: ['src'],
      sources: ['docs/api.md'],
      authorization,
      acceptance: [
        {
          id: 'checks',
          criterion: 'The real CLI probe passes.',
          method: 'automated',
          command: [process.execPath, '-e', 'process.exit(0)'],
        },
      ],
      nextAction: 'Implement and check the authorized probe.',
      stopCondition: 'Return actual results and limits.',
    },
  });
  expect(ensured.status, ensured.output).toBe(0);
  const result = ensured.value();
  return { id: result.task.id as string, result };
}

it('keeps 27, 47 and 227 task listings bounded, searchable and explicitly unassessed', async () => {
  const root = await fixture();
  for (let index = 0; index < 227; index++) {
    const task = draft(root, 'alice', `task-${String(index).padStart(3, '0')}`, `Task ${index}`);
    // Assessing these records would fail. Listing only reads their recorded fields.
    task.plan.inputs.push('missing-input.ts');
    if (index === 226) {
      task.plan.goal = 'Needle final task';
      task.stage = 'C1_IMPLEMENTATION';
    }
    await save(root, task);
    if (![26, 46, 226].includes(index)) continue;
    const listed = invoke(root, ['status']).value();
    expect(listed.tasks).toHaveLength(10);
    expect(listed.page.total).toBe(index + 1);
    expect(
      listed.tasks.every(
        (item: { assessment: { status: string } }) => item.assessment.status === 'not_checked',
      ),
    ).toBe(true);
    expect(listed.tasks[0].recorded.stage).toBe(null);
    const next = invoke(root, listed.page.next.argv).value();
    expect(next.page.offset).toBe(10);
    expect(next.tasks[0].id).toBe('task-010');
  }
  const found = invoke(root, [
    'status',
    '--query',
    'needle',
    '--stage',
    'C1_IMPLEMENTATION',
  ]).value();
  expect(found.tasks.map((item: { id: string }) => item.id)).toEqual(['task-226']);
  const task = JSON.parse(await readFile(path(root, 'task-226'), 'utf8')) as Task;
  task.archived = true;
  await save(root, task);
  expect(invoke(root, ['status', '--query', 'needle']).value().tasks).toEqual([]);
  expect(
    invoke(root, ['status', '--query', 'needle', '--archived', 'all']).value().tasks[0].recorded
      .archived,
  ).toBe(true);
});

it('locates a long task field and rejects stale pages and oversized selectors', async () => {
  const root = await fixture();
  const goal = '任务𠮷'.repeat(40000);
  const task = draft(root, 'alice', 'long', goal);
  await save(root, task);
  const listed = invoke(root, ['status']).value();
  const ref = listed.tasks[0].goal.$read.argv;
  const first = invoke(root, ref).value();
  expect(first.text).toBe([...goal].slice(0, 1024).join(''));
  expect(first.page.total).toBe(120000);
  task.plan.goal += 'changed';
  await save(root, task);
  expect(invoke(root, first.page.next.argv).output).toContain('WORK_READ_STALE');
  expect(
    invoke(root, ['read', 'long', 'task', '--select', `/${'x'.repeat(20000)}`]).output,
  ).toContain('WORK_READ_ARGUMENT');
  expect(invoke(root, ['read', 'long', 'task', '/__proto__']).output).toContain('WORK_READ_SELECT');
});

it('keeps long manifest path identities readable within the object page budget', async () => {
  const root = await fixture();
  const { id } = await ready(root);
  const task = JSON.parse(await readFile(path(root, id), 'utf8')) as Task;
  const file = `docs/${'segment/'.repeat(40)}file.md`;
  const sha256 = digest('historical file bytes');
  task.checkpoint!.files[file] = sha256;
  task.checkpoint!.candidate = digest(
    json({ files: task.checkpoint!.files, contract: task.checkpoint!.contract }),
  );
  await save(root, task);
  const page = invoke(root, ['read', id, 'task', '/checkpoint/files', '--limit', '20']).value();
  expect(page.entries).toContainEqual({ key: file, value: sha256 });
  const selected = `/checkpoint/files/${file.replaceAll('/', '~1')}`;
  expect(invoke(root, ['read', id, 'task', selected]).value().text).toBe(sha256);
});

it('separates omitted authority from readiness while still blocking late OPEN decisions', async () => {
  const root = await fixture();
  const authorization = 'The fixture user explicitly authorizes the scoped implementation. '.repeat(
    2000,
  );
  const { id, result } = await ready(root, authorization);
  expect(result.task.authorization.$read).toBeDefined();
  expect(result.assessment.checkedReady).toBe(true);
  expect(result.assessment.ready).toBe(true);
  expect(result.assessment.reading.omitted).toEqual(['authorization']);
  const checked = invoke(root, ['check', id]).value();
  expect(checked.ready).toBe(true);
  expect(checked.reading.omitted).toEqual(['authorization']);
  expect(invoke(root, checked.requiredContext.authorization.$read.argv).value().text).toBe(
    authorization.slice(0, 1024),
  );
  const expanded = invoke(root, result.task.authorization.$read.argv).value();
  expect(expanded.text).toBe(authorization.slice(0, 1024));
  const changed = invoke(root, ['update', id, '--stdin'], {
    revision: result.revision,
    reason: 'Retain a long next action without expanding the result.',
    plan: { nextAction: 'next '.repeat(10000) },
    stage: 'C1_IMPLEMENTATION',
  });
  expect(changed.status, changed.output).toBe(0);
  expect(changed.value().task.nextAction.$read).toBeDefined();
  const task = JSON.parse(await readFile(path(root, id), 'utf8')) as Task;
  task.plan.decisions = Array.from({ length: 1000 }, (_, index) => ({
    status: index === 999 ? 'OPEN' : 'CONFIRMED',
    text: `Decision ${index}`,
    source: 'Fixture human request',
  }));
  await save(root, task);
  const current = invoke(root, ['context', id, 'implement']).value();
  expect(current.assessment.ready).toBe(false);
  expect(current.assessment.blocking.openDecisions).toBe(1);
  expect(current.assessment.reading.omitted).toContain('decisions');
  const decision = invoke(root, ['read', id, 'task', '/plan/decisions/999']).value();
  expect(decision.entries.find((entry: { key: string }) => entry.key === 'status').value).toBe(
    'OPEN',
  );
  const run = invoke(root, [
    'exec',
    id,
    '--',
    process.execPath,
    '-e',
    'require("node:fs").writeFileSync(".work/unexpected", "executed")',
  ]);
  expect(run.status).toBe(1);
  expect(run.output).toContain('WORK_BLOCKED');
  await expect(readFile(join(root, '.work/unexpected'))).rejects.toThrow();
});

it('paginates large current errors and changed-file collections without treating them as pass', async () => {
  const root = await fixture();
  const { id } = await ready(root);
  const task = JSON.parse(await readFile(path(root, id), 'utf8')) as Task;
  for (let index = 0; index < 1000; index++)
    task.checkpoint!.files[`src/removed-${String(index).padStart(4, '0')}-${'x'.repeat(80)}.ts`] =
      digest('old content');
  task.checkpoint!.candidate = digest(
    json({ files: task.checkpoint!.files, contract: task.checkpoint!.contract }),
  );
  await save(root, task);
  const checked = invoke(root, ['check', id]);
  expect(checked.status).toBe(1);
  const assessment = checked.value();
  expect(assessment.ready).toBe(false);
  expect(assessment.blocking.errors).toBeGreaterThan(0);
  expect(assessment.errors[0].$read).toBeDefined();
  const error = invoke(root, assessment.errors[0].$read.argv).value();
  expect(error.text).toContain('WORK_CONTEXT_CHANGED');
  const changes = invoke(root, ['read', id, 'check', '/changed']).value();
  expect(changes.page.total).toBe(1000);
  expect(changes.items).toHaveLength(10);
  expect(invoke(root, ['read', id, 'check', '/changed/999']).value().text).toContain(
    'removed-0999',
  );
});

it('keeps a recorded request for changes distinct from a valid execution assessment', async () => {
  const root = await fixture();
  const { id } = await ready(root);
  const task = JSON.parse(await readFile(path(root, id), 'utf8')) as Task;
  task.reviewDecision = 'REQUEST_CHANGES';
  await save(root, task);
  const current = invoke(root, ['context', id, 'resume']).value();
  expect(current.assessment.checkedReady).toBe(true);
  expect(current.assessment.ready).toBe(false);
  expect(current.assessment.blocking.requestChanges).toBe(true);
  expect(invoke(root, ['read', id, 'check', '/ready']).value().value).toBe(false);
});

it('keeps readiness stable across scope pagination without recording reading state', async () => {
  const root = await fixture();
  const { id, result } = await ready(root);
  const scope = Array.from({ length: 7 }, (_, index) =>
    index === 0 ? 'src/value.ts' : `src/planned-${index}.ts`,
  );
  const updated = invoke(root, ['update', id, '--stdin'], {
    revision: result.revision,
    reason: 'The fixture user authorizes seven concrete source paths.',
    plan: { scope },
  });
  expect(updated.status, updated.output).toBe(0);
  const synced = invoke(root, [
    'sync',
    id,
    'Inspected the seven scoped files and planned paths.',
  ]).value();
  const context = invoke(root, ['context', id, 'resume']).value();
  const checked = invoke(root, ['check', id]).value();
  for (const assessment of [context.assessment, synced, checked]) {
    expect(assessment.checkedReady).toBe(true);
    expect(assessment.ready).toBe(true);
    expect(assessment.reading.omitted).toEqual(['scope']);
    expect(Object.values(assessment.blocking).every((value) => !value)).toBe(true);
  }
  const beforeReading = await readFile(path(root, id), 'utf8');
  expect(synced.requiredContext.scope.total).toBe(7);
  expect(invoke(root, checked.requiredContext.scope.$read.argv).value().items).toEqual(
    scope.slice(0, 1),
  );
  expect(invoke(root, ['check', id]).value().ready).toBe(true);
  expect(await readFile(path(root, id), 'utf8')).toBe(beforeReading);
});

it('shows explicit maintenance without inventing a development result', async () => {
  const root = await fixture();
  const { id, result } = await ready(root);
  expect(result.task.result).toBeNull();
  expect(result.assessment.ready).toBe(true);
  const checked = invoke(root, ['check', id]).value();
  expect(checked.requiredContext.result).toBeNull();
  expect(checked.readyForAcceptance).toBe(false);
  expect(
    invoke(root, ['update', id, '--stdin'], {
      revision: result.revision,
      reason: 'Observe the maintenance fixture without declaring a business result.',
      stage: 'C1_EVIDENCE_PENDING',
      plan: { nextAction: 'Run the authorized fixture check.' },
    }).status,
  ).toBe(0);
  expect(
    invoke(root, ['run', id, 'checks', '--', process.execPath, '-e', 'process.exit(0)']).status,
  ).toBe(0);
  const current = invoke(root, ['context', id, 'verify']).value();
  expect(current.task.result).toBeNull();
  expect(current.task.nextAction).toContain('declares no development result');
  expect(current.task.nextAction).toContain('return verified maintenance');
  const saved = JSON.parse(await readFile(path(root, id), 'utf8')) as Task;
  expect(saved.plan.result).toBeNull();
});

it('keeps the result declaration visible when the whole task view exceeds its budget', async () => {
  const root = await fixture();
  const { id } = await ready(root);
  const task = JSON.parse(await readFile(path(root, id), 'utf8')) as Task;
  const prd = 'docs/tasks/probe/prd.md';
  await mkdir(join(root, 'docs/tasks/probe'), { recursive: true });
  await writeFile(join(root, prd), '# Probe PRD\n');
  await writeTaskDocuments(root, [{ kind: 'prd', identity: prd, path: prd }]);
  const detail = '明确的夹具说明'.repeat(80);
  task.plan.nonGoals = Array.from({ length: 5 }, () => detail);
  task.plan.decisions = Array.from({ length: 5 }, () => ({
    status: 'CONFIRMED',
    text: detail,
    source: detail,
  }));
  task.plan.dependencies = Array.from({ length: 5 }, () => ({
    task: detail,
    ref: detail,
    ready: true,
  }));
  for (const declared of [false, true]) {
    if (declared) task.plan.result = { prd, key: 'probe' };
    await save(root, task);
    const context = invoke(root, ['context', id, 'resume']).value();
    const checkedCall = invoke(root, ['check', id]);
    expect(checkedCall.output).toMatch(/^\{/);
    const checked = checkedCall.value();
    for (const view of [context.task, checked.requiredContext]) {
      expect(view.$read).toBeDefined();
      expect(view.result).toEqual(task.plan.result ?? null);
    }
  }
});

it.each([0, 7])(
  'keeps long argv in the original with a short summary for exit %i',
  async (exit) => {
    const root = await fixture();
    const { id, result } = await ready(root);
    expect(
      invoke(root, ['update', id, '--stdin'], {
        revision: result.revision,
        reason: 'Measure command detail storage without changing the observed fixture.',
        stage: 'C1_EVIDENCE_PENDING',
        plan: { nextAction: 'Run a short and long command and inspect the originals.' },
      }).status,
    ).toBe(0);
    const short = `process.exit(${exit})`;
    const long = `/*${'command detail '.repeat(2000)}*/${short}`;
    for (const script of [short, long]) {
      const run = invoke(root, ['run', id, 'checks', '--', process.execPath, '-e', script]);
      expect(run.status).toBe(exit === 0 ? 0 : 1);
    }
    const task = JSON.parse(await readFile(path(root, id), 'utf8')) as Task;
    expect(task.evidence).toHaveLength(2);
    expect(task.evidence[1]!.summary.split('; coverage=')[0]).toBe(
      task.evidence[0]!.summary.split('; coverage=')[0],
    );
    expect(task.evidence[0]!.summary).toContain(
      `coverage=${exit === 0 ? 'complete' : 'supplement'}`,
    );
    expect(task.evidence[1]!.summary).toContain('coverage=supplement');
    expect(task.evidence[1]!.summary).toContain(`exit ${exit}`);
    expect(task.evidence[1]!.summary.length).toBeLessThan(160);
    const entry = task.evidence[1]!;
    const original = await readFile(join(root, entry.artifact), 'utf8');
    expect(digest(original)).toBe(entry.sha256);
    expect(original).toContain(JSON.stringify(long));
    expect(entry.result).toBe(exit === 0 ? 'pass' : 'fail');
    expect(invoke(root, ['read', id, 'evidence', '1']).value().integrity).toBe('verified');
    // Old records containing argv in their summary remain readable without migration.
    task.evidence[0]!.summary = `${JSON.stringify([process.execPath, '-e', short])}; exit ${exit}`;
    await save(root, task);
    expect(invoke(root, ['read', id, 'evidence', '0']).value().integrity).toBe('verified');
    const checked = invoke(root, ['check', id]).value();
    expect(checked.evidence[0].result).toBe(entry.result);
    expect(checked.readyForAcceptance).toBe(false);
  },
);

it('reads one ledger-bound failed original in exact Unicode segments and reports corruption', async () => {
  const root = await fixture();
  const { id, result } = await ready(root);
  expect(
    invoke(root, ['update', id, '--stdin'], {
      revision: result.revision,
      reason: 'Collect the fixture original for progressive reading.',
      stage: 'C1_EVIDENCE_PENDING',
      plan: { nextAction: 'Run the fixture check and inspect its original.' },
    }).status,
  ).toBe(0);
  const failed = invoke(root, [
    'run',
    id,
    'checks',
    '--',
    process.execPath,
    '-e',
    'console.log("𠮷".repeat(100000));console.error("original failure");process.exit(7)',
  ]);
  expect(failed.status).toBe(1);
  const task = JSON.parse(await readFile(path(root, id), 'utf8')) as Task;
  expect(task.evidence[0]!.result).toBe('fail');
  const original = await readFile(join(root, task.evidence[0]!.artifact), 'utf8');
  const first = invoke(root, ['read', id, 'evidence', '0']).value();
  expect(first.integrity).toBe('verified');
  expect(first.text).toBe([...original].slice(0, 1024).join(''));
  const second = invoke(root, first.page.next.argv).value();
  expect(second.text).toBe([...original].slice(1024, 2048).join(''));
  await writeFile(join(root, task.evidence[0]!.artifact), 'tampered original');
  expect(invoke(root, second.page.next.argv).output).toContain('WORK_READ_STALE');
  const corrupted = invoke(root, ['read', id, 'evidence', '0']).value();
  expect(corrupted.integrity).toBe('mismatch');
  expect(invoke(root, ['check', id]).value().evidence[0].result).toBe('corrupt');
  expect(invoke(root, ['read', id, 'evidence', '../../AGENTS.md']).output).toContain('WORK_READ');
});

it('navigates guides without shared prose and expands only the selected stable section', async () => {
  const root = await fixture();
  await rm(join(root, '.work'), { recursive: true });
  const guide = invoke(root, ['guide', 'verify']).value();
  expect(JSON.stringify(guide)).not.toContain('原始证据绑定实际候选');
  const ref = guide.reading[1].ref;
  const page = invoke(root, ['guide', 'verify', '--section', ref]).value();
  expect(page.ref).toBe('docs/coordination.md#验证与接受');
  expect(page.page.unit).toBe('items');
  const body = invoke(root, [
    'guide',
    'verify',
    '--section',
    ref,
    '--select',
    '/blocks/1/body',
  ]).value();
  expect(typeof body.text).toBe('string');
  await writeFile(
    join(root, 'docs/coordination.md'),
    (await readFile(join(root, 'docs/coordination.md'), 'utf8')).replace(
      '## 验证与接受',
      '## 验证与接受\nChanged current section.',
    ),
  );
  expect(
    invoke(root, ['guide', 'verify', '--section', ref, '--hash', page.page.sha256]).output,
  ).toContain('WORK_READ_STALE');
});

it('offers testing navigation without prose or records, and shares it with task context', async () => {
  const root = await fixture();
  const { id } = await ready(root);
  const ref = 'docs/engineering/testing.md#按变更定位测试';
  const source = await readFile(join(root, 'docs/engineering/testing.md'), 'utf8');
  const stateBefore = await readFile(path(root, id), 'utf8');
  for (const args of [
    ['guide', 'verify'],
    ['context', id, 'verify'],
  ]) {
    const result = invoke(root, args);
    expect(result.status, result.output).toBe(0);
    const reading = result.value().reading as { ref: string; read: { argv: string[] } }[];
    expect(reading.find((entry) => entry.ref === ref)?.read.argv).toEqual([
      'guide',
      'verify',
      '--section',
      ref,
    ]);
    expect(result.output).not.toContain('CLI 由子进程执行');
  }
  expect(await readFile(path(root, id), 'utf8')).toBe(stateBefore);
  await rm(join(root, '.work'), { recursive: true });
  const first = invoke(root, ['guide', 'verify', '--section', ref, '--limit', '1']).value();
  expect(first.ref).toBe(ref);
  expect(first.page.next).not.toBeNull();
  const next = invoke(root, first.page.next.argv);
  expect(next.status, next.output).toBe(0);
  expect(next.value().page.offset).toBe(1);
  await writeFile(join(root, 'docs/engineering/testing.md'), `${source}\nChanged navigation.\n`);
  expect(invoke(root, first.page.next.argv).output).toContain('WORK_READ_STALE');
});

it('reports an invalid testing navigation target without breaking unrelated guide actions', async () => {
  const root = await fixture();
  const file = join(root, 'docs/engineering/testing.md');
  const source = await readFile(file, 'utf8');
  const start = invoke(root, ['guide', 'start']).output;
  for (const invalid of ['# No testing section\n', `${source}\n## 按变更定位测试\nDuplicate.\n`]) {
    await writeFile(file, invalid);
    expect(invoke(root, ['guide', 'verify']).output).toContain('WORK_GUIDE_SECTION');
    expect(invoke(root, ['guide', 'start']).output).toBe(start);
  }
  await rm(file);
  expect(invoke(root, ['guide', 'verify']).status).not.toBe(0);
  expect(invoke(root, ['guide', 'start']).output).toBe(start);
});

it('bounds rejected request errors without echoing a huge path or mutating the record', async () => {
  const root = await fixture();
  const { id, result } = await ready(root);
  const before = await readFile(path(root, id), 'utf8');
  const rejected = invoke(root, ['update', id, '--stdin'], {
    revision: result.revision,
    reason: 'Invalid fixture input must not change this task.',
    plan: Object.fromEntries(
      Array.from({ length: 1000 }, (_, index) => [`unknown-${index}-${'x'.repeat(100)}`, true]),
    ),
  });
  expect(rejected.status).toBe(1);
  expect(rejected.output).toContain('WORK_REQUEST');
  expect(rejected.output).toContain('"incomplete": true');
  expect(JSON.parse(rejected.output).detail).toContain('not persisted');
  expect(await readFile(path(root, id), 'utf8')).toBe(before);
  const receive = invoke(root, ['receive', `${'../'.repeat(20000)}private.md`]);
  expect(receive.status).toBe(1);
  expect(receive.output).toContain('WORK_HANDOFF_PATH');
  expect(receive.output).not.toContain('/errors');
  expect(
    invoke(root, ['update', id, '--stdin'], {
      revision: result.revision,
      reason: 'Test invalid artifact reporting in the verification phase.',
      stage: 'C1_EVIDENCE_PENDING',
      plan: { nextAction: 'Inspect the invalid fixture artifact.' },
    }).status,
  ).toBe(0);
  const invalidOriginal = invoke(root, [
    'evidence',
    id,
    'quality-review',
    'pass',
    `.work/tasks/${id}/evidence/${'x'.repeat(5000)}.md`,
    'Fixture invalid filename.',
  ]);
  expect(invalidOriginal.status).toBe(1);
  const error = JSON.parse(invalidOriginal.output);
  expect(error.error).toContain('ENAMETOOLONG');
  expect(error.detail).toContain('not persisted');
  expect(error.detail).not.toContain('/errors');
});

it('uses the same finite semantic pages for wide objects, large children and invalid limits', () => {
  const source = {
    collection: Array.from({ length: 40 }, (_, index) => ({
      text: `${index}:${'长'.repeat(10000)}`,
    })),
  };
  const options = { offset: 0, select: '/collection', limit: 20 };
  const page = readPage(source, options, ['read-result', 'docs/example.md', 'key']);
  expect(Buffer.byteLength(json(page))).toBeLessThanOrEqual(outputBytes);
  expect(page.page.count).toBeGreaterThan(0);
  expect(page.page.next).not.toBeNull();
  expect(() => readPage(source, { ...options, limit: 0 }, ['read'])).toThrow('WORK_READ_OPTIONS');
  expect(() => selectValue(source, '/collection/00')).toThrow('WORK_READ_SELECT');
  expect(() => selectValue(source, '/collection/~2')).toThrow('WORK_READ_SELECT');
  const view = finiteOutput(source, (pointer) => ({
    argv: ['read', 'fixture', 'task', '--select', pointer],
    sha256: digest(json(source)),
  }));
  expect(Buffer.byteLength(json(view))).toBeLessThanOrEqual(outputBytes);
});

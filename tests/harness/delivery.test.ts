import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { taskDocumentFiles, taskIndex, taskIndexPath } from './fixtures/task-documents-fixture.ts';
import { loadConfig } from '../../scripts/harness/inventory.ts';
import { assess, capture } from '../../scripts/harness/work/context.ts';
import { deliver } from '../../scripts/harness/work/delivery.ts';
import { resultMarker } from '../../scripts/harness/work/evidence.ts';
import { updateTask } from '../../scripts/harness/work/manage.ts';
import { readPublicResult } from '../../scripts/harness/work/public-read.ts';
import {
  contractPlan,
  digest,
  draft,
  initializeMember,
  json,
  loadTask,
  saveTask,
  taskRevision,
} from '../../scripts/harness/work/records.ts';
import type { Evidence } from '../../scripts/harness/work/records.ts';
import {
  bookPaths,
  checkReports,
  readBook,
  readResultInput,
  renderBook,
} from '../../scripts/harness/work/reports.ts';
import { documentCatalog } from '../../scripts/harness/task-documents.ts';
import { recordsPath } from '../../scripts/harness/work/compact-store.ts';

const project = resolve('.');
const prd = 'docs/tasks/product/prd.md';
const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function put(root: string, path: string, source: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), source);
}

function git(root: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function commit(root: string) {
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
}

const sibling = {
  key: 'sibling',
  title: 'Already accepted',
  outcomes: 'Retained outcome.',
  locations: [{ path: 'src/value.ts', purpose: 'Existing public entry.' }],
  verification: 'Prior observation.',
  limitations: 'Historical only.',
  acceptance: {
    candidate: 'a'.repeat(64),
    statement: 'The user accepted the historical result.',
    reference: 'Prior acceptance.',
  },
};

async function fixture(seed = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mio-delivery-')));
  scratch.push(root);
  const config = await loadConfig(project);
  const docs = [{ identity: prd, kind: 'prd' as const, path: prd }];
  const files: Record<string, string> = {
    'harness.config.json': json(config),
    'package.json': '{"type":"module"}\n',
    '.gitignore': '.work/\n',
    'AGENTS.md': '# Development\n',
    'README.md': '# Fixture\n',
    'docs/index.md': '# Index\n',
    'docs/api.md': '# API\n',
    [taskIndexPath]: taskIndex,
    [prd]: '# Capability PRD\n',
    'src/value.ts': 'export const value = 1;\n',
    'compute/src/worker.ts': 'export const worker = true;\n',
    'contracts/compute/src/index.ts': 'export const contract = true;\n',
    'packages/foundation/src/index.ts': 'export const foundation = true;\n',
    ...taskDocumentFiles(docs),
  };
  if (seed) {
    const book = { version: 5 as const, prd, results: [sibling] };
    files[recordsPath(prd)] = json(book);
    files['docs/tasks/product/complete/report.md'] = renderBook(book, prd);
  }
  for (const [path, source] of Object.entries(files)) await put(root, path, source);
  git(root, 'init', '-q', '-b', 'main');
  commit(root);
  await initializeMember(root, 'alice');
  return root;
}

async function setup(root: string, id = 'probe', key = id, prdIdentity = prd) {
  const task = draft(root, 'alice', id, 'Deliver a capability');
  Object.assign(task.plan, {
    result: { prd: prdIdentity, key },
    norms: { version: 2, paths: ['docs/api.md'], reason: 'The public API stays aligned.' },
    scope: ['src'],
    inputs: [],
    authorization: 'The fixture user authorized the work.',
    acceptance: [
      {
        id: 'checks',
        criterion: 'Run the check.',
        method: 'automated',
        command: ['node', '--version'],
      },
      { id: 'quality-review', criterion: 'Inspect source quality.', method: 'review' },
      { id: 'norms-review', criterion: 'Reconcile norms.', method: 'review' },
    ],
    nextAction: 'Verify the candidate.',
    stopCondition: 'Ask for actual acceptance.',
  });
  task.delivery = { version: 2 };
  task.stage = 'C1_EVIDENCE_PENDING';
  const candidate = (await capture(root, task)).candidate;
  if (!candidate) throw new Error('Fixture requires a clean committed candidate');
  task.checkpoint = { candidate };
  const observations: { criterion: string; method: string; extension: string; content: string }[] =
    [
      {
        criterion: 'checks',
        method: 'automated',
        extension: 'log',
        content:
          json({ candidate, contract: contractPlan(task), argv: ['node', '--version'] }) +
          resultMarker +
          json({
            exitCode: 0,
            signal: null,
            cancelled: false,
            unsettled: false,
            contextChanged: false,
          }),
      },
      {
        criterion: 'quality-review',
        method: 'review',
        extension: 'md',
        content:
          '# Quality\n\n```mio-quality-review\n' +
          json({
            candidate,
            contract: contractPlan(task),
            reviewer: 'Fixture reviewer',
            scope: ['src/value.ts'],
            dimensions: Object.fromEntries(
              ['algorithm', 'unused', 'reuse'].map((name) => [
                name,
                { result: 'pass', evidence: 'Reviewed.' },
              ]),
            ),
            limitations: 'Fixture only.',
          }) +
          '```\n',
      },
      {
        criterion: 'norms-review',
        method: 'review',
        extension: 'md',
        content:
          '# Norms\n\n```mio-norms-review\n' +
          json({
            version: 2,
            candidate,
            contract: contractPlan(task),
            reviewer: 'Fixture reviewer',
            reason: task.plan.norms!.reason,
            requirements: {
              result: 'pass',
              assessment: 'Reviewed.',
              documents: [{ path: prd, assessment: 'Reviewed.' }],
            },
            documents: [{ path: 'docs/api.md', result: 'pass', assessment: 'Reviewed.' }],
            accepted: { result: 'pass', assessment: 'Reviewed.', results: [] },
            remaining: 'None.',
            conclusion: { result: 'pass', evidence: 'Reviewed.' },
            limitations: 'Fixture only.',
          }) +
          '```\n',
      },
    ];
  for (const item of observations) {
    const artifact = `.work/tasks/${id}/evidence/${item.criterion}.${item.extension}`;
    await put(root, artifact, item.content);
    task.evidence.push({
      criterion: item.criterion,
      method: item.method,
      result: 'pass',
      candidate,
      artifact,
      sha256: digest(item.content),
      summary: 'Fixture observation.',
      environment: 'Fixture.',
    });
  }
  await saveTask(root, task);
  expect(
    (await assess(root, task)).evidence.map((entry) => [entry.criterion, entry.result]),
  ).toEqual([
    ['checks', 'pass'],
    ['quality-review', 'pass'],
    ['norms-review', 'pass'],
  ]);
  return candidate;
}

async function prepare(
  root: string,
  id = 'probe',
  locations = [{ path: 'src/value.ts', purpose: 'Public entry.' }],
) {
  const { task } = await loadTask(root, id);
  return deliver(
    root,
    id,
    json({
      action: 'prepare',
      revision: taskRevision(task),
      title: 'Accepted capability',
      outcomes: 'The capability was delivered.',
      locations,
      verification: 'The fixture checks and reviews passed.',
      limitations: 'Fixture evidence only.',
    }),
  );
}

async function completeRequest(root: string, id = 'probe') {
  const { task } = await loadTask(root, id);
  const draft = task.delivery!.draft;
  if (!draft || !('id' in draft)) throw new Error('Expected current draft');
  return {
    action: 'complete',
    revision: taskRevision(task),
    draftId: draft.id,
    acceptance: {
      candidate: draft.candidate,
      statement: 'The user accepted this capability.',
      reference: 'Recorded fixture acceptance.',
    },
  };
}

function interruptAfterRecords(root: string, request: unknown) {
  const deliveryModule = join(project, 'scripts/harness/work/delivery.ts');
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const rename = fs.promises.rename;
    fs.promises.rename = async (before, after) => {
      if (String(after).endsWith('/complete/report.md')) throw new Error('INJECTED_REPORT_FAILURE');
      return rename(before, after);
    };
    syncBuiltinESMExports();
    const { deliver } = await import(${JSON.stringify(deliveryModule)});
    try { await deliver(${JSON.stringify(root)}, 'probe', ${JSON.stringify(json(request))}); }
    catch (error) { console.error(error.message); process.exitCode = 7; }
  `;
  const interrupted = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: project,
    encoding: 'utf8',
    timeout: 10000,
  });
  expect(interrupted.status, interrupted.stderr).toBe(7);
  expect(interrupted.stderr).toContain('INJECTED_REPORT_FAILURE');
}

it('prepares without public writes and requires explicit acceptance of the frozen candidate', async () => {
  const root = await fixture();
  const candidate = await setup(root);
  const before = await readFile(join(root, recordsPath(prd)), 'utf8');
  const prepared = await prepare(root);
  expect(prepared).toMatchObject({ readyForAcceptance: true, draft: { candidate } });
  expect(await readFile(join(root, recordsPath(prd)), 'utf8')).toBe(before);
  const request = await completeRequest(root);
  await expect(
    deliver(root, 'probe', json({ ...request, acceptance: undefined })),
  ).rejects.toThrow();
  await expect(
    deliver(
      root,
      'probe',
      json({
        ...request,
        acceptance: {
          ...request.acceptance,
          candidate: { ...candidate, contractRevision: candidate.contractRevision + 1 },
        },
      }),
    ),
  ).rejects.toThrow('candidate mismatch');
  expect(await readFile(join(root, recordsPath(prd)), 'utf8')).toBe(before);
  const done = await deliver(root, 'probe', json(request));
  expect(done).toMatchObject({ completed: true, replayed: false });
  const book = (await readBook(root, prd)).book;
  expect(book.results.find((entry) => entry.key === 'sibling')).toEqual(sibling);
  expect(book.results.find((entry) => entry.key === 'probe')!.acceptance).toEqual(
    request.acceptance,
  );
  expect(await deliver(root, 'probe', json(request))).toMatchObject({
    completed: true,
    replayed: true,
  });
  const completed = await loadTask(root, 'probe');
  completed.task.notes.push('Later progress note.');
  await saveTask(root, completed.task, completed.raw);
  const afterNote = (await loadTask(root, 'probe')).raw;
  expect(await deliver(root, 'probe', json(request))).toMatchObject({
    completed: true,
    replayed: true,
  });
  expect((await loadTask(root, 'probe')).raw).toBe(afterNote);
  await expect(deliver(root, 'probe', json({ ...request, revision: -1 }))).rejects.toThrow(
    'WORK_REQUEST',
  );
  expect((await assess(root, (await loadTask(root, 'probe')).task)).ready).toBe(false);
});

it('preserves an existing historical acceptance and draft during a normal task update', async () => {
  const root = await fixture();
  await setup(root);
  const existing = await loadTask(root, 'probe');
  const legacy = {
    version: 1 as const,
    draft: {
      path: '.work/tasks/probe/delivery/draft.md',
      sha256: 'c'.repeat(64),
      candidate: 'a'.repeat(64),
    },
    accepted: {
      path: 'docs/tasks/product/complete/report.md',
      sha256: 'b'.repeat(64),
      candidate: 'a'.repeat(64),
    },
  };
  existing.task.delivery = legacy;
  await saveTask(root, existing.task, existing.raw);
  const before = await loadTask(root, 'probe');
  const result = await updateTask(
    root,
    'probe',
    json({
      revision: taskRevision(before.task),
      reason: 'Update the next action while preserving the old acceptance.',
      plan: { nextAction: 'Continue reviewing the existing task.' },
    }),
  );
  expect(result.revision).toBe(taskRevision(before.task) + 1);
  expect((await loadTask(root, 'probe')).task.delivery).toEqual(legacy);
});

it('uses the same draft and acceptance gate with a historical delivery label', async () => {
  const root = await fixture();
  await setup(root);
  const existing = await loadTask(root, 'probe');
  existing.task.delivery!.version = 1;
  await saveTask(root, existing.task, existing.raw);
  const prepared = await prepare(root);
  expect(prepared).toMatchObject({ readyForAcceptance: true });
  const current = await loadTask(root, 'probe');
  expect(current.task.delivery?.version).toBe(1);
  expect((await assess(root, current.task)).readyForAcceptance).toBe(true);
});

it('retains the previously accepted key until a repair is explicitly accepted and preserves siblings', async () => {
  const root = await fixture();
  await setup(root, 'first', 'repair');
  await prepare(root, 'first');
  await deliver(root, 'first', json(await completeRequest(root, 'first')));
  const initial = (await readBook(root, prd)).book.results.find((entry) => entry.key === 'repair');
  commit(root);
  await setup(root, 'second', 'repair');
  await prepare(root, 'second');
  expect((await readBook(root, prd)).book.results.find((entry) => entry.key === 'repair')).toEqual(
    initial,
  );
  const request = await completeRequest(root, 'second');
  await deliver(root, 'second', json(request));
  const book = (await readBook(root, prd)).book;
  expect(book.results).toHaveLength(2);
  expect(book.results.find((entry) => entry.key === 'sibling')).toEqual(sibling);
  expect(book.results.find((entry) => entry.key === 'repair')!.acceptance).toEqual(
    request.acceptance,
  );
});

it('serializes different tasks publishing one PRD without losing accepted siblings', async () => {
  const root = await fixture();
  await setup(root, 'alpha');
  await setup(root, 'beta');
  await prepare(root, 'alpha');
  await prepare(root, 'beta');
  const [alpha, beta] = await Promise.all([
    completeRequest(root, 'alpha'),
    completeRequest(root, 'beta'),
  ]);
  const attempts = await Promise.allSettled([
    deliver(root, 'alpha', json(alpha)),
    deliver(root, 'beta', json(beta)),
  ]);
  expect(attempts.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
  expect(attempts.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
  const failure = attempts.find((entry) => entry.status === 'rejected');
  expect(String(failure?.reason)).toMatch(/WORK_PUBLISH_BUSY|WORK_CANDIDATE/);
  const book = (await readBook(root, prd)).book;
  expect(book.results.find((entry) => entry.key === 'sibling')).toEqual(sibling);
  expect(book.results.filter((entry) => ['alpha', 'beta'].includes(entry.key))).toHaveLength(1);
});

it('recovers an actual failure after records publication without replaying a journal', async () => {
  const root = await fixture();
  await setup(root);
  await prepare(root);
  const request = await completeRequest(root);
  interruptAfterRecords(root, request);
  expect(
    (await readBook(root, prd)).book.results.find((entry) => entry.key === 'probe')!.acceptance,
  ).toEqual(request.acceptance);
  expect((await loadTask(root, 'probe')).task.stage).toBe('C1_EVIDENCE_PENDING');
  expect(await deliver(root, 'probe', json(request))).toMatchObject({
    completed: true,
    replayed: true,
  });
  const book = (await readBook(root, prd)).book;
  expect(book.results.find((entry) => entry.key === 'sibling')).toEqual(sibling);
  expect(book.results.filter((entry) => entry.key === 'probe')).toHaveLength(1);
  expect((await loadTask(root, 'probe')).task.stage).toBe('C1_RELEASED');
  expect(await readFile(join(root, 'docs/tasks/product/complete/report.md'), 'utf8')).not.toContain(
    'sha256',
  );
});

it('does not apply an old accepted draft to a changed task contract after interruption', async () => {
  const root = await fixture();
  await setup(root);
  await prepare(root);
  const request = await completeRequest(root);
  interruptAfterRecords(root, request);
  const { task, raw } = await loadTask(root, 'probe');
  task.plan.authorization = 'The fixture user changed the authorized contract.';
  await saveTask(root, task, raw);
  await expect(
    deliver(root, 'probe', json({ ...request, revision: taskRevision(task) })),
  ).rejects.toThrow('WORK_DELIVERY_STALE');
  expect((await loadTask(root, 'probe')).task.stage).toBe('C1_EVIDENCE_PENDING');
  expect(
    (await readBook(root, prd)).book.results.find((entry) => entry.key === 'probe')!.acceptance,
  ).toEqual(request.acceptance);
});

it('preserves a manually edited report during recovery and rechecks original evidence', async () => {
  const root = await fixture();
  await setup(root);
  await prepare(root);
  const request = await completeRequest(root);
  interruptAfterRecords(root, request);
  const reportPath = 'docs/tasks/product/complete/report.md';
  const originalReport = await readFile(join(root, reportPath), 'utf8');
  const edited = `${originalReport}\nManual edit to preserve.\n`;
  await put(root, reportPath, edited);
  await expect(deliver(root, 'probe', json(request))).rejects.toThrow('WORK_DELIVERY_CONFLICT');
  expect(await readFile(join(root, reportPath), 'utf8')).toBe(edited);
  await put(root, reportPath, originalReport);
  const { task } = await loadTask(root, 'probe');
  const original = task.evidence.find((entry) => entry.criterion === 'quality-review')!;
  const content = await readFile(join(root, original.artifact), 'utf8');
  await put(root, original.artifact, 'changed');
  await expect(deliver(root, 'probe', json(request))).rejects.toThrow('WORK_DELIVERY_EVIDENCE');
  await put(root, original.artifact, content);
  expect(await deliver(root, 'probe', json(request))).toMatchObject({
    completed: true,
    replayed: true,
  });
});

it('refuses to overwrite a changed result or steal an interrupted publication lock', async () => {
  const root = await fixture();
  await setup(root);
  await prepare(root);
  const request = await completeRequest(root);
  const lock = `.work/publication/${digest(recordsPath(prd))}.lock`;
  await put(root, lock, json({ pid: 999999, records: recordsPath(prd) }));
  await expect(deliver(root, 'probe', json(request))).rejects.toThrow('WORK_PUBLISH_BUSY');
  await rm(join(root, lock));
  await deliver(root, 'probe', json(request));
  const { book } = await readBook(root, prd);
  book.results.find((entry) => entry.key === 'probe')!.outcomes = 'An intervening accepted edit.';
  await put(root, recordsPath(prd), json(book));
  await expect(deliver(root, 'probe', json(request))).rejects.toThrow('WORK_DELIVERY_CONFLICT');
  expect(
    (await readBook(root, prd)).book.results.find((entry) => entry.key === 'probe')!.outcomes,
  ).toBe('An intervening accepted edit.');
});

it('accepts configured public roots and rejects private, invalid and symlink locations', async () => {
  const root = await fixture();
  await setup(root);
  const valid = [
    'README.md',
    'compute/src/worker.ts',
    'contracts/compute/src/index.ts',
    'packages/foundation/src/index.ts',
  ];
  expect(
    await prepare(
      root,
      'probe',
      valid.map((path) => ({ path, purpose: 'Public entry.' })),
    ),
  ).toMatchObject({ readyForAcceptance: true });
  const examples = [
    '.work/private.md',
    'src/../package.json',
    'src/missing.ts',
    'docs/api.md#section',
  ];
  for (const path of examples) {
    await expect(prepare(root, 'probe', [{ path, purpose: 'Invalid.' }])).rejects.toThrow();
  }
  await symlink('api.md', join(root, 'docs/link.md'));
  await expect(
    prepare(root, 'probe', [{ path: 'docs/link.md', purpose: 'Symlink.' }]),
  ).rejects.toThrow();
});

it('does not accept a damaged original, a stale draft or a dirty new candidate', async () => {
  const root = await fixture();
  await setup(root);
  await prepare(root);
  const request = await completeRequest(root);
  const { task } = await loadTask(root, 'probe');
  const original = task.evidence.find((entry: Evidence) => entry.criterion === 'quality-review')!;
  await put(root, original.artifact, 'changed');
  await expect(deliver(root, 'probe', json(request))).rejects.toThrow();
  expect((await readBook(root, prd)).book.results).toEqual([sibling]);
  await put(root, 'src/value.ts', 'export const value = 2;\n');
  await expect(deliver(root, 'probe', json({ ...request, draftId: 'wrong' }))).rejects.toThrow(
    'WORK_DELIVERY_STALE',
  );
  await expect(deliver(root, 'probe', json(request))).rejects.toThrow();
});

it.each([
  ['quality-review', 'missing'],
  ['quality-review', 'fail'],
  ['norms-review', 'pending'],
])('requires a current %s original with a passing result (%s)', async (criterion, result) => {
  const root = await fixture();
  await setup(root);
  const { task, raw } = await loadTask(root, 'probe');
  const item = task.evidence.find((entry) => entry.criterion === criterion)!;
  if (result === 'missing') task.evidence = task.evidence.filter((entry) => entry !== item);
  else {
    const source = await readFile(join(root, item.artifact), 'utf8');
    const changed = source.replaceAll('"result": "pass"', `"result": "${result}"`);
    await put(root, item.artifact, changed);
    item.sha256 = digest(changed);
    item.result = result;
  }
  await saveTask(root, task, raw);
  await expect(prepare(root)).rejects.toThrow('WORK_DELIVERY_EVIDENCE');
  expect((await readBook(root, prd)).book.results).toEqual([sibling]);
});

it('does not prepare when a later supplemental check failed', async () => {
  const root = await fixture();
  const candidate = await setup(root);
  const { task, raw } = await loadTask(root, 'probe');
  const artifact = '.work/tasks/probe/evidence/later-failure.log';
  const source =
    json({ candidate, contract: contractPlan(task), argv: ['node', '-e', 'process.exit(1)'] }) +
    resultMarker +
    json({ exitCode: 1, signal: null, cancelled: false, unsettled: false, contextChanged: false });
  await put(root, artifact, source);
  task.evidence.push({
    criterion: 'checks',
    method: 'automated',
    result: 'fail',
    candidate,
    artifact,
    sha256: digest(source),
    summary: 'Later failure.',
    environment: 'Fixture.',
  });
  await saveTask(root, task, raw);
  await expect(prepare(root)).rejects.toThrow('WORK_DELIVERY_EVIDENCE');
  expect((await readBook(root, prd)).book.results).toEqual([sibling]);
});

it('rejects fresh publication with staged or untracked changes even when the draft was reviewed', async () => {
  const root = await fixture();
  await setup(root);
  await prepare(root);
  const request = await completeRequest(root);
  await put(root, 'src/value.ts', 'export const value = 2;\n');
  git(root, 'add', 'src/value.ts');
  await put(root, 'src/untracked.ts', 'export const extra = true;\n');
  await expect(deliver(root, 'probe', json(request))).rejects.toThrow('WORK_CANDIDATE');
  expect((await readBook(root, prd)).book.results).toEqual([sibling]);
  expect((await loadTask(root, 'probe')).task.stage).toBe('C1_EVIDENCE_PENDING');
});

it('reads records without a report, while guard checks its derivation and PRD ownership', async () => {
  const root = await fixture();
  const catalog = await documentCatalog(root);
  const paths = bookPaths(prd, catalog);
  await rm(join(root, paths.report));
  expect((await readBook(root, prd)).book.results).toEqual([sibling]);
  expect(await readPublicResult(root, [prd, 'sibling'])).toBeTruthy();
  expect((await checkReports(root, [paths.records]))[0]).toContain('WORK_REPORT_DRIFT');
  await put(root, paths.report, 'stale');
  expect((await readBook(root, prd)).book.results).toEqual([sibling]);
  expect((await checkReports(root, [paths.report, paths.records]))[0]).toContain(
    'WORK_REPORT_DRIFT',
  );
  await rm(join(root, paths.report));
  await symlink('unexpected-target.md', join(root, paths.report));
  expect((await readBook(root, prd)).book.results).toEqual([sibling]);
  expect((await checkReports(root, [paths.report, paths.records]))[0]).toContain(
    'WORK_REPORT_DRIFT',
  );
  await rm(join(root, paths.report));
  await put(root, paths.report, 'stale');
  await put(
    root,
    paths.records,
    json({ version: 5, prd: 'docs/tasks/elsewhere/prd.md', results: [sibling] }),
  );
  await expect(readBook(root, prd)).rejects.toThrow('WORK_REPORT_BINDING');
  await expect(readResultInput(root, `${recordsPath(prd)}#result=sibling`)).rejects.toThrow();
  await rm(join(root, paths.records));
  await expect(readBook(root, prd)).rejects.toThrow('WORK_REPORT_INTEGRITY');
});

it('uses a stable PRD identity, rejects orphan results and leaves the static index untouched', async () => {
  const root = await fixture(false);
  const identity = 'docs/old-product.md';
  await put(root, identity, '# 资料已迁移\n\n[Current PRD](tasks/product/prd.md)\n');
  for (const [path, source] of Object.entries(
    taskDocumentFiles([{ identity, kind: 'prd', path: prd, aliases: [identity] }]),
  ))
    await put(root, path, source);
  commit(root);
  const before = await readFile(join(root, taskIndexPath), 'utf8');
  await setup(root, 'probe', 'probe', identity);
  await prepare(root);
  await deliver(root, 'probe', json(await completeRequest(root)));
  expect(await readBook(root, identity)).toEqual(await readBook(root, prd));
  const book = (await readBook(root, prd)).book;
  expect(book.prd).toBe(identity);
  expect(await readFile(join(root, taskIndexPath), 'utf8')).toBe(before);
  const paths = bookPaths(prd, await documentCatalog(root));
  expect(await checkReports(root, [paths.report, paths.records])).toEqual([]);
  const orphan = 'docs/tasks/product/complete/extra.md';
  await put(root, orphan, '# Orphan\n');
  expect(await checkReports(root, [paths.report, paths.records, orphan])).toEqual([
    `WORK_REPORT_ORPHAN: ${orphan}`,
  ]);
});

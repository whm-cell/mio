import {
  taskDocumentFiles,
  taskIndex,
  taskIndexPath as indexPath,
  writeTaskDocuments,
} from './task-documents-fixture.ts';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { assess, capture, inputStamp } from '../scripts/harness/work/context.ts';
import {
  parseRecords,
  recordsPath,
  resultSelector,
} from '../scripts/harness/work/compact-store.ts';
import type { ResultBook } from '../scripts/harness/work/compact-store.ts';
import { deliver, markdown } from '../scripts/harness/work/delivery.ts';
import { loadOperation, operationPath } from '../scripts/harness/work/delivery-store.ts';
import { handoff, receive } from '../scripts/harness/work/handoff.ts';
import { updateTask } from '../scripts/harness/work/manage.ts';
import {
  bookPaths,
  checkReports,
  parseDraft,
  readBook,
  readResultInput,
  renderBook,
  reportPath,
} from '../scripts/harness/work/reports.ts';
import {
  digest,
  draft,
  initializeMember,
  json,
  loadTask,
  parseTask,
  saveTask,
} from '../scripts/harness/work/records.ts';
import { inventory, loadConfig } from '../scripts/harness/inventory.ts';
import { documentCatalog, resolveDocument } from '../scripts/harness/task-documents.ts';
import { reviewFixture, reviewMarkdown } from './quality-review-fixture.ts';
import { verify } from '../scripts/harness/work/verification.ts';
import {
  fullCommand,
  record as recordVerification,
  testConditions,
} from './verification-fixture.ts';

const project = resolve('.');
const prd = 'docs/tasks/product/prd.md';
const otherPrd = 'docs/tasks/another/prd.md';
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(prds = [prd, otherPrd]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mio-delivery-')));
  scratch.push(root);
  const config = await loadConfig(project);
  const documents = prds.map((path) => ({ identity: path, kind: 'prd' as const, path }));
  const files = {
    'harness.config.json': json(config),
    'package.json': '{"type":"module"}\n',
    '.gitignore': '.work/\n',
    'AGENTS.md': '# Development\n',
    'README.md': '[Documentation](docs/index.md)\n',
    'docs/index.md': '[Tasks](tasks/index.md) [API](api.md)\n',
    'docs/api.md': '# API\n',
    'src/value.ts': 'export const value = 1;\n',
    ...Object.fromEntries(prds.map((path) => [path, '# Capability PRD\n'])),
    ...taskDocumentFiles(documents),
    [indexPath]: taskIndex,
  };
  for (const [path, value] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), value);
  }
  for (const path of ['docs/coordination.md', 'docs/work-records.md'])
    await cp(join(project, path), join(root, path));
  expect(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root }).status).toBe(0);
  await initializeMember(root, 'alice');
  return root;
}
async function results(root: string, source = prd) {
  return (await readBook(root, source)).book;
}
async function setup(
  root: string,
  id = 'probe',
  key: string | null = id,
  source = prd,
  extras: string[] = [],
  scope = ['src', 'docs'],
) {
  const task = draft(root, 'alice', id, 'Implement a capability');
  Object.assign(task.plan, {
    result: null,
    scope,
    sources: ['docs/api.md'],
    authorization: 'Fixture user authorized implementation.',
    acceptance: [
      {
        id: 'checks',
        criterion: 'Capability returns 1.',
        method: 'automated',
        command: ['node', 'fixture-check.js'],
      },
      { id: 'quality-review', criterion: 'Review source.', method: 'review' },
      ...extras.map((id) => ({
        id,
        criterion: 'Fixture extra check.',
        method: 'automated',
        command: ['node', `${id}.js`],
      })),
    ],
    nextAction: 'Verify',
    stopCondition: 'Return for acceptance',
  });
  if (key !== null) {
    task.plan.result = { prd: source, key };
    task.plan.norms = { version: 2, paths: ['docs/api.md'], reason: 'Fixture preserves this API.' };
    task.plan.acceptance.push({ id: 'norms-review', method: 'review', criterion: 'Review norms.' });
    task.delivery = { version: 2 };
  }
  task.checkpoint = await capture(root, task);
  task.stage = 'C0_READY';
  await saveTask(root, task);
  await passing(root, id);
}
async function passing(root: string, id = 'probe') {
  const { task, raw } = await loadTask(root, id);
  task.checkpoint = await capture(root, task);
  const artifact = `.work/tasks/${id}/evidence/checks-${task.evidence.length}.log`;
  await mkdir(dirname(join(root, artifact)), { recursive: true });
  const output =
    json({ argv: task.plan.acceptance[0]!.command, candidate: task.checkpoint.candidate }) +
    'Observed fixture capability\n';
  await writeFile(join(root, artifact), output);
  task.evidence.push({
    criterion: 'checks',
    method: 'automated',
    result: 'pass',
    candidate: task.checkpoint.candidate,
    artifact,
    sha256: digest(output),
    summary: 'Fixture observation',
    environment: 'isolated fixture',
  });
  for (const criterion of task.plan.acceptance.filter(
    (entry) => entry.method === 'automated' && entry.id !== 'checks',
  )) {
    const content =
      json({ argv: criterion.command, candidate: task.checkpoint.candidate }) +
      `Observed independent fixture criterion ${criterion.id}.\n`;
    const extraArtifact = `.work/tasks/${id}/evidence/${criterion.id}-${task.evidence.length}.log`;
    await writeFile(join(root, extraArtifact), content);
    task.evidence.push({
      ...task.evidence.at(-1)!,
      criterion: criterion.id,
      artifact: extraArtifact,
      sha256: digest(content),
      summary: `Independent fixture observation for ${criterion.id}`,
    });
  }
  const review = reviewMarkdown(reviewFixture(task.checkpoint.candidate));
  const path = `.work/tasks/${id}/evidence/review-${task.evidence.length}.md`;
  await writeFile(join(root, path), review);
  task.evidence.push({
    criterion: 'quality-review',
    method: 'review',
    result: 'pass',
    candidate: task.checkpoint.candidate,
    artifact: path,
    sha256: digest(review),
    summary: 'Fixture quality review',
    environment: 'isolated fixture',
  });
  if (task.plan.norms) {
    const catalog = await documentCatalog(root);
    const sourcePath = task.plan.result
      ? resolveDocument(task.plan.result.prd, catalog).currentPath
      : undefined;
    const requirements = new Set([
      ...(sourcePath ? [sourcePath] : []),
      ...task.plan.sources
        .map((source) => resolveDocument(source, catalog))
        .filter((source) => source.kind !== undefined)
        .map((source) => source.currentPath),
    ]);
    const report = `# Fixture norms review\n\n\`\`\`mio-norms-review\n${json({
      candidate: task.checkpoint.candidate,
      reviewer: 'isolated fixture reviewer',
      reason: task.plan.norms.reason,
      ...(task.plan.norms.version === 2
        ? {
            version: 2,
            requirements: {
              result: 'pass',
              assessment:
                'Fixture PRD is the declared capability source; there is no separate design.',
              documents: [...requirements].map((path) => ({
                path,
                sha256: task.checkpoint!.files[path],
                assessment: 'Synthetic fixture capability covers this source.',
              })),
            },
            accepted: {
              result: 'pass',
              assessment:
                'Synthetic fixture observations only; existing accepted candidates are not reinterpreted.',
              results: [],
            },
            remaining: 'No remaining fixture decisions; real acceptance is separate.',
          }
        : {}),
      documents: task.plan.norms.paths.map((path) => ({
        path,
        sha256: task.checkpoint!.files[path],
        ...(task.plan.norms!.version === 2 ? { result: 'pass' } : {}),
        assessment: 'Fixture API and behavior agree.',
      })),
      conclusion: { result: 'pass', evidence: 'Synthetic fixture observation, not a real review.' },
      limitations: 'Tests the binding protocol only.',
    })}\`\`\`\n`;
    const artifact = `.work/tasks/${id}/evidence/norms-${task.evidence.length}.md`;
    await writeFile(join(root, artifact), report);
    task.evidence.push({
      criterion: 'norms-review',
      method: 'review',
      result: 'pass',
      candidate: task.checkpoint.candidate,
      artifact,
      sha256: digest(report),
      summary: 'Fixture norms review',
      environment: 'isolated fixture',
    });
  }
  task.stage = 'C1_EVIDENCE_PENDING';
  task.reviewDecision = 'PENDING';
  task.releaseDisposition = 'HOLD_FOR_EVIDENCE';
  await saveTask(root, task, raw);
}

async function prepareRequest(root: string, id = 'probe') {
  return {
    action: 'prepare',
    revision: digest((await loadTask(root, id)).raw),
    title: 'Capability query',
    outcomes: 'Returns the requested capability.',
    locations: [
      { path: 'src/value.ts', purpose: 'Capability entry' },
      { path: 'docs/api.md', purpose: 'Contract' },
    ],
    verification: 'Synthetic fixture observation; no real business acceptance.',
    limitations: 'Fixture only.',
  };
}
async function prepare(root: string, id = 'probe') {
  return deliver(root, id, json(await prepareRequest(root, id)));
}

it.each([false, true])(
  'keeps reused checks consistent through prepare and complete (source failure: %s)',
  async (fail) => {
    const root = await fixture();
    for (const id of ['source', 'probe']) {
      await setup(root, id);
      const { task, raw } = await loadTask(root, id);
      task.plan.acceptance[0]!.command = [process.execPath, '-e', 'process.exit(0)'];
      await saveTask(root, task, raw);
      await passing(root, id);
    }
    const executed = invoke(root, ['run', 'source', 'checks', '--stdin'], {
      conditions: testConditions,
    });
    expect(executed.status, executed.stderr).toBe(0);
    const entry = (await loadTask(root, 'source')).task.evidence.at(-1)!;
    const baseline = { task: 'source', criterion: 'checks', sha256: entry.sha256 };
    const current = await verify(root, 'probe', 'checks', { action: 'inspect', baseline });
    await verify(root, 'probe', 'checks', {
      action: 'record',
      baseline,
      revision: 'revision' in current ? current.revision : '',
      mode: 'reuse',
      coverage:
        'Same fixture files and actual check; independent manual criteria retain their own observations.',
      environment: {
        identity: 'environment' in current ? current.environment : '',
        conditions: testConditions,
        reason: 'Identical isolated fixture conditions.',
      },
    });
    await prepare(root);
    if (fail) {
      expect(
        invoke(root, ['run', 'source', 'checks', '--', process.execPath, '-e', 'process.exit(2)'])
          .status,
      ).toBe(1);
      expect(
        (await assess(root, (await loadTask(root, 'probe')).task)).evidence[0]!.result,
      ).not.toBe('pass');
      await expect(prepare(root)).rejects.toThrow();
      await expect(deliver(root, 'probe', json(await completeRequest(root)))).rejects.toThrow();
    } else {
      await deliver(root, 'probe', json(await completeRequest(root)));
      expect((await loadTask(root, 'probe')).task.stage).toBe('C1_RELEASED');
    }
  },
);

it.each(['probe', 'source'])(
  'composes scoped supplemental receipts through prepare and complete (origin: %s)',
  async (origin) => {
    const root = await fixture();
    for (const id of ['source', 'probe']) {
      await setup(root, id);
      const { task, raw } = await loadTask(root, id);
      task.plan.acceptance[0]!.command = fullCommand;
      await saveTask(root, task, raw);
      await passing(root, id);
    }
    const full = invoke(root, ['run', origin, 'checks', '--stdin'], { conditions: testConditions });
    expect(full.status, full.stderr).toBe(0);
    const fullEntry = (await loadTask(root, origin)).task.evidence.at(-1)!;
    const baseline = { task: origin, criterion: 'checks', sha256: fullEntry.sha256 };
    const command = [
      process.execPath,
      '-e',
      "require('node:fs').appendFileSync('.work/count','probe\\n')",
    ];
    const probe = invoke(root, ['run', origin, 'checks', '--stdin'], {
      conditions: testConditions,
      command,
    });
    expect(probe.status, probe.stderr).toBe(0);
    const probeEntry = (await loadTask(root, origin)).task.evidence.at(-1)!;
    const original = { task: origin, criterion: 'checks', sha256: probeEntry.sha256 };
    const { task, raw } = await loadTask(root, 'probe');
    task.plan.acceptance.push({
      id: 'scoped',
      method: 'automated',
      criterion: 'Retain the actual focused observation.',
      command,
    });
    await saveTask(root, task, raw);
    await passing(root);
    const scoped = recordVerification(root, 'probe', original, {}, 'scoped');
    expect(scoped.status, scoped.output).toBe(0);
    const entry = (await loadTask(root, 'probe')).task.evidence.at(-1)!;
    const composed = recordVerification(root, 'probe', baseline, {
      mode: 'incremental',
      runs: [{ task: 'probe', criterion: 'scoped', sha256: entry.sha256 }],
    });
    expect(composed.status, composed.output).toBe(0);
    const checked = invoke(root, ['context', 'probe', 'resume']);
    expect(checked.status, checked.stderr).toBe(0);
    expect(JSON.parse(checked.stdout).assessment.evidence[0].result).toBe('pass');
    await prepare(root);
    await deliver(root, 'probe', json(await completeRequest(root)));
    expect((await loadTask(root, 'probe')).task.stage).toBe('C1_RELEASED');
    expect(await readFile(join(root, '.work/count'), 'utf8')).toBe('full\nprobe\n');
  },
);

async function completeRequest(root: string, id = 'probe') {
  const { task, raw } = await loadTask(root, id);
  return {
    action: 'complete',
    revision: digest(raw),
    draftSha256: task.delivery!.draft!.sha256,
    acceptance: {
      candidate: task.checkpoint!.candidate,
      statement: 'Fixture user accepts this exact result.',
      reference: 'Fixture acceptance transcript #1',
    },
  };
}
async function finish(root: string, id = 'probe') {
  await prepare(root, id);
  const request = await completeRequest(root, id);
  await deliver(root, id, json(request));
  return request;
}
function invoke(root: string, args: string[], input?: unknown) {
  return spawnSync(process.execPath, [join(project, 'scripts/harness/work/cli.ts'), ...args], {
    cwd: root,
    encoding: 'utf8',
    input: input === undefined ? undefined : json(input),
  });
}
async function publicFiles(root: string) {
  const files = (await inventory(root, await loadConfig(root))).files;
  return Object.fromEntries(
    await Promise.all(
      files
        .filter((path) => path.startsWith('docs/tasks/'))
        .map(async (path) => [path, digest(await readFile(join(root, path)))]),
    ),
  );
}
async function rewriteBook(root: string, book: ResultBook) {
  const catalog = await documentCatalog(root);
  const paths = bookPaths(book.prd, catalog);
  const bytes = json(book);
  const report = await markdown(renderBook(book, paths.currentPath, bytes));
  await writeFile(join(root, paths.records), bytes);
  await writeFile(join(root, paths.report), report);
}
async function rewind(root: string, id: string, cut: number) {
  const loaded = (await loadOperation(root, id))!;
  if (!loaded.operation) throw new Error('Fixture needs a current journal');
  const operation = loaded.operation;
  operation.done = false;
  for (const [index, change] of operation.changes.entries()) {
    const bytes = index < cut ? change.after : change.before;
    if (bytes === null) await rm(join(root, change.path), { force: true });
    else await writeFile(join(root, change.path), bytes);
  }
  await writeFile(join(root, operationPath(id)), json(operation));
  return operation;
}
it.each(['begin', 'finish'])(
  'preserves a journal edit at the %s compare-and-write boundary',
  async (boundary) => {
    const root = await fixture();
    await setup(root);
    await prepare(root);
    const store = pathToFileURL(join(project, 'scripts/harness/work/delivery-store.ts')).href;
    const records = pathToFileURL(join(project, 'scripts/harness/work/records.ts')).href;
    const script = `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { resolve } from 'node:path';
    import { commitDelivery, operationPath } from ${JSON.stringify(store)};
    import { digest, json, loadTask } from ${JSON.stringify(records)};
    const root = process.cwd();
    const { task, raw } = await loadTask(root, 'probe');
    const journal = resolve(root, operationPath('probe'));
    const originalRead = fs.readFile;
    const originalRename = fs.rename;
    let injected = false;
    let external;
    if (${JSON.stringify(boundary)} === 'begin') {
      fs.readFile = async function(path, ...args) {
        const bytes = await originalRead.call(this, path, ...args);
        if (String(path) === journal && !injected) {
          injected = true;
          external = json({ ...JSON.parse(bytes.toString()), reviewerNote: 'Preserve this external edit' });
          await fs.writeFile(journal, external);
        }
        return bytes;
      };
    } else {
      fs.rename = async function(from, to) {
        await originalRename.call(this, from, to);
        if (String(to) === resolve(root, '.work/tasks/probe/state.json') && !injected) {
          injected = true;
          external = json({ ...JSON.parse(await originalRead(journal, 'utf8')), reviewerNote: 'Preserve this external edit' });
          await fs.writeFile(journal, external);
        }
      };
    }
    syncBuiltinESMExports();
    task.notes.push('New fixture preparation');
    let error;
    try { await commitDelivery(root, task, raw, digest('fixture next request'), 'prepare', {}, {}); }
    catch (caught) { error = String(caught); }
    finally { fs.readFile = originalRead; fs.rename = originalRename; syncBuiltinESMExports(); }
    console.log(json({ injected, error, preserved: (await fs.readFile(journal, 'utf8')) === external }));
  `;
    const observed = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(observed.status, observed.stderr).toBe(0);
    expect(JSON.parse(observed.stdout)).toMatchObject({
      injected: true,
      error: expect.stringContaining('WORK_DELIVERY_CONFLICT'),
      preserved: true,
    });
  },
);

// v5 public-result behavior.
it('keeps a prepared large scope ready for review while still rejecting damaged evidence', async () => {
  const root = await fixture();
  await setup(root);
  const { task, raw } = await loadTask(root, 'probe');
  task.plan.scope.push(...Array.from({ length: 6 }, (_, index) => `src/planned-${index}.ts`));
  await saveTask(root, task, raw);
  await passing(root);
  await prepare(root);
  const current = invoke(root, ['context', 'probe', 'deliver']);
  expect(current.status, current.stderr).toBe(0);
  const view = JSON.parse(current.stdout);
  expect(view.task.result).toEqual({ prd, key: 'probe' });
  expect(view.assessment.readyForAcceptance).toBe(true);
  expect(view.assessment.reading.omitted).toEqual(['scope']);
  const checked = JSON.parse(invoke(root, ['check', 'probe']).stdout);
  expect(checked.readyForAcceptance).toBe(true);
  expect(checked.requiredContext.result).toEqual(view.task.result);
  const loaded = await loadTask(root, 'probe');
  const entry = loaded.task.evidence.at(-1)!;
  await writeFile(join(root, entry.artifact), 'Damaged fixture original');
  const damaged = JSON.parse(invoke(root, ['check', 'probe']).stdout);
  expect(damaged.readyForAcceptance).toBe(false);
  expect(damaged.evidenceCounts.corrupt).toBe(1);
  await expect(deliver(root, 'probe', json(await completeRequest(root)))).rejects.toThrow();
});

it('prepares privately and publishes only a current, explicitly accepted v5 summary', async () => {
  const root = await fixture();
  await setup(root);
  const before = await publicFiles(root);
  await prepare(root);
  const { task } = await loadTask(root, 'probe');
  const candidate = task.checkpoint!.candidate;
  const bytes = await readFile(join(root, task.delivery!.draft!.path), 'utf8');
  expect(parseDraft(bytes)).toMatchObject({ version: 5, candidate });
  expect(parseDraft(bytes).evidence).toHaveLength(task.plan.acceptance.length);
  expect(await publicFiles(root)).toEqual(before);
  await expect(
    readFile(join(root, '.work/tasks/probe/delivery/evidence/checks.md')),
  ).rejects.toThrow();
  expect((await assess(root, task)).readyForAcceptance).toBe(true);
  await expect(
    deliver(root, 'probe', json({ ...(await completeRequest(root)), acceptance: undefined })),
  ).rejects.toThrow();
  const request = await completeRequest(root);
  await deliver(root, 'probe', json(request));
  const book = await results(root);
  expect(book.results).toHaveLength(1);
  expect(book.results[0]!.acceptance).toEqual(request.acceptance);
  expect(Object.keys(book.results[0]!).sort()).toEqual([
    'acceptance',
    'key',
    'limitations',
    'locations',
    'outcomes',
    'title',
    'verification',
  ]);
  expect(json(book)).not.toMatch(
    /"files"|"head"|"contract"|"artifacts"|"criteria"|Observed fixture capability|\.work\//,
  );
  expect(await deliver(root, 'probe', json(request))).toMatchObject({
    completed: true,
    replayed: true,
  });
  expect((await assess(root, (await loadTask(root, 'probe')).task)).ready).toBe(true);
  const cli = invoke(root, ['read-result', prd, 'probe']);
  expect(cli.status, cli.stderr).toBe(0);
  expect(cli.stdout).toContain('locations');
  expect(invoke(root, ['read-result', prd, 'probe', '--select', '/artifacts/checks']).status).toBe(
    1,
  );
});

it('adds siblings and replaces only a newly accepted key without requiring a commit or historical evidence', async () => {
  const root = await fixture();
  await setup(root, 'alpha');
  await finish(root, 'alpha');
  const alpha = (await results(root)).results[0]!;
  await setup(root, 'beta');
  await finish(root, 'beta');
  const beta = (await results(root)).results.find((entry) => entry.key === 'beta')!;
  const loaded = await loadTask(root, 'alpha');
  await updateTask(
    root,
    'alpha',
    json({
      revision: digest(loaded.raw),
      reason: 'Fixture user requests repair',
      reopen: true,
      plan: {
        authorization: 'Repair this capability.',
        nextAction: 'Reconcile the repair scope and current candidate.',
      },
    }),
  );
  expect((await results(root)).results[0]).toEqual(alpha);
  expect((await loadTask(root, 'alpha')).task.reviewDecision).toBe('PENDING');
  await passing(root, 'alpha');
  const request = {
    ...(await prepareRequest(root, 'alpha')),
    outcomes: 'A newly accepted result.',
  };
  await deliver(root, 'alpha', json(request));
  expect((await results(root)).results[0]).toEqual(alpha);
  await deliver(root, 'alpha', json(await completeRequest(root, 'alpha')));
  const updated = await results(root);
  expect(updated.results.find((entry) => entry.key === 'beta')).toEqual(beta);
  expect(updated.results.find((entry) => entry.key === 'alpha')!.outcomes).toBe(request.outcomes);
  expect((await results(root)).results).toHaveLength(2);
  expect(spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root }).status).not.toBe(0);
});

it('keeps failed repairs and later accepted repairs on one change key while preserving a new issue', async () => {
  const root = await fixture();
  const change = 'docs/tasks/product/changes/bug/change.md';
  const other = 'docs/tasks/product/changes/new-issue/change.md';
  const content = (title: string) =>
    `# ${title}\n\n\`\`\`mio-change\n{"version":1,"type":"fix","section":"Capability PRD"}\n\`\`\`\n`;
  for (const path of [change, other]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content(path === change ? 'Repair bug' : 'New issue'));
  }
  await writeTaskDocuments(root, [
    { kind: 'prd', identity: prd, path: prd },
    { kind: 'prd', identity: otherPrd, path: otherPrd },
    { kind: 'change', identity: change, path: change },
    { kind: 'change', identity: other, path: other },
  ]);
  await setup(root, 'new-issue');
  await finish(root, 'new-issue');
  const sibling = (await results(root)).results.find((entry) => entry.key === 'new-issue');

  await setup(root, 'bug');
  const initial = await loadTask(root, 'bug');
  initial.task.plan.sources.push(change);
  initial.task.checkpoint = await capture(root, initial.task);
  await saveTask(root, initial.task, initial.raw);
  await passing(root, 'bug');
  const failed = invoke(root, [
    'run',
    'bug',
    'checks',
    '--',
    process.execPath,
    '-e',
    'process.exit(1)',
  ]);
  expect(failed.status).toBe(1);
  expect((await loadTask(root, 'bug')).task.evidence.at(-1)!.result).toBe('fail');
  await expect(prepare(root, 'bug')).rejects.toThrow();
  await writeFile(join(root, change), content('Repair bug after failed verification'));
  expect(invoke(root, ['sync', 'bug', 'Reviewed the failed candidate and repair']).status).toBe(0);
  const afterRepair = (await assess(root, (await loadTask(root, 'bug')).task)).evidence;
  expect(afterRepair.find((entry) => entry.criterion === 'checks')!.result).not.toBe('pass');
  await passing(root, 'bug');
  await finish(root, 'bug');
  const accepted = (await results(root)).results.find((entry) => entry.key === 'bug')!;

  const loaded = await loadTask(root, 'bug');
  await updateTask(
    root,
    'bug',
    json({
      revision: digest(loaded.raw),
      reason: 'Fixture user requests another repair',
      reopen: true,
      plan: { authorization: 'Repair the same issue.', nextAction: 'Verify the new candidate.' },
    }),
  );
  await writeFile(join(root, change), content('Repair bug after first acceptance'));
  expect(invoke(root, ['sync', 'bug', 'Reviewed the new repair candidate']).status).toBe(0);
  expect((await results(root)).results.find((entry) => entry.key === 'bug')).toEqual(accepted);
  expect(
    (await assess(root, (await loadTask(root, 'bug')).task)).evidence.find(
      (entry) => entry.criterion === 'checks',
    )!.result,
  ).not.toBe('pass');
  await expect(prepare(root, 'bug')).rejects.toThrow();
  await passing(root, 'bug');
  const draft = { ...(await prepareRequest(root, 'bug')), outcomes: 'Accepted later repair.' };
  await deliver(root, 'bug', json(draft));
  expect((await results(root)).results.find((entry) => entry.key === 'bug')).toEqual(accepted);
  await deliver(root, 'bug', json(await completeRequest(root, 'bug')));
  const updated = (await results(root)).results;
  expect(updated.find((entry) => entry.key === 'bug')!.outcomes).toBe(draft.outcomes);
  expect(updated.find((entry) => entry.key === 'new-issue')).toEqual(sibling);
  expect(updated).toHaveLength(2);
});

it('keeps maintenance local and archives without creating public results', async () => {
  const root = await fixture();
  await setup(root, 'maintain', null);
  const before = await publicFiles(root);
  await expect(prepare(root, 'maintain')).rejects.toThrow('WORK_DELIVERY_RESULT');
  const archived = invoke(root, ['archive', 'maintain', 'Fixture maintenance checked']);
  expect(archived.status, archived.stderr).toBe(0);
  expect((await loadTask(root, 'maintain')).task.archived).toBe(true);
  expect(await publicFiles(root)).toEqual(before);
});

it.each(['C1_IMPLEMENTATION', 'C1_EVIDENCE_PENDING'])(
  'never prepares or completes a missing-command result in %s',
  async (stage) => {
    const root = await fixture();
    await setup(root);
    await prepare(root);
    const complete = await completeRequest(root);
    const { task, raw } = await loadTask(root, 'probe');
    const originals = task.evidence;
    delete task.plan.acceptance[0]!.command;
    task.stage = stage;
    task.checkpoint = await capture(root, task);
    await saveTask(root, task, raw);
    const before = await publicFiles(root);
    const assessment = await assess(root, task);
    expect(assessment.evidence.find((entry) => entry.criterion === 'checks')!.result).toBe(
      'pending',
    );
    expect(assessment.readyForAcceptance).toBe(false);
    await expect(prepare(root)).rejects.toThrow(/WORK_CHECK_COMMAND|WORK_DELIVERY_EVIDENCE/);
    await expect(
      deliver(
        root,
        'probe',
        json({ ...complete, revision: digest((await loadTask(root, 'probe')).raw) }),
      ),
    ).rejects.toThrow(/WORK_CHECK_COMMAND|WORK_DELIVERY_EVIDENCE|WORK_DELIVERY_STALE/);
    expect(await publicFiles(root)).toEqual(before);
    expect((await loadTask(root, 'probe')).task.evidence).toEqual(originals);
    expect((await loadTask(root, 'probe')).task.delivery!.accepted).toBeUndefined();
  },
);

it('binds the complete check and later supplements in the acceptance draft', async () => {
  const root = await fixture();
  await setup(root);
  const complete = (await loadTask(root, 'probe')).task.evidence[0]!;
  const supplement = invoke(root, [
    'run',
    'probe',
    'checks',
    '--',
    process.execPath,
    '-e',
    'console.log("partial probe")',
  ]);
  expect(supplement.status, supplement.stderr).toBe(0);
  const partial = (await loadTask(root, 'probe')).task.evidence.at(-1)!;
  await prepare(root);
  const prepared = (await loadTask(root, 'probe')).task;
  const draft = parseDraft(await readFile(join(root, prepared.delivery!.draft!.path), 'utf8'));
  expect(draft.evidence.filter((entry) => entry.criterion === 'checks')).toEqual([
    complete,
    partial,
  ]);
  await writeFile(join(root, complete.artifact), 'damaged complete check');
  await expect(deliver(root, 'probe', json(await completeRequest(root)))).rejects.toThrow(
    'WORK_DELIVERY_EVIDENCE',
  );
  await passing(root);
  await prepare(root);
  const refreshed = (await loadTask(root, 'probe')).task;
  const next = parseDraft(await readFile(join(root, refreshed.delivery!.draft!.path), 'utf8'));
  expect(next.evidence.filter((entry) => entry.criterion === 'checks')).toHaveLength(1);
  expect(
    next.evidence.some(
      (entry) => entry.artifact === complete.artifact || entry.artifact === partial.artifact,
    ),
  ).toBe(false);
  expect(refreshed.evidence.some((entry) => entry.artifact === complete.artifact)).toBe(true);
});

it.each([false, true])(
  'corrects a mistaken result declaration without discarding originals (draft=%s)',
  async (prepared) => {
    const root = await fixture();
    await setup(root);
    if (prepared) await prepare(root);
    const before = await loadTask(root, 'probe');
    const files = await publicFiles(root);
    const draft = before.task.delivery?.draft;
    const draftBytes = draft ? await readFile(join(root, draft.path), 'utf8') : null;
    const corrected = invoke(root, ['update', 'probe', '--stdin'], {
      revision: digest(before.raw),
      reason:
        'This is maintenance; correct the accidental capability declaration before acceptance.',
      plan: { result: null, nextAction: 'Verify the maintenance contract.' },
    });
    expect(corrected.status, corrected.stderr).toBe(0);
    const after = (await loadTask(root, 'probe')).task;
    expect(after.plan.result).toBeNull();
    expect(after.delivery).toBeUndefined();
    expect(after.evidence).toEqual(before.task.evidence);
    if (draft) {
      expect(await readFile(join(root, draft.path), 'utf8')).toBe(draftBytes);
      expect(after.notes.join('\n')).toContain(draft.path);
    }
    expect(
      invoke(root, ['sync', 'probe', 'Inspected the corrected maintenance scope.']).status,
    ).toBe(0);
    const revision = digest((await loadTask(root, 'probe')).raw);
    expect(
      invoke(root, ['update', 'probe', '--stdin'], {
        revision,
        reason: 'Continue the authorized maintenance.',
        stage: 'C1_IMPLEMENTATION',
        plan: { nextAction: 'Implement maintenance.' },
      }).status,
    ).toBe(0);
    await expect(prepare(root)).rejects.toThrow('WORK_DELIVERY_RESULT');
    expect(await publicFiles(root)).toEqual(files);
  },
);

it('does not erase an accepted result by reclassifying it as maintenance', async () => {
  const root = await fixture();
  await setup(root);
  await finish(root);
  const before = await loadTask(root, 'probe');
  const files = await publicFiles(root);
  const result = invoke(root, ['update', 'probe', '--stdin'], {
    revision: digest(before.raw),
    reason: 'Try to remove an already accepted binding.',
    plan: { result: null },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('WORK_DELIVERY_RESULT');
  expect((await loadTask(root, 'probe')).raw).toBe(before.raw);
  expect(await publicFiles(root)).toEqual(files);
});

it.each(['code', 'original', 'draft', 'evidence-binding', 'acceptance'])(
  'withdraws readiness or refuses completion after a changed %s',
  async (changed) => {
    const root = await fixture();
    await setup(root);
    await prepare(root);
    const { task, raw } = await loadTask(root, 'probe');
    const request = await completeRequest(root);
    if (changed === 'code')
      await writeFile(join(root, 'src/value.ts'), 'export const value = 2;\n');
    if (changed === 'original') await writeFile(join(root, task.evidence[0]!.artifact), 'damaged');
    if (changed === 'draft') await writeFile(join(root, task.delivery!.draft!.path), 'damaged');
    if (changed === 'evidence-binding') {
      task.evidence[0]!.environment = 'Different observation';
      await saveTask(root, task, raw);
      request.revision = digest((await loadTask(root, 'probe')).raw);
    }
    if (changed === 'acceptance') request.acceptance.candidate = '0'.repeat(64);
    else
      expect((await assess(root, (await loadTask(root, 'probe')).task)).readyForAcceptance).toBe(
        false,
      );
    await expect(deliver(root, 'probe', json(request))).rejects.toThrow();
    expect((await results(root)).results).toHaveLength(0);
  },
);

it.each(['missing', 'old-version', 'stale-original'])(
  'requires current normative review: %s',
  async (change) => {
    const root = await fixture();
    await setup(root);
    const { task, raw } = await loadTask(root, 'probe');
    if (change === 'missing') delete task.plan.norms;
    else if (change === 'old-version') delete task.plan.norms!.version;
    else
      await writeFile(
        join(root, task.evidence.find((entry) => entry.criterion === 'norms-review')!.artifact),
        'stale',
      );
    if (change !== 'stale-original') {
      await saveTask(root, task, raw);
      await passing(root);
    }
    await expect(prepare(root)).rejects.toThrow(/NORMS|EVIDENCE/);
  },
);

it.each(['missing', 'pending', 'failed'])(
  'requires all current originals before preparation: %s',
  async (change) => {
    const root = await fixture();
    await setup(root);
    const { task, raw } = await loadTask(root, 'probe');
    if (change === 'missing')
      task.evidence = task.evidence.filter((entry) => entry.criterion !== 'checks');
    else
      task.evidence.find((entry) => entry.criterion === 'checks')!.result =
        change === 'failed' ? 'fail' : 'pending';
    await saveTask(root, task, raw);
    await expect(prepare(root)).rejects.toThrow('WORK_DELIVERY_EVIDENCE');
  },
);

it.each([0, 1, 2])(
  'recovers preparation interrupted after %i writes without public output',
  async (cut) => {
    const root = await fixture();
    await setup(root);
    const before = await publicFiles(root);
    const request = await prepareRequest(root);
    await deliver(root, 'probe', json(request));
    expect((await rewind(root, 'probe', cut)).changes).toHaveLength(2);
    const replay = invoke(root, ['deliver', 'probe', '--stdin'], request);
    expect(replay.status, replay.stderr).toBe(0);
    expect(JSON.parse(replay.stdout).readyForAcceptance).toBe(true);
    expect(await publicFiles(root)).toEqual(before);
  },
);

it('prioritizes an unfinished delivery over stale update and ensure conflicts without a recovery deadlock', async () => {
  const root = await fixture();
  const requirement = { source: 'docs/api.md', section: 'API', key: 'probe' };
  const id = `probe-${digest(json([requirement.source, requirement.key])).slice(0, 16)}`;
  await setup(root, id);
  const request = await prepareRequest(root, id);
  await deliver(root, id, json(request));
  await rewind(root, id, 0);
  const stateBefore = (await loadTask(root, id)).raw;
  const stale = invoke(root, ['update', id, '--stdin'], {
    revision: '0'.repeat(64),
    reason: 'This obsolete update must not obstruct journal recovery.',
  });
  expect(stale.stderr).toContain('WORK_DELIVERY_PENDING');
  const ensured = invoke(root, ['ensure', '--stdin'], { requirement });
  expect(ensured.stderr).toContain('WORK_DELIVERY_PENDING');
  await expect(readFile(join(root, `.work/tasks/${id}/conflict.json`))).rejects.toHaveProperty(
    'code',
    'ENOENT',
  );
  expect((await loadTask(root, id)).raw).toBe(stateBefore);
  const replay = invoke(root, ['deliver', id, '--stdin'], request);
  expect(replay.status, replay.stderr).toBe(0);
  expect(JSON.parse(replay.stdout).readyForAcceptance).toBe(true);
});

it.each([0, 1, 2, 3])(
  'recovers completion interrupted after %i writes without duplicate results',
  async (cut) => {
    const root = await fixture();
    await setup(root);
    const request = await finish(root);
    expect((await rewind(root, 'probe', cut)).changes).toHaveLength(3);
    const replay = invoke(root, ['deliver', 'probe', '--stdin'], request);
    expect(replay.status, replay.stderr).toBe(0);
    expect((await results(root)).results).toHaveLength(1);
    expect((await assess(root, (await loadTask(root, 'probe')).task)).ready).toBe(true);
  },
);

it('preserves interfering edits and blocks unrelated state writes during a new unfinished journal', async () => {
  const root = await fixture();
  await setup(root);
  const request = await finish(root);
  await rewind(root, 'probe', 2);
  const manual = (await readFile(join(root, reportPath(prd)), 'utf8')) + '\nHuman note.\n';
  await writeFile(join(root, reportPath(prd)), manual);
  await expect(deliver(root, 'probe', json(request))).rejects.toThrow('WORK_DELIVERY_CONFLICT');
  const current = await loadTask(root, 'probe');
  await expect(saveTask(root, current.task, current.raw)).rejects.toThrow('WORK_DELIVERY_PENDING');
  expect(await readFile(join(root, reportPath(prd)), 'utf8')).toBe(manual);
});

it('does not replay another workspace journal or rewrite completed output edited by a person', async () => {
  const a = await fixture();
  await setup(a);
  const request = await finish(a);
  const b = await fixture();
  await rm(join(b, '.work'), { recursive: true });
  await cp(join(a, '.work'), join(b, '.work'), { recursive: true });
  await expect(deliver(b, 'probe', json(request))).rejects.toThrow(/WORK_(OWNER|MEMBER)/);
  const op = (await loadOperation(a, 'probe'))!.operation!;
  const change = op.changes.find((entry) => entry.path === reportPath(prd))!;
  const manual = change.after! + '\nHuman edit.\n';
  await writeFile(join(a, reportPath(prd)), manual);
  await expect(deliver(a, 'probe', json(request))).rejects.toThrow('completed output changed');
  expect(await readFile(join(a, reportPath(prd)), 'utf8')).toBe(manual);
});

it('completes only its two public result files and preserves the static task entrance', async () => {
  const root = await fixture();
  const entrance = await readFile(join(root, indexPath), 'utf8');
  await setup(root);
  await finish(root);
  const op = (await loadOperation(root, 'probe'))!.operation!;
  expect(
    op.changes.map((change) => change.path).filter((path) => !path.startsWith('.work/')),
  ).toEqual([recordsPath(prd), reportPath(prd)]);
  expect(await readFile(join(root, indexPath), 'utf8')).toBe(entrance);
});

// v5 reading and growth.
it.each(['reopen', 'unknown'])(
  'rejects retired or unknown current journal kind %s',
  async (kind) => {
    const root = await fixture();
    await setup(root);
    await prepare(root);
    const path = join(root, operationPath('probe'));
    const operation = JSON.parse(await readFile(path, 'utf8'));
    operation.kind = kind;
    const bytes = json(operation);
    await writeFile(path, bytes);
    await expect(deliver(root, 'probe', json(await completeRequest(root)))).rejects.toThrow(
      'WORK_DELIVERY_OPERATION',
    );
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect((await results(root)).results).toHaveLength(0);
  },
);

it('rejects old public formats and evidence selectors, while old private references remain readable', async () => {
  const root = await fixture();
  await setup(root);
  await finish(root);
  const book = await results(root);
  for (const version of [1, 2, 3, 4])
    expect(() => parseRecords(json({ ...book, version }))).toThrow('v5');
  for (const suffix of ['#result=probe&criterion=checks', '#result=../probe', '#unknown=probe'])
    await expect(readResultInput(root, recordsPath(prd) + suffix)).rejects.toThrow(
      'WORK_REPORT_SELECTOR',
    );
  const loaded = await loadTask(root, 'probe');
  loaded.task.delivery!.accepted!.path = 'docs/tasks/complete/prd-0123456789abcdef/report.md';
  expect(parseTask(json(loaded.task)).delivery!.accepted!.path).toContain('docs/tasks/complete/');
  await expect(receive(root, loaded.task.delivery!.accepted!.path)).rejects.toThrow('WORK_SOURCE');
});

it.each([false, true])(
  'never replays obsolete journals, done=%s, and replaces them only via fresh preparation',
  async (done) => {
    const root = await fixture();
    await setup(root);
    await prepare(root);
    const old = JSON.parse(await readFile(join(root, operationPath('probe')), 'utf8'));
    old.version = 1;
    old.done = done;
    await writeFile(join(root, operationPath('probe')), json(old));
    const oldBytes = await readFile(join(root, operationPath('probe')), 'utf8');
    await expect(deliver(root, 'probe', json(await completeRequest(root)))).rejects.toThrow(
      'WORK_DELIVERY_OBSOLETE',
    );
    expect(await readFile(join(root, operationPath('probe')), 'utf8')).toBe(oldBytes);
    await prepare(root);
    expect((await loadOperation(root, 'probe'))!.operation!.version).toBe(2);
    const loaded = await loadTask(root, 'probe');
    const legacy = (await readFile(join(root, loaded.task.delivery!.draft!.path), 'utf8')).replace(
      '"version": 5',
      '"version": 2',
    );
    await writeFile(join(root, loaded.task.delivery!.draft!.path), legacy);
    loaded.task.delivery!.draft!.sha256 = digest(legacy);
    await saveTask(root, loaded.task, loaded.raw);
    expect((await assess(root, loaded.task)).readyForAcceptance).toBe(false);
    await expect(deliver(root, 'probe', json(await completeRequest(root)))).rejects.toThrow(
      'WORK_DELIVERY_OBSOLETE',
    );
    await prepare(root);
    await deliver(root, 'probe', json(await completeRequest(root)));
  },
);

it('receives a selected summary with no author records, criteria, authority or inherited passes', async () => {
  const sender = await fixture();
  await setup(sender, 'alpha');
  await finish(sender, 'alpha');
  await setup(sender, 'beta');
  await finish(sender, 'beta');
  const receiver = await fixture();
  await cp(join(sender, 'docs/tasks'), join(receiver, 'docs/tasks'), { recursive: true });
  await writeFile(join(receiver, 'src/value.ts'), 'export const value = 99;\n');
  await expect(receive(receiver, reportPath(prd))).rejects.toThrow('WORK_RESULT_SELECTION');
  const received = await receive(receiver, reportPath(prd), 'alpha');
  expect(received.plan.authorization).toBe('');
  expect(received.plan.scope).toEqual([]);
  expect(received.plan.acceptance).toEqual([]);
  expect(received.checkpoint).toBeNull();
  expect(received.evidence).toEqual([]);
  expect(received.notes.join(' ')).toContain('Entry points: src/value.ts');
  expect(received.notes.join(' ')).not.toContain('Differences among');
  expect((await assess(receiver, received)).ready).toBe(false);
  await expect(receive(receiver, reportPath(prd), 'alpha')).rejects.toThrow();
});

it('keeps exact-code handoff validation separate from public summaries', async () => {
  const sender = await fixture();
  await setup(sender, 'alpha');
  await finish(sender, 'alpha');
  await setup(sender, 'next');
  const loaded = await loadTask(sender, 'next');
  const file = await handoff(sender, loaded.task);
  const receiver = await fixture();
  await cp(join(sender, 'docs/tasks'), join(receiver, 'docs/tasks'), { recursive: true });
  await mkdir(join(receiver, '.work/inbox'), { recursive: true });
  await cp(file, join(receiver, '.work/inbox/task.md'));
  await writeFile(join(receiver, 'src/value.ts'), 'changed\n');
  await expect(receive(receiver, '.work/inbox/task.md')).rejects.toThrow('WORK_HANDOFF_CODE');
  await cp(join(sender, 'src/value.ts'), join(receiver, 'src/value.ts'));
  const received = await receive(receiver, '.work/inbox/task.md');
  expect(received.plan.result).toEqual(loaded.task.plan.result);
  expect(received.plan.authorization).toBe('');
  expect(received.checkpoint).toBeNull();
  expect(received.evidence).toEqual([]);
});

it('binds exact sibling keys, excludes only the current output, and observes physical rewrites', async () => {
  const root = await fixture();
  await setup(root, 'alpha');
  await finish(root, 'alpha');
  await setup(root, 'consumer', null);
  let loaded = await loadTask(root, 'consumer');
  const selector = resultSelector(prd, 'alpha');
  loaded.task.plan.scope = ['src'];
  loaded.task.plan.inputs = [selector];
  await saveTask(root, loaded.task, loaded.raw);
  await passing(root, 'consumer');
  const before = (await loadTask(root, 'consumer')).task.checkpoint!;
  const binding = await readResultInput(root, selector);
  await setup(root, 'beta');
  await finish(root, 'beta');
  expect(await readResultInput(root, selector)).toBe(binding);
  expect((await capture(root, (await loadTask(root, 'consumer')).task)).candidate).toBe(
    before.candidate,
  );
  loaded = await loadTask(root, 'beta');
  expect(Object.keys(loaded.task.checkpoint!.files)).toContain(selector);
  expect(Object.keys(loaded.task.checkpoint!.files)).not.toContain(resultSelector(prd, 'beta'));
  const stamp = await inputStamp(root, before);
  const bytes = await readFile(join(root, recordsPath(prd)), 'utf8');
  await writeFile(join(root, recordsPath(prd)), bytes + '\n');
  await writeFile(join(root, recordsPath(prd)), bytes);
  expect(await inputStamp(root, before)).not.toBe(stamp);
  const book = await results(root);
  book.results.find((entry) => entry.key === 'alpha')!.limitations = 'Changed dependency.';
  await rewriteBook(root, book);
  expect((await capture(root, (await loadTask(root, 'consumer')).task)).candidate).not.toBe(
    before.candidate,
  );
  expect((await capture(root, loaded.task)).candidate).not.toBe(loaded.task.checkpoint!.candidate);
  const consumer = (await loadTask(root, 'consumer')).task;
  await rm(join(root, recordsPath(prd)));
  await expect(capture(root, consumer)).rejects.toThrow();
  const outside = join(root, '.work/records.json');
  await writeFile(outside, bytes);
  await symlink(outside, join(root, recordsPath(prd)));
  await expect(capture(root, consumer)).rejects.toThrow(/SYMLINK/);
});

it('recovers with a real sibling input and refuses an interfering sibling edit', async () => {
  const root = await fixture();
  await setup(root, 'alpha');
  await finish(root, 'alpha');
  await setup(root, 'beta');
  const request = await finish(root, 'beta');
  const op = await rewind(root, 'beta', 1);
  const change = op.changes.find((entry) => entry.path === recordsPath(prd))!;
  const book = parseRecords(change.after!);
  book.results.find((entry) => entry.key === 'alpha')!.outcomes = 'Interfering sibling edit';
  const manual = json(book);
  await writeFile(join(root, recordsPath(prd)), manual);
  await expect(deliver(root, 'beta', json(request))).rejects.toThrow();
  expect(await readFile(join(root, recordsPath(prd)), 'utf8')).toBe(manual);
  await writeFile(join(root, recordsPath(prd)), change.after!);
  await deliver(root, 'beta', json(request));
  expect((await results(root)).results).toHaveLength(2);
});

it('rejects missing, corrupt, cross-PRD and orphaned public data without author originals', async () => {
  const root = await fixture();
  await setup(root);
  await finish(root);
  for (const path of [reportPath(prd), recordsPath(prd)]) {
    const original = await readFile(join(root, path), 'utf8');
    await writeFile(join(root, path), original + '\nManual content.\n');
    await expect(results(root)).rejects.toThrow();
    await writeFile(join(root, path), original);
    await rm(join(root, path));
    await expect(results(root)).rejects.toThrow();
    await writeFile(join(root, path), original);
  }
  const book = await results(root);
  const bytes = await readFile(join(root, recordsPath(prd)), 'utf8');
  await writeFile(join(root, recordsPath(prd)), json({ ...book, prd: otherPrd }));
  await expect(readResultInput(root, resultSelector(prd, 'probe'))).rejects.toThrow(
    'WORK_REPORT_BINDING',
  );
  await writeFile(join(root, recordsPath(prd)), bytes);
  const report = await readFile(join(root, reportPath(prd)), 'utf8');
  await rm(join(root, recordsPath(prd)));
  await rm(join(root, reportPath(prd)));
  expect((await results(root)).results).toEqual([]);
  expect(invoke(root, ['read-result', prd, 'probe']).status).toBe(1);
  await expect(readResultInput(root, resultSelector(prd, 'probe'))).rejects.toThrow(
    'WORK_INPUT_MISSING',
  );
  await expect(receive(root, reportPath(prd), 'probe')).rejects.toThrow();
  await writeFile(join(root, recordsPath(prd)), bytes);
  await writeFile(join(root, reportPath(prd)), report);
  await rm(join(root, '.work'), { recursive: true });
  const files = (await inventory(root, await loadConfig(root))).files;
  expect(await checkReports(root, files)).toEqual([]);
  const orphan = 'docs/tasks/product/complete/extra.md';
  await writeFile(join(root, orphan), '# Orphan\n');
  expect(await checkReports(root, [...files, orphan])).toEqual([`WORK_REPORT_ORPHAN: ${orphan}`]);
});

it.each(['src/missing.ts', '.work/private.md', 'src/../package.json', 'docs/api.md#part'])(
  'rejects invalid logic locations before writing a draft: %s',
  async (path) => {
    const root = await fixture();
    await setup(root);
    const before = await publicFiles(root);
    await expect(
      deliver(
        root,
        'probe',
        json({ ...(await prepareRequest(root)), locations: [{ path, purpose: 'Invalid entry' }] }),
      ),
    ).rejects.toThrow();
    expect(await publicFiles(root)).toEqual(before);
  },
);

it('resolves immutable PRD identities through their registered directory and rechecks ownership', async () => {
  const root = await fixture();
  const identity = 'docs/old-prd.md';
  const documents = [
    { identity, kind: 'prd' as const, path: prd, aliases: [identity] },
    { identity: otherPrd, kind: 'prd' as const, path: otherPrd },
  ];
  await writeFile(join(root, identity), '# 资料已迁移\n\n[当前资料](tasks/product/prd.md)\n');
  await writeTaskDocuments(root, documents);
  await setup(root, 'probe', 'probe', identity);
  await finish(root);
  expect((await results(root, identity)).prd).toBe(identity);
  expect(await results(root, prd)).toEqual(await results(root, identity));
  expect(invoke(root, ['read-result', prd]).status).toBe(0);
  await writeTaskDocuments(root, [{ ...documents[0]!, kind: 'design' }, documents[1]!]);
  await expect(prepare(root)).rejects.toThrow(/TASK_DOCUMENT_OWNER|WORK_RESULT/);
});

it('stores each PRD in its own directory without empty pending or evidence files', async () => {
  const root = await fixture();
  await setup(root, 'one');
  await finish(root, 'one');
  await setup(root, 'two', 'two', otherPrd);
  await finish(root, 'two');
  expect((await results(root)).results).toHaveLength(1);
  expect((await results(root, otherPrd)).results).toHaveLength(1);
  const paths = Object.keys(await publicFiles(root));
  expect(paths.filter((path) => path.includes('/complete/'))).toEqual(
    expect.arrayContaining([
      recordsPath(prd),
      reportPath(prd),
      recordsPath(otherPrd),
      reportPath(otherPrd),
    ]),
  );
  expect(paths.some((path) => path.includes('/pending/') || path.includes('/evidence/'))).toBe(
    false,
  );
});

it('isolates narrow candidates from unrelated PRDs and unread prose while binding real dependencies', async () => {
  const root = await fixture();
  await setup(root, 'one', 'one', prd, [], ['src/value.ts']);
  const task = (await loadTask(root, 'one')).task;
  const before = await capture(root, task);
  await writeFile(join(root, otherPrd), '# Unrelated updated PRD\n');
  expect((await capture(root, task)).candidate).toBe(before.candidate);
  const added = 'docs/tasks/new-product/prd.md';
  await mkdir(dirname(join(root, added)), { recursive: true });
  await writeFile(join(root, added), '# New unrelated PRD\n');
  const documents = [prd, otherPrd, added].map((path) => ({
    identity: path,
    kind: 'prd' as const,
    path,
  }));
  await writeTaskDocuments(root, documents);
  expect((await capture(root, task)).candidate).toBe(before.candidate);

  const proposal = 'docs/tasks/product/pending/option.md';
  await mkdir(dirname(join(root, proposal)), { recursive: true });
  await writeFile(join(root, proposal), '# Unread proposal\n');
  await writeTaskDocuments(root, [
    ...documents,
    { identity: proposal, kind: 'proposal', path: proposal },
  ]);
  const registered = await capture(root, task);
  expect(registered.candidate).not.toBe(before.candidate);
  expect(registered.files[proposal]).toBeUndefined();
  await writeFile(join(root, proposal), '# Revised unread proposal\n');
  expect((await capture(root, task)).candidate).toBe(registered.candidate);
  const explicit = structuredClone(task);
  explicit.plan.sources.push(proposal);
  const explicitBefore = await capture(root, explicit);
  await writeFile(join(root, proposal), '# Explicit proposal changed\n');
  expect((await capture(root, explicit)).candidate).not.toBe(explicitBefore.candidate);

  const broad = structuredClone(task);
  broad.plan.scope = ['docs'];
  const broadBefore = await capture(root, broad);
  await writeFile(join(root, otherPrd), '# Another unrelated revision\n');
  expect((await capture(root, broad)).candidate).not.toBe(broadBefore.candidate);
  expect((await capture(root, task)).candidate).toBe(registered.candidate);
  for (const path of ['docs/api.md', 'docs/coordination.md', 'harness.config.json']) {
    const original = await readFile(join(root, path), 'utf8');
    await writeFile(join(root, path), original + '\n');
    expect((await capture(root, task)).candidate).not.toBe(registered.candidate);
    await writeFile(join(root, path), original);
  }
});

it('completes new and existing keys in different PRDs with disjoint public writes', async () => {
  const root = await fixture();
  await setup(root, 'one', 'one', prd, [], ['src/value.ts']);
  await setup(root, 'two', 'two', otherPrd, [], ['src/value.ts']);
  const one = (await loadTask(root, 'one')).task;
  const candidate = one.checkpoint!.candidate;
  await finish(root, 'two');
  expect((await capture(root, one)).candidate).toBe(candidate);
  await finish(root, 'one');
  await setup(root, 'two-update', 'two', otherPrd, [], ['src/value.ts']);
  await finish(root, 'two-update');
  expect((await capture(root, one)).candidate).toBe(candidate);
  const writes = async (id: string) =>
    (await loadOperation(root, id))!
      .operation!.changes.map((change) => change.path)
      .filter((path) => path.startsWith('docs/'));
  const left = await writes('one');
  const right = await writes('two-update');
  expect(left).toEqual([recordsPath(prd), reportPath(prd)]);
  expect(right).toEqual([recordsPath(otherPrd), reportPath(otherPrd)]);
  expect(left.filter((path) => right.includes(path))).toEqual([]);
  expect((await results(root, otherPrd)).results).toHaveLength(1);
});

it.each([false, true])(
  'retains old global-index journals without replaying them (done=%s)',
  async (done) => {
    const root = await fixture();
    await setup(root);
    const request = await finish(root);
    const path = join(root, operationPath('probe'));
    const operation = JSON.parse(await readFile(path, 'utf8'));
    const entrance = await readFile(join(root, indexPath), 'utf8');
    operation.done = done;
    operation.changes.splice(2, 0, {
      path: indexPath,
      before: entrance,
      after: '# Obsolete index\n',
    });
    const original = json(operation);
    await writeFile(path, original);
    expect(invoke(root, ['context', 'probe', 'resume']).status).toBe(0);
    await expect(deliver(root, 'probe', json(request))).rejects.toThrow('WORK_DELIVERY_OBSOLETE');
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(await readFile(join(root, indexPath), 'utf8')).toBe(entrance);
    if (done) expect((await loadOperation(root, 'probe'))!.operation).toBeNull();
    else await expect(loadOperation(root, 'probe')).rejects.toThrow('original tool version');
  },
);

it('keeps twenty PRDs linear in public bytes with all docs in scope and many private criteria', async () => {
  const prds = Array.from(
    { length: 20 },
    (_, i) => `docs/tasks/product-${String(i).padStart(2, '0')}/prd.md`,
  );
  const root = await fixture(prds);
  const sizes: number[][] = [];
  for (const [i, source] of prds.entries()) {
    const entries: number[] = [];
    for (const key of ['alpha', 'bravo', 'delta']) {
      const id = `product-${i}-${key}`;
      await setup(root, id, key, source, ['four', 'five']);
      expect((await loadTask(root, id)).task.plan.scope).toContain('docs');
      await finish(root, id);
      const bytes = await readFile(join(root, recordsPath(source)), 'utf8');
      const book = parseRecords(bytes);
      expect(bytes).not.toMatch(
        /"files"|"contract"|"head"|"artifacts"|"criteria"|Observed fixture|\.work\//,
      );
      expect(book.results.every((result) => Object.keys(result).length === 7)).toBe(true);
      entries.push(
        Buffer.byteLength(bytes) +
          Buffer.byteLength(await readFile(join(root, reportPath(source)), 'utf8')),
      );
    }
    sizes.push(entries);
  }
  // Equal-length inputs have equal marginal cost, independent of all earlier PRDs.
  for (const size of sizes) {
    expect(size).toEqual(sizes[0]);
    expect(size[2]! - size[1]!).toBe(size[1]! - size[0]!);
  }
  const files = (await inventory(root, await loadConfig(root))).files;
  const packages = files.filter((path) => path.includes('/complete/'));
  expect(packages).toHaveLength(40);
  expect(packages.filter((path) => path.endsWith('/records.json'))).toHaveLength(20);
  await rm(join(root, '.work'), { recursive: true });
  expect(await checkReports(root, files)).toEqual([]);
}, 60_000);

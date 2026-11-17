import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { taskDocumentFiles } from './fixtures/task-documents-fixture.ts';
import { reviewFixture, reviewMarkdown } from './fixtures/quality-review-fixture.ts';
import { assess } from '../../scripts/harness/work/context.ts';
import { needsQualityReview } from '../../scripts/harness/work/quality-review.ts';
import { normsIssues } from '../../scripts/harness/work/norms-review.ts';
import { loadConfig } from '../../scripts/harness/inventory.ts';
import {
  contractPlan,
  digest,
  json,
  loadTask,
  taskRevision,
} from '../../scripts/harness/work/records.ts';
import type { Candidate, Task } from '../../scripts/harness/work/records.ts';
import { renderBook } from '../../scripts/harness/work/reports.ts';
import { recordsPath } from '../../scripts/harness/work/compact-store.ts';

const project = resolve('.');
const prd = 'docs/tasks/quality/prd.md';
const design = 'docs/tasks/quality/design.md';
const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function put(root: string, path: string, value: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), value);
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

function cli(root: string, args: string[], input?: unknown) {
  const result = spawnSync(
    process.execPath,
    [join(project, 'scripts/harness/work/cli.ts'), ...args],
    {
      cwd: root,
      encoding: 'utf8',
      input: input === undefined ? undefined : JSON.stringify(input),
      timeout: 10000,
    },
  );
  return { status: result.status, output: `${result.stdout}\n${result.stderr}`.trim() };
}

const oldResult = {
  key: 'prior',
  title: 'Prior accepted result',
  outcomes: 'Historical capability.',
  locations: [{ path: 'src/value.ts', purpose: 'Prior implementation.' }],
  verification: 'Historical fixture verification.',
  limitations: 'Historical only.',
  acceptance: {
    candidate: 'a'.repeat(64),
    statement: 'Accepted previously.',
    reference: 'Fixture prior acceptance.',
  },
};

async function fixture(scope = ['src'], development = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mio-quality-')));
  scratch.push(root);
  for (const file of [
    'harness.config.json',
    'docs/coordination.md',
    'docs/work-records.md',
    'docs/engineering/testing.md',
  ]) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await cp(join(project, file), join(root, file));
  }
  const book = { version: 5 as const, prd, results: [oldResult] };
  const files: Record<string, string> = {
    'package.json': '{"type":"module"}\n',
    '.gitignore': '.work/\n',
    'AGENTS.md': '# Fixture rules\n',
    'docs/api.md': '# API\n',
    [prd]: '# Quality fixture requirement\n',
    [design]: '# Fixture design\n',
    'src/value.ts': 'export const value = 1;\n',
    [recordsPath(prd)]: json(book),
    'docs/tasks/quality/complete/report.md': renderBook(book, prd),
    ...taskDocumentFiles([
      { identity: prd, kind: 'prd', path: prd },
      { identity: design, kind: 'design', path: design },
    ]),
  };
  for (const [path, value] of Object.entries(files)) await put(root, path, value);
  git(root, 'init', '-q', '-b', 'main');
  commit(root);
  const request = {
    requirement: { source: 'docs/api.md', section: 'API', key: 'quality' },
    plan: {
      goal: 'Change a fixture capability.',
      result: development ? { prd, key: 'fixture-capability' } : null,
      norms: { paths: ['docs/api.md'], reason: 'The fixture API needs review.' },
      scope,
      inputs: ['src'],
      sources: [design],
      authorization: 'Fixture user authorizes local changes and checks.',
      acceptance: [
        {
          id: 'checks',
          method: 'automated',
          criterion: 'Fixture check succeeds.',
          command: [process.execPath, '-e', 'console.log(1)'],
        },
      ],
      nextAction: 'Collect fixture checks and reviews.',
      stopCondition: 'Return for human acceptance.',
    },
  };
  const created = cli(root, ['ensure', '--stdin'], request);
  expect(created.status, created.output).toBe(0);
  const id = JSON.parse(created.output).task.id as string;
  const update = cli(root, ['update', id, '--stdin'], {
    revision: JSON.parse(created.output).revision,
    reason: 'Enter verification for the fixture.',
    stage: 'C1_EVIDENCE_PENDING',
    plan: { nextAction: 'Collect fixture checks and reviews.' },
  });
  expect(update.status, update.output).toBe(0);
  const sync = cli(root, ['sync', id, 'Inspected the committed fixture.']);
  expect(sync.status, sync.output).toBe(0);
  const state = async () => (await loadTask(root, id)).task;
  const revision = async () => taskRevision(await state());
  const context = async () => assess(root, await state());
  return { root, id, state, revision, context, request };
}

async function draftText(root: string, id: string, kind: string) {
  let args = ['read', id, kind];
  let output = '';
  for (;;) {
    const result = cli(root, args);
    expect(result.status, result.output).toBe(0);
    const page = JSON.parse(result.output);
    output += page.text;
    if (!page.page.next) return output;
    args = page.page.next.argv;
  }
}

function metadata<T>(source: string, language: string): T {
  const start = source.split(`\`\`\`${language}\n`)[1];
  if (!start) throw new Error('Fixture metadata missing');
  return JSON.parse(start.split('```')[0]!);
}

function normsMarkdown(value: unknown) {
  return `# Norms\n\n\`\`\`mio-norms-review\n${json(value)}\`\`\`\n`;
}

function candidate(task: Task): Candidate {
  const value = task.checkpoint?.candidate;
  if (!value || typeof value === 'string') throw new Error('Expected committed candidate');
  return value;
}

async function submit(root: string, id: string, criterion: string, name: string, content: string) {
  const path = `.work/tasks/${id}/evidence/${name}.md`;
  await put(root, path, content);
  return { path, ...cli(root, ['evidence', id, criterion, path, 'Fixture observations.']) };
}

async function completeNorms(f: Awaited<ReturnType<typeof fixture>>) {
  const raw = await draftText(f.root, f.id, 'norms-draft');
  const report = metadata<{
    candidate: Candidate;
    reviewer: string;
    reason: string;
    requirements: {
      result: string;
      assessment: string;
      documents: { path: string; assessment: string }[];
    };
    documents: { path: string; result: string; assessment: string }[];
    accepted: {
      result: string;
      assessment: string;
      results: { prd: string; key: string; candidate: string; assessment: string }[];
    };
    remaining: string;
    conclusion: { result: string; evidence: string };
    limitations: string;
  }>(raw, 'mio-norms-review');
  report.reviewer = 'Fixture reviewer';
  report.requirements.result = 'pass';
  report.requirements.assessment = 'Requirement and design reviewed.';
  for (const page of report.requirements.documents) page.assessment = 'Observed current source.';
  for (const page of report.documents) {
    page.result = 'pass';
    page.assessment = 'Observed current norm.';
  }
  report.accepted = {
    result: 'pass',
    assessment: 'Compared the historical accepted capability.',
    results: [
      {
        prd,
        key: oldResult.key,
        candidate: oldResult.acceptance.candidate,
        assessment: 'Reviewed as historical.',
      },
    ],
  };
  report.remaining = 'No unresolved fixture decision.';
  report.conclusion = { result: 'pass', evidence: 'All three relationships were reviewed.' };
  report.limitations = 'Synthetic fixture only.';
  return report;
}

async function prepare(f: Awaited<ReturnType<typeof fixture>>) {
  return cli(f.root, ['deliver', f.id, '--stdin'], {
    action: 'prepare',
    revision: await f.revision(),
    title: 'Fixture result',
    locations: [{ path: 'src/value.ts', purpose: 'Fixture constant.' }],
    outcomes: 'Fixture implementation is ready.',
    verification: 'Fixture checks and review originals.',
    limitations: 'Fixture only.',
  });
}

it('registers quality review for source scope, including planned sources and ancestor directories', async () => {
  const config = await loadConfig(project);
  const f = await fixture();
  const plan = (await f.state()).plan;
  for (const path of ['src', 'scripts/harness', 'scripts/service', 'tests', '.', 'src/planned.ts'])
    expect(needsQualityReview({ ...plan, scope: [path] }, config)).toBe(true);
  expect(needsQualityReview({ ...plan, scope: ['docs/api.md'] }, config)).toBe(false);
  expect(plan.acceptance).toContainEqual(
    expect.objectContaining({ id: 'quality-review', method: 'review' }),
  );
  expect((await f.context()).qualityReview).toMatchObject({ required: true, result: 'pending' });
});

it('does not register a source review for a document-only scope, then registers it on scope expansion', async () => {
  const f = await fixture(['docs/api.md']);
  expect((await f.context()).qualityReview).toMatchObject({
    required: false,
    result: 'not_required',
  });
  const result = cli(f.root, ['update', f.id, '--stdin'], {
    revision: await f.revision(),
    reason: 'Fixture user adds source implementation.',
    plan: { scope: ['src', 'docs/api.md'] },
  });
  expect(result.status, result.output).toBe(0);
  expect((await f.state()).plan.acceptance).toContainEqual(
    expect.objectContaining({ id: 'quality-review', method: 'review' }),
  );
  expect((await f.context()).qualityReview.required).toBe(true);
  expect((await f.context()).candidate).toBeNull();
});

it('rejects missing or wrong-method mandatory review criteria without silently repairing old state', async () => {
  const f = await fixture();
  const task = await f.state();
  task.plan.acceptance = task.plan.acceptance.filter(
    (entry) => !['quality-review', 'norms-review'].includes(entry.id),
  );
  const path = `.work/tasks/${f.id}/state.json`;
  await put(f.root, path, json(task));
  const original = await readFile(join(f.root, path), 'utf8');
  const assessment = await f.context();
  expect(assessment.errors.join()).toContain('WORK_QUALITY_CONTRACT');
  expect(assessment.normsReview.issues.join()).toContain('WORK_NORMS_CONTRACT');
  expect(cli(f.root, ['ensure', '--stdin'], { requirement: f.request.requirement }).status).toBe(0);
  expect(await readFile(join(f.root, path), 'utf8')).toBe(original);
  const invalid = cli(f.root, ['update', f.id, '--stdin'], {
    revision: await f.revision(),
    reason: 'The fixture tries an automated quality criterion.',
    plan: {
      acceptance: [{ id: 'quality-review', method: 'automated', criterion: 'Not a review.' }],
    },
  });
  expect(invalid.output).toContain('WORK_QUALITY_CONTRACT');
  expect(await readFile(join(f.root, path), 'utf8')).toBe(original);
  const repaired = cli(f.root, ['update', f.id, '--stdin'], {
    revision: await f.revision(),
    reason: 'Explicitly register the required review criteria.',
  });
  expect(repaired.status, repaired.output).toBe(0);
  expect((await f.state()).plan.acceptance).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'quality-review', method: 'review' }),
      expect.objectContaining({ id: 'norms-review', method: 'review' }),
    ]),
  );
});

it('requires three observed quality dimensions and binds originals to the clean committed candidate', async () => {
  const f = await fixture();
  const check = cli(f.root, ['run', f.id, 'checks']);
  expect(check.status, check.output).toBe(0);
  const task = await f.state();
  const current = candidate(task);
  const pending = metadata<ReturnType<typeof reviewFixture>>(
    await draftText(f.root, f.id, 'quality-draft'),
    'mio-quality-review',
  );
  expect(pending.candidate).toEqual(current);
  for (const dimension of ['algorithm', 'unused', 'reuse'] as const)
    expect(pending.dimensions[dimension]).toMatchObject({ result: 'pending', evidence: '' });
  expect((await prepare(f)).output).toContain('WORK_DELIVERY_EVIDENCE');

  const malformed = { ...reviewFixture(current), contract: contractPlan(task) };
  const missingDimension = {
    ...malformed,
    dimensions: { algorithm: malformed.dimensions.algorithm },
  };
  expect(
    (
      await submit(
        f.root,
        f.id,
        'quality-review',
        'missing-dimension',
        reviewMarkdown(missingDimension),
      )
    ).status,
  ).toBe(1);
  for (const [index, result] of ['fail', 'pending'].entries()) {
    const report = { ...reviewFixture(current), contract: contractPlan(task) };
    report.dimensions.unused = { result, evidence: 'Fixture issue or missing consumer evidence.' };
    expect(
      (await submit(f.root, f.id, 'quality-review', `quality-${index}`, reviewMarkdown(report)))
        .status,
    ).toBe(0);
    expect((await f.context()).qualityReview.result).toBe(result);
    expect((await prepare(f)).output).toContain('WORK_DELIVERY_EVIDENCE');
  }
  const acceptedReview = reviewMarkdown({
    ...reviewFixture(current),
    contract: contractPlan(task),
  });
  const valid = await submit(f.root, f.id, 'quality-review', 'quality-pass', acceptedReview);
  expect(valid.status, valid.output).toBe(0);
  expect((await f.context()).qualityReview.result).toBe('pass');
  const norms = await completeNorms(f);
  const norm = await submit(f.root, f.id, 'norms-review', 'norms-pass', normsMarkdown(norms));
  expect(norm.status, norm.output).toBe(0);
  const prepared = await prepare(f);
  expect(prepared.status, prepared.output).toBe(0);
  expect((await f.state()).reviewDecision).toBe('PENDING');

  await put(f.root, 'src/value.ts', 'export const value = 2;\n');
  commit(f.root);
  const synced = cli(f.root, ['sync', f.id, 'Inspected the changed committed source.']);
  expect(synced.status, synced.output).toBe(0);
  expect((await f.context()).qualityReview.result).toBe('pending');
  expect(
    cli(f.root, ['evidence', f.id, 'quality-review', valid.path, 'Old review.']).output,
  ).toContain('review candidate mismatch');
  expect(await readFile(join(f.root, valid.path), 'utf8')).toBe(acceptedReview);
}, 30000);

it('revalidates quality originals instead of trusting a forged pass label', async () => {
  const f = await fixture();
  const task = await f.state();
  const report = { ...reviewFixture(candidate(task)), contract: contractPlan(task) };
  report.dimensions.algorithm.result = 'fail';
  const path = `.work/tasks/${f.id}/evidence/forged.md`;
  const bytes = reviewMarkdown(report);
  await put(f.root, path, bytes);
  task.evidence.push({
    criterion: 'quality-review',
    method: 'review',
    result: 'pass',
    candidate: candidate(task),
    artifact: path,
    sha256: digest(bytes),
    summary: 'Forged pass.',
    environment: 'fixture',
  });
  await put(f.root, `.work/tasks/${f.id}/state.json`, json(task));
  expect((await f.context()).qualityReview.result).toBe('invalid');
  expect((await prepare(f)).output).toContain('WORK_DELIVERY_EVIDENCE');
});

it('requires all three-way observations, current pages and a matching candidate', async () => {
  const f = await fixture();
  expect((await f.state()).plan.norms?.version).toBeUndefined();
  const draft = metadata<ReturnType<typeof completeNorms> extends Promise<infer T> ? T : never>(
    await draftText(f.root, f.id, 'norms-draft'),
    'mio-norms-review',
  );
  expect(draft.candidate).toEqual(candidate(await f.state()));
  expect(draft.requirements.documents.map((item) => item.path)).toEqual([
    'docs/api.md',
    prd,
    design,
  ]);
  expect(draft.documents).toEqual([{ path: 'docs/api.md', result: 'pending', assessment: '' }]);
  expect([draft.requirements.result, draft.accepted.result, draft.conclusion.result]).toEqual([
    'pending',
    'pending',
    'pending',
  ]);
  expect(
    (await submit(f.root, f.id, 'norms-review', 'unfinished', normsMarkdown(draft))).status,
  ).toBe(1);

  const report = await completeNorms(f);
  const invalid = [
    { ...report, requirements: undefined },
    { ...report, accepted: undefined },
    { ...report, remaining: '' },
    { ...report, requirements: { ...report.requirements, documents: [] } },
    { ...report, documents: [{ ...report.documents[0], path: 'docs/unrelated.md' }] },
    {
      ...report,
      candidate: { ...report.candidate, contractRevision: report.candidate.contractRevision + 1 },
    },
    { ...report, requirements: { ...report.requirements, result: 'pending' } },
    { ...report, accepted: { ...report.accepted, result: 'fail' } },
    { ...report, documents: [{ ...report.documents[0], result: 'pending' }] },
    {
      ...report,
      accepted: {
        ...report.accepted,
        results: [{ prd, key: 'prior', candidate: null, assessment: 'Invalid.' }],
      },
    },
  ];
  for (const [index, value] of invalid.entries())
    expect(
      (await submit(f.root, f.id, 'norms-review', `invalid-${index}`, normsMarkdown(value))).status,
    ).toBe(1);

  const pending = {
    ...report,
    requirements: { ...report.requirements, result: 'pending' },
    conclusion: { result: 'pending', evidence: 'Not all requirements observed.' },
  };
  expect(
    (await submit(f.root, f.id, 'norms-review', 'pending', normsMarkdown(pending))).status,
  ).toBe(0);
  expect((await f.context()).normsReview.result).toBe('pending');
  const failed = {
    ...report,
    accepted: { ...report.accepted, result: 'fail' },
    conclusion: { result: 'fail', evidence: 'Conflict with accepted result.' },
  };
  expect((await submit(f.root, f.id, 'norms-review', 'failed', normsMarkdown(failed))).status).toBe(
    0,
  );
  expect((await f.context()).normsReview.result).toBe('fail');
  const passed = normsMarkdown(report);
  const result = await submit(f.root, f.id, 'norms-review', 'passed', passed);
  expect(result.status, result.output).toBe(0);
  expect((await f.context()).normsReview.result).toBe('pass');

  await put(f.root, 'docs/api.md', '# API\n\nUpdated fixture norm.\n');
  commit(f.root);
  expect(cli(f.root, ['sync', f.id, 'Inspected changed normative page.']).status).toBe(0);
  expect((await f.context()).normsReview.result).toBe('pending');
  expect(
    cli(f.root, ['evidence', f.id, 'norms-review', result.path, 'Old review.']).output,
  ).toContain('candidate or declaration mismatch');
  expect(await readFile(join(f.root, result.path), 'utf8')).toBe(passed);
}, 30000);

it('treats a historical norms label as metadata and still requires all three observations', async () => {
  const f = await fixture();
  const before = await f.state();
  const changed = cli(f.root, ['update', f.id, '--stdin'], {
    revision: await f.revision(),
    reason: 'Retain the historical label without changing the norm.',
    plan: { norms: { ...before.plan.norms, version: 1 } },
  });
  expect(changed.status, changed.output).toBe(0);
  const current = await f.state();
  expect(current.plan.norms?.version).toBe(1);
  expect(current.contractRevision).toBe(before.contractRevision);
  const report = await completeNorms(f);
  expect(
    (
      await submit(
        f.root,
        f.id,
        'norms-review',
        'legacy-incomplete',
        normsMarkdown({ ...report, requirements: undefined }),
      )
    ).status,
  ).toBe(1);
  expect(
    (await submit(f.root, f.id, 'norms-review', 'legacy-complete', normsMarkdown(report))).status,
  ).toBe(0);
});

it('allows only current normative pages and an explicitly justified empty set', async () => {
  const f = await fixture(['docs/api.md']);
  const plan = (await f.state()).plan;
  for (const path of [prd, design, 'docs/tasks/index.md'])
    expect(
      (
        await normsIssues(f.root, {
          ...plan,
          norms: { paths: [path], reason: 'Invalid fixture page.' },
        })
      ).join(),
    ).toContain('WORK_NORMS_PATH');
  expect(
    await normsIssues(f.root, {
      ...plan,
      norms: { paths: ['docs/api.md'], reason: 'Current norm.' },
    }),
  ).toEqual([]);
  expect(
    await normsIssues(f.root, { ...plan, norms: { paths: [], reason: 'No normative impact.' } }),
  ).toEqual([]);
});

it('cannot certify a Git-ignored norm that is absent from the candidate commit', async () => {
  const f = await fixture(['docs/api.md']);
  await put(f.root, '.gitignore', '.work/\ndocs/local-norm.md\n');
  commit(f.root);
  await put(f.root, 'docs/local-norm.md', '# Ignored local norm\n');
  expect(git(f.root, 'status', '--porcelain')).toBe('');
  const changed = cli(f.root, ['update', f.id, '--stdin'], {
    revision: await f.revision(),
    reason: 'The fixture declares the local norm.',
    plan: { norms: { paths: ['docs/local-norm.md'], reason: 'Review this norm.' } },
  });
  expect(changed.status, changed.output).toBe(0);
  const synced = cli(f.root, ['sync', f.id, 'Attempt to reconcile the declared norm.']);
  expect(synced.status).toBe(1);
  expect(synced.output).toContain('WORK_INPUT_UNCOMMITTED');
});

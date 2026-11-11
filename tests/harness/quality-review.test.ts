import type { TaskDocument } from '../../scripts/harness/inventory.ts';
import { writeTaskDocuments } from './fixtures/task-documents-fixture.ts';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { digest } from '../../scripts/harness/work/records.ts';
import { capture } from '../../scripts/harness/work/context.ts';
import type { Task } from '../../scripts/harness/work/records.ts';
import { reviewFixture, reviewMarkdown } from './fixtures/quality-review-fixture.ts';
import { normsIssues } from '../../scripts/harness/work/norms-review.ts';

const project = resolve('.');
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function cli(root: string, args: string[], input?: unknown) {
  const result = spawnSync(
    process.execPath,
    [join(project, 'scripts/harness/work/cli.ts'), ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
      input: input === undefined ? undefined : JSON.stringify(input),
      timeout: 10000,
    },
  );
  return { status: result.status, output: `${result.stdout}\n${result.stderr}`.trim() };
}

async function fixture(scope = ['src'], development = true) {
  const root = await mkdtemp(join(tmpdir(), 'mio-quality-'));
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
  // Development results belong to this fixture's registered PRD directory.
  const documents: TaskDocument[] = [
    { identity: 'docs/tasks/quality/prd.md', kind: 'prd', path: 'docs/tasks/quality/prd.md' },
  ];
  await writeTaskDocuments(root, documents);
  for (const [file, value] of Object.entries({
    'package.json': '{"type":"module"}',
    'AGENTS.md': '# Fixture rules',
    'docs/api.md': '# API',
    'docs/tasks/quality/prd.md': '# Quality fixture requirement',
    'src/value.ts': 'export const value = 1;',
  })) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), value);
  }
  const request = {
    requirement: { source: 'docs/api.md', section: 'API', key: 'quality' },
    plan: {
      goal: 'Change a fixture capability.',
      ...(development
        ? { result: { prd: 'docs/tasks/quality/prd.md', key: 'fixture-capability' } }
        : { result: null }),
      norms: { paths: [], reason: 'Fixture constant changes no public normative behavior.' },
      scope,
      inputs: ['src'],
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
  const verification = cli(root, ['update', id, '--stdin'], {
    revision: JSON.parse(created.output).revision,
    reason: 'Verify the existing fixture candidate and its review protocol.',
    stage: 'C1_EVIDENCE_PENDING',
    plan: { nextAction: 'Collect fixture checks and reviews.' },
  });
  expect(verification.status, verification.output).toBe(0);
  const path = join(root, `.work/tasks/${id}/state.json`);
  const state = async (): Promise<Task> => JSON.parse(await readFile(path, 'utf8'));
  const context = () => JSON.parse(cli(root, ['context', id, 'verify']).output);
  return { root, id, path, state, context, request };
}

function normsFixture(
  task: Task,
  sources = ['docs/api.md', ...(task.plan.result ? [task.plan.result.prd] : [])],
) {
  return {
    version: 2,
    candidate: task.checkpoint!.candidate,
    reviewer: 'fixture reviewer',
    reason: task.plan.norms!.reason,
    requirements: {
      result: 'pass',
      assessment: 'Synthetic requirement observation; the fixture has no separate adopted design.',
      documents: sources.map((path) => ({
        path,
        sha256: task.checkpoint!.files[path],
        assessment: 'Fixture requirement and source were inspected.',
      })),
    },
    documents: task.plan.norms!.paths.map((path) => ({
      path,
      sha256: task.checkpoint!.files[path],
      result: 'pass',
      assessment: 'Synthetic normative observation.',
    })),
    accepted: {
      result: 'pass',
      assessment:
        'Fixture has no related accepted result; this observation does not certify real acceptance.',
      results: [] as { prd: string; key: string; candidate: string; assessment: string }[],
    },
    remaining: 'No remaining fixture decisions; verification and real acceptance are separate.',
    conclusion: { result: 'pass', evidence: 'Synthetic protocol observation only.' },
    limitations: 'Fixture only; no claim of real semantic review.',
  };
}

const normsMarkdown = (value: unknown) =>
  `\`\`\`mio-norms-review\n${JSON.stringify(value)}\n\`\`\`\n`;

it.each(['src', 'scripts/harness', 'scripts/service', 'tests', '.', 'src/planned.ts'])(
  'registers a review for source scope %s, including planned source and ancestor directories',
  async (scope) => {
    const f = await fixture([scope]);
    const original = await readFile(f.path, 'utf8');
    expect((await f.state()).plan.acceptance).toContainEqual(
      expect.objectContaining({
        id: 'quality-review',
        method: 'review',
      }),
    );
    expect(cli(f.root, ['ensure', '--stdin'], f.request).status).toBe(0);
    expect(await readFile(f.path, 'utf8')).toBe(original);
    expect(f.context().assessment.qualityReview).toEqual({
      required: true,
      criterion: 'quality-review',
      result: 'pending',
    });
  },
);

it('leaves a document task alone despite source inputs, and registers review on scope expansion', async () => {
  const f = await fixture(['docs/api.md']);
  expect(f.context().assessment.qualityReview.result).toBe('not_required');
  expect((await f.state()).plan.acceptance).toHaveLength(2);
  const result = cli(f.root, ['update', f.id, '--stdin'], {
    revision: f.context().revision,
    reason: 'Fixture user adds source implementation.',
    plan: { scope: ['src', 'docs/api.md'] },
  });
  expect(result.status, result.output).toBe(0);
  expect((await f.state()).plan.acceptance).toHaveLength(3);
  expect(JSON.parse(result.output).assessment.errors.join()).toContain('WORK_CONTEXT_CHANGED');
  await rm(join(f.root, 'src/value.ts'));
  // Use default manifest inputs after deleting the only source; the planned source scope remains.
  const current = await f.state();
  current.plan.inputs = ['package.json'];
  await writeFile(f.path, JSON.stringify(current));
  expect(f.context().assessment.qualityReview.required).toBe(true);
});

it('refuses missing or automated quality criteria and repairs legacy omission only on explicit update', async () => {
  const f = await fixture();
  const task = await f.state();
  task.plan.acceptance = task.plan.acceptance.filter((item) => item.id !== 'quality-review');
  await writeFile(f.path, JSON.stringify(task));
  expect(cli(f.root, ['check', f.id]).output).toContain('WORK_QUALITY_CONTRACT');
  const before = await readFile(f.path, 'utf8');
  expect(cli(f.root, ['ensure', '--stdin'], { requirement: f.request.requirement }).status).toBe(0);
  expect(await readFile(f.path, 'utf8')).toBe(before);
  expect(
    cli(f.root, ['deliver', f.id, '--stdin'], {
      action: 'prepare',
      revision: f.context().revision,
    }).output,
  ).toContain('WORK_QUALITY_CONTRACT');
  expect(
    cli(f.root, ['update', f.id, '--stdin'], {
      revision: f.context().revision,
      reason: 'Use the existing quality gate.',
      plan: {
        acceptance: [{ id: 'quality-review', method: 'automated', criterion: 'Not a review.' }],
      },
    }).output,
  ).toContain('WORK_QUALITY_CONTRACT');
  expect(await readFile(f.path, 'utf8')).toBe(before);
  expect(
    cli(f.root, ['update', f.id, '--stdin'], {
      revision: f.context().revision,
      reason: 'Register the missing required review.',
    }).status,
  ).toBe(0);
  expect(
    (await f.state()).plan.acceptance.find((item) => item.id === 'quality-review')?.method,
  ).toBe('review');
});

it('runs the real verify/evidence/delivery flow, blocks incomplete reviews and rejects rebinding an old original', async () => {
  const f = await fixture();
  expect((await f.state()).delivery).toEqual({ version: 2 });
  expect(
    cli(f.root, ['run', f.id, 'checks', '--', process.execPath, '-e', 'console.log(1)']).status,
  ).toBe(0);
  const prepare = () =>
    cli(f.root, ['deliver', f.id, '--stdin'], {
      action: 'prepare',
      revision: f.context().revision,
      title: 'Fixture result',
      locations: [{ path: 'src/value.ts', purpose: 'Fixture constant' }],
      outcomes: 'Fixture implementation is ready.',
      verification: 'Fixture checks and actual review originals.',
      limitations: 'Isolated fixture only.',
    });
  expect(prepare().output).toContain('WORK_DELIVERY_EVIDENCE');
  const candidate = f.context().assessment.candidate as string;
  let index = 0;
  const submit = async (report: unknown, result = 'pass') => {
    const path = `.work/tasks/${f.id}/evidence/review-${index++}.md`;
    await writeFile(
      join(f.root, path),
      typeof report === 'string' ? report : reviewMarkdown(report),
    );
    return {
      path,
      ...cli(f.root, ['evidence', f.id, 'quality-review', result, path, 'Fixture observations.']),
    };
  };
  expect((await submit('# Looks fine')).status).toBe(1);
  const incomplete = reviewFixture(candidate);
  for (const result of [['pending'], ['fail']]) {
    expect(
      (
        await submit({
          ...incomplete,
          dimensions: {
            ...incomplete.dimensions,
            algorithm: { result, evidence: 'Malformed status must never become a passing review.' },
          },
        })
      ).status,
    ).toBe(1);
  }
  expect(
    (await submit({ ...incomplete, dimensions: { algorithm: incomplete.dimensions.algorithm } }))
      .status,
  ).toBe(1);
  for (const result of ['fail', 'pending']) {
    const report = reviewFixture(candidate);
    report.dimensions.unused = { result, evidence: 'Fixture issue or missing consumer evidence.' };
    expect((await submit(report, 'pass')).status).toBe(1);
    expect((await submit(report, result)).status).toBe(0);
    expect(prepare().output).toContain('WORK_DELIVERY_EVIDENCE');
  }
  const valid = await submit(reviewFixture(candidate));
  expect(valid.status, valid.output).toBe(0);
  expect((await f.state()).evidence.map((item) => item.result)).toEqual([
    'pass',
    'fail',
    'pending',
    'pass',
  ]);
  const normsPath = `.work/tasks/${f.id}/evidence/norms.md`;
  await writeFile(join(f.root, normsPath), normsMarkdown(normsFixture(await f.state())));
  expect(
    cli(f.root, ['evidence', f.id, 'norms-review', 'pass', normsPath, 'Fixture norm review.'])
      .status,
  ).toBe(0);
  expect(prepare().status).toBe(0);
  expect((await f.state()).reviewDecision).toBe('PENDING');
  await writeFile(join(f.root, 'src/value.ts'), 'export const value = 2;');
  expect(cli(f.root, ['check', f.id]).status).toBe(1);
  expect(cli(f.root, ['sync', f.id, 'Inspected changed source.']).status).toBe(0);
  expect(f.context().assessment.qualityReview.result).toBe('pending');
  expect(
    cli(f.root, ['evidence', f.id, 'quality-review', 'pass', valid.path, 'Old review.']).output,
  ).toContain('review candidate mismatch');
  expect((await f.state()).evidence).toHaveLength(5);
});

it('rechecks review contents at delivery instead of trusting a forged pass label', async () => {
  const f = await fixture();
  const task = await f.state();
  const path = `.work/tasks/${f.id}/evidence/forged.md`;
  const report = reviewFixture(task.checkpoint!.candidate);
  report.dimensions.algorithm.result = 'fail';
  const bytes = reviewMarkdown(report);
  await mkdir(dirname(join(f.root, path)), { recursive: true });
  await writeFile(join(f.root, path), bytes);
  task.evidence.push({
    criterion: 'quality-review',
    method: 'review',
    result: 'pass',
    candidate: task.checkpoint!.candidate,
    artifact: path,
    sha256: digest(bytes),
    summary: 'Forged pass',
    environment: 'fixture',
  });
  await writeFile(f.path, JSON.stringify(task));
  expect(f.context().assessment.qualityReview.result).toBe('invalid');
  const output = cli(f.root, ['context', f.id, 'verify']).output;
  const navigation = JSON.parse(output).reading.find((entry: { ref: string }) =>
    entry.ref.endsWith('#验证与接受'),
  );
  const section = JSON.parse(cli(f.root, [...navigation.read.argv, '--limit', '20']).output);
  const review = section.items.find(
    (block: { type: string; body: unknown }) =>
      block.type === 'list' && JSON.stringify(block.body).includes('algorithm'),
  );
  const details =
    typeof review.body === 'string' ? review.body : cli(f.root, review.body.$read.argv).output;
  expect(details).toContain('algorithm');
  expect(details).toContain('unused');
  expect(details).toContain('reuse');
  expect(output).not.toContain('## 交付命令');
});

it('requires actual candidate-bound normative page observations and rejects old originals after a normative edit', async () => {
  const f = await fixture(['docs/api.md']);
  const changed = cli(f.root, ['update', f.id, '--stdin'], {
    revision: f.context().revision,
    reason: 'Review the affected current API.',
    plan: { norms: { paths: ['docs/api.md'], reason: 'The fixture API covers this result.' } },
  });
  expect(changed.status, changed.output).toBe(0);
  expect(cli(f.root, ['sync', f.id, 'Inspected the explicit normative declaration.']).status).toBe(
    0,
  );
  expect(
    cli(f.root, ['run', f.id, 'checks', '--', process.execPath, '-e', 'console.log(1)']).status,
  ).toBe(0);
  const task = await f.state();
  const report = normsFixture(task);
  const path = `.work/tasks/${f.id}/evidence/norms-page.md`;
  const submit = async (value: unknown) => {
    await writeFile(join(f.root, path), normsMarkdown(value));
    return cli(f.root, [
      'evidence',
      f.id,
      'norms-review',
      'pass',
      path,
      'Fixture page observations.',
    ]);
  };
  expect((await submit({ ...report, documents: [] })).output).toContain('WORK_NORMS_EVIDENCE');
  expect(
    (await submit({ ...report, documents: [{ ...report.documents[0], sha256: 'a'.repeat(64) }] }))
      .output,
  ).toContain('hash/path mismatch');
  expect((await submit(report)).status).toBe(0);
  const oldOriginal = await readFile(join(f.root, path), 'utf8');
  expect(f.context().assessment.normsReview.result).toBe('pass');
  await writeFile(join(f.root, 'docs/api.md'), '# Updated current API\n');
  expect(cli(f.root, ['check', f.id]).status).toBe(1);
  expect(
    cli(f.root, ['update', f.id, '--stdin'], {
      revision: f.context().revision,
      reason: 'The same API requirement now has its updated real heading.',
      plan: { requirement: { section: 'Updated current API' } },
    }).status,
  ).toBe(0);
  expect(
    cli(f.root, ['sync', f.id, 'Reviewed normative edits before taking new evidence.']).status,
  ).toBe(0);
  expect(f.context().assessment.normsReview.result).toBe('pending');
  expect(
    cli(f.root, ['evidence', f.id, 'norms-review', 'pass', path, 'Attempt old original.']).output,
  ).toContain('candidate or declaration mismatch');
  expect(await readFile(join(f.root, path), 'utf8')).toBe(oldOriginal);
});

it('allows only current normative pages and an explicitly justified empty set', async () => {
  const f = await fixture(['docs/api.md']);
  await mkdir(join(f.root, 'docs/tasks/example'), { recursive: true });
  await writeFile(join(f.root, 'docs/tasks/example/prd.md'), '# Requirement');
  await writeFile(join(f.root, 'docs/tasks/example/proposal.md'), '# Candidate');
  await writeFile(
    join(f.root, 'docs/compat-prd.md'),
    '# 资料已迁移\n\n[当前资料](../docs/tasks/example/prd.md)\n',
  );
  const documents: TaskDocument[] = [
    {
      identity: 'docs/compat-prd.md',
      kind: 'prd',
      path: 'docs/tasks/example/prd.md',
      aliases: ['docs/compat-prd.md'],
    },
    {
      identity: 'docs/tasks/example/proposal.md',
      kind: 'proposal',
      path: 'docs/tasks/example/proposal.md',
    },
  ];
  await writeTaskDocuments(f.root, documents);
  const plan = (await f.state()).plan;
  for (const path of [
    'docs/compat-prd.md',
    'docs/tasks/example/prd.md',
    'docs/tasks/example/proposal.md',
    'docs/tasks/index.md',
  ]) {
    expect(
      (
        await normsIssues(f.root, {
          ...plan,
          norms: { paths: [path], reason: 'Fixture rejection.' },
        })
      ).join(),
    ).toContain('WORK_NORMS_PATH');
  }
  expect(
    await normsIssues(f.root, {
      ...plan,
      norms: { paths: ['docs/api.md'], reason: 'Fixture actual current contract.' },
    }),
  ).toEqual([]);
  expect(
    await normsIssues(f.root, {
      ...plan,
      norms: { paths: [], reason: 'Fixture implementation has no normative impact.' },
    }),
  ).toEqual([]);
});

it('enables reconciliation for maintenance without inventing a development result or blocking cancellation', async () => {
  const f = await fixture(['docs/api.md'], false);
  const task = await f.state();
  expect(task.plan.result).toBeNull();
  expect(task.delivery).toBeUndefined();
  expect(task.plan.norms?.version).toBe(2);
  expect(f.context().assessment.normsReview).toMatchObject({ required: true, result: 'pending' });
  const path = `.work/tasks/${f.id}/evidence/maintenance.md`;
  await mkdir(dirname(join(f.root, path)), { recursive: true });
  await writeFile(join(f.root, path), normsMarkdown(normsFixture(task)));
  const observed = cli(f.root, [
    'evidence',
    f.id,
    'norms-review',
    'pass',
    path,
    'Synthetic maintenance reconciliation.',
  ]);
  expect(observed.status, observed.output).toBe(0);
  expect(f.context().assessment.normsReview.result).toBe('pass');
  expect(
    cli(f.root, ['deliver', f.id, '--stdin'], { action: 'prepare', revision: f.context().revision })
      .output,
  ).toContain('WORK_DELIVERY_RESULT');
  const cancelled = await fixture(['docs/api.md'], false);
  expect(
    cli(cancelled.root, [
      'archive',
      cancelled.id,
      'Fixture user pauses this unfinished maintenance; checks and reconciliation remain pending.',
    ]).status,
  ).toBe(0);
  expect((await cancelled.state()).evidence).toEqual([]);
  expect((await cancelled.state()).archived).toBe(true);
});

it('checks declared requirement and design current pages without duplicating ordinary norms or trusting report-only sources', async () => {
  const f = await fixture(['docs'], false);
  const taskRoot = 'docs/tasks/example';
  const prd = `${taskRoot}/prd.md`;
  const design = `${taskRoot}/design.md`;
  const proposal = `${taskRoot}/proposal.md`;
  const alias = 'docs/old-prd.md';
  await mkdir(join(f.root, taskRoot), { recursive: true });
  for (const path of [prd, design, proposal, 'docs/norm.md', 'docs/unlisted.md', 'docs/index.md'])
    await writeFile(join(f.root, path), `# Fixture ${path}\n`);
  await writeFile(join(f.root, alias), '# 资料已迁移\n\n[当前资料](tasks/example/prd.md)\n');
  const registeredDocuments: TaskDocument[] = [
    { identity: alias, kind: 'prd', path: prd, aliases: [alias] },
    { identity: design, kind: 'design', path: design },
    { identity: proposal, kind: 'proposal', path: proposal },
  ];
  await writeTaskDocuments(f.root, registeredDocuments);
  const updated = cli(f.root, ['update', f.id, '--stdin'], {
    revision: f.context().revision,
    reason: 'Declare the fixture requirement and unadopted design sources before reviewing them.',
    plan: {
      sources: [alias, design, proposal, 'docs/api.md', 'docs/norm.md', 'docs/index.md'],
      norms: {
        paths: ['docs/api.md', 'docs/norm.md'],
        reason: 'Two actual normative pages; the API section is also the maintenance requirement.',
      },
    },
  });
  expect(updated.status, updated.output).toBe(0);
  expect(
    cli(f.root, ['sync', f.id, 'Inspected declared sources, normative pages and alias registry.'])
      .status,
  ).toBe(0);
  const report = normsFixture(await f.state(), ['docs/api.md', prd, design, proposal]);
  report.accepted.results = [
    {
      prd: alias,
      key: 'prior-key',
      candidate: 'a'.repeat(64),
      assessment:
        'Synthetic historical reference only; the CLI must not certify it as real acceptance.',
    },
  ];
  const path = `.work/tasks/${f.id}/evidence/sources.md`;
  await mkdir(dirname(join(f.root, path)), { recursive: true });
  const submit = async (value: unknown) => {
    await writeFile(join(f.root, path), normsMarkdown(value));
    return cli(f.root, [
      'evidence',
      f.id,
      'norms-review',
      'pass',
      path,
      'Fixture declared-source observations.',
    ]);
  };
  const documents = report.requirements.documents;
  const current = (await f.state()).checkpoint!;
  expect(
    (
      await submit({
        ...report,
        requirements: {
          ...report.requirements,
          documents: documents.filter((entry) => entry.path !== design),
        },
      })
    ).status,
  ).toBe(1);
  for (const replacement of [alias, 'docs/unlisted.md', 'docs/norm.md', 'docs/index.md']) {
    const changed = documents.map((entry) =>
      entry.path === design
        ? { ...entry, path: replacement, sha256: current.files[replacement] }
        : entry,
    );
    expect(
      (await submit({ ...report, requirements: { ...report.requirements, documents: changed } }))
        .output,
    ).toContain('hash/path mismatch');
  }
  expect((await submit(report)).status).toBe(0);
  // The fixture has no book or index: accepted observations are structure, never a live mirror.
  await expect(readFile(join(f.root, 'docs/tasks/index.md'))).rejects.toThrow();
});

it('rejects missing reconciliation dimensions, bad source binding and fail or pending observations labelled as all pass', async () => {
  const f = await fixture(['docs/api.md']);
  const update = cli(f.root, ['update', f.id, '--stdin'], {
    revision: f.context().revision,
    reason: 'Review the real affected API page in all three relationships.',
    plan: { norms: { paths: ['docs/api.md'], reason: 'Fixture normative impact.' } },
  });
  expect(update.status, update.output).toBe(0);
  expect(cli(f.root, ['sync', f.id, 'Inspected the v2 contract.']).status).toBe(0);
  const report = normsFixture(await f.state());
  const directory = `.work/tasks/${f.id}/evidence`;
  await mkdir(join(f.root, directory), { recursive: true });
  let observation = 0;
  const submit = async (value: unknown, declared = 'pass') => {
    const path = `${directory}/dimensions-${observation++}.md`;
    await writeFile(join(f.root, path), normsMarkdown(value));
    return cli(f.root, [
      'evidence',
      f.id,
      'norms-review',
      declared,
      path,
      'Synthetic three-way observations.',
    ]);
  };
  for (const field of ['version', 'requirements', 'accepted', 'remaining', 'documents'])
    expect((await submit({ ...report, [field]: undefined })).status).toBe(1);
  for (const value of [
    { ...report, requirements: { ...report.requirements, documents: [] } },
    {
      ...report,
      requirements: {
        ...report.requirements,
        documents: [{ ...report.requirements.documents[0], sha256: 'a'.repeat(64) }],
      },
    },
    { ...report, candidate: 'a'.repeat(64) },
    { ...report, requirements: { ...report.requirements, result: 'pending' } },
    { ...report, requirements: { ...report.requirements, result: ['fail'] } },
    { ...report, accepted: { ...report.accepted, result: 'fail' } },
    { ...report, accepted: { ...report.accepted, assessment: '' } },
    { ...report, documents: [{ ...report.documents[0], result: 'pending' }] },
    { ...report, documents: [{ ...report.documents[0], result: ['pass'] }] },
    {
      ...report,
      accepted: {
        ...report.accepted,
        results: [
          {
            prd: 'docs/api.md',
            key: 'old',
            candidate: 'not-a-hash',
            assessment: 'Invalid candidate.',
          },
        ],
      },
    },
  ])
    expect((await submit(value)).status).toBe(1);
  const pending = {
    ...report,
    requirements: { ...report.requirements, result: 'pending' },
    conclusion: {
      result: 'pending',
      evidence: 'Synthetic requirement coverage has not yet been established.',
    },
  };
  expect((await submit(pending, 'pending')).status).toBe(0);
  expect(f.context().assessment.normsReview.result).toBe('pending');
  const pendingEntry = (await f.state()).evidence.at(-1)!;
  const pendingOriginal = await readFile(join(f.root, pendingEntry.artifact), 'utf8');
  const failed = {
    ...report,
    accepted: { ...report.accepted, result: 'fail' },
    conclusion: { result: 'fail', evidence: 'Synthetic accepted-state conflict needs resolution.' },
  };
  expect((await submit(failed, 'pass')).status).toBe(1);
  const acceptedFailure = await submit(failed, 'fail');
  expect(acceptedFailure.status, acceptedFailure.output).toBe(0);
  expect(f.context().assessment.normsReview.result).toBe('fail');
  expect(await readFile(join(f.root, pendingEntry.artifact), 'utf8')).toBe(pendingOriginal);
  expect((await f.state()).evidence.slice(-2).map((entry) => entry.result)).toEqual([
    'pending',
    'fail',
  ]);
  // Bypass the registration entry only to show that later assessment does not trust a forged pass.
  const task = await f.state();
  task.evidence.at(-1)!.result = 'pass';
  await writeFile(f.path, JSON.stringify(task));
  expect(f.context().assessment.normsReview.result).toBe('invalid');
});

it('reads legacy originals without migration but requires an explicit v2 declaration for new evidence', async () => {
  const f = await fixture(['docs/api.md'], false);
  const task = await f.state();
  delete task.plan.norms!.version;
  task.checkpoint = await capture(f.root, task);
  const path = `.work/tasks/${f.id}/evidence/legacy-norms.md`;
  const report = normsMarkdown({
    candidate: task.checkpoint.candidate,
    reviewer: 'historical fixture reviewer',
    reason: task.plan.norms!.reason,
    documents: [],
    conclusion: { result: 'pass', evidence: 'Original v1 observation retained as history.' },
    limitations: 'No v2 reconciliation was claimed.',
  });
  await mkdir(dirname(join(f.root, path)), { recursive: true });
  await writeFile(join(f.root, path), report);
  task.evidence.push({
    criterion: 'norms-review',
    method: 'review',
    result: 'pass',
    candidate: task.checkpoint.candidate,
    artifact: path,
    sha256: digest(report),
    summary: 'Historical fixture observation.',
    environment: 'fixture',
  });
  await writeFile(f.path, JSON.stringify(task));
  const original = await readFile(f.path, 'utf8');
  expect(f.context().assessment.normsReview.result).toBe('pass');
  expect(cli(f.root, ['status']).status).toBe(0);
  expect(cli(f.root, ['ensure', '--stdin'], { requirement: f.request.requirement }).status).toBe(0);
  expect(await readFile(f.path, 'utf8')).toBe(original);
  expect(
    cli(f.root, [
      'evidence',
      f.id,
      'norms-review',
      'pass',
      path,
      'Attempt a new legacy observation.',
    ]).output,
  ).toContain('plan.norms.version 2');
  expect(await readFile(f.path, 'utf8')).toBe(original);
  const progress = cli(f.root, ['update', f.id, '--stdin'], {
    revision: f.context().revision,
    reason: 'Only the next action changed.',
    plan: { nextAction: 'Explicitly reconcile before new evidence.' },
  });
  expect(progress.status, progress.output).toBe(0);
  expect((await f.state()).plan.norms?.version).toBeUndefined();
  expect(f.context().assessment.normsReview.result).toBe('pass');
  const upgrade = cli(f.root, ['update', f.id, '--stdin'], {
    revision: f.context().revision,
    reason: 'Explicitly adopt the new reconciliation original contract.',
    plan: { norms: task.plan.norms },
  });
  expect(upgrade.status, upgrade.output).toBe(0);
  expect((await f.state()).plan.norms?.version).toBe(2);
  expect(cli(f.root, ['sync', f.id, 'Inspected the explicit v2 upgrade.']).status).toBe(0);
  expect(f.context().assessment.normsReview.result).toBe('pending');
  expect(await readFile(join(f.root, path), 'utf8')).toBe(report);
});

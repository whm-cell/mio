import { spawnSync } from 'node:child_process';
import {
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import type { TaskDocument } from '../../scripts/harness/inventory.ts';
import { recordsPath } from '../../scripts/harness/work/compact-store.ts';
import { artifact } from '../../scripts/harness/work/context.ts';
import { contractPlan, digest, taskRevision } from '../../scripts/harness/work/records.ts';
import { renderBook } from '../../scripts/harness/work/reports.ts';
import { reviewFixture, reviewMarkdown } from './fixtures/quality-review-fixture.ts';
import { writeTaskDocuments } from './fixtures/task-documents-fixture.ts';
import {
  accept,
  commitFixture,
  edit,
  fetchFixtureCommit,
  fixture,
  implementing,
  invoke,
  proposal,
  ready,
  requirement,
  run,
  scratch,
  state,
  statePath,
  verifying,
} from './fixtures/work-cli-fixture.ts';

it('preserves requirement identity across handoff while clearing recipient authority and evidence', async () => {
  const sender = await fixture();
  const first = JSON.parse(invoke(sender, ['ensure', '--stdin'], proposal()).output);
  const id = first.task.id as string;
  expect(invoke(sender, ['sync', id, 'Reviewed the committed handoff candidate.']).status).toBe(0);
  const portable = invoke(sender, ['handoff', id]);
  expect(portable.status, portable.output).toBe(0);
  const receiver = await fixture('bob');
  fetchFixtureCommit(receiver, sender);
  await mkdir(join(receiver, '.work/inbox'));
  await cp(portable.output, join(receiver, '.work/inbox/task.md'));
  expect(invoke(receiver, ['receive', '.work/inbox/task.md']).status).toBe(0);
  const resumed = JSON.parse(invoke(receiver, ['ensure', '--stdin'], { requirement }).output);
  expect(resumed.created).toBe(false);
  expect(resumed.task.id).toBe(id);
  expect(resumed.task.requirement).toEqual(requirement);
  expect(resumed.task.authorization).toBe('');
  expect(resumed.assessment.ready).toBe(false);
  expect((await state(receiver, id)).evidence).toEqual([]);
});

it('binds a committed public environment template while an ignored private file stays outside Git', async () => {
  const root = await fixture();
  await writeFile(join(root, '.env.example'), 'MIO_ENVIRONMENT=dev\n');
  await writeFile(join(root, '.env.test'), 'SECRET=private\n');
  expect(spawnSync('git', ['check-ignore', '.env.test'], { cwd: root }).status).toBe(0);
  commitFixture(root, 'Add public environment template', ['.env.example']);
  await ready(root);
  await edit(root, (task) => {
    task.plan.inputs.push('.env.example');
  });
  expect(invoke(root, ['sync', 'probe', 'Include the public environment template.']).status).toBe(
    0,
  );
  expect(
    spawnSync('git', ['ls-files', '--error-unmatch', '.env.example'], { cwd: root }).status,
  ).toBe(0);
  expect(
    spawnSync('git', ['ls-files', '--error-unmatch', '.env.test'], { cwd: root }).status,
  ).not.toBe(0);
  verifying(root);
  await writeFile(join(root, '.env.example'), 'MIO_ENVIRONMENT=test\n');
  expect(invoke(root, ['check', 'probe']).output).toContain('WORK_CANDIDATE');
});

it('rejects private/traversal/symlink inputs, missing sources, and foreign workspace ownership', async () => {
  const root = await fixture();
  await ready(root);
  const original = await state(root);
  for (const path of [
    '../outside',
    '/tmp/foreign',
    '.work',
    '.env',
    '.env.test',
    'docs/missing.md',
  ]) {
    await edit(root, (task) => {
      task.plan.inputs = [...original.plan.inputs, path];
    });
    expect(invoke(root, ['sync', 'probe', 'Attempt invalid input.']).status, path).toBe(1);
  }
  await writeFile(statePath(root), JSON.stringify(original));
  await symlink(join(root, 'docs/api.md'), join(root, 'src/alias.ts'));
  await edit(root, (task) => {
    task.plan.inputs.push('src/alias.ts');
  });
  expect(invoke(root, ['check', 'probe']).output).toContain('WORK_SYMLINK');
  await rm(join(root, 'src/alias.ts'));
  await writeFile(statePath(root), JSON.stringify(original));
  await edit(root, (task) => {
    task.workspace = '/different-workspace';
  });
  expect(invoke(root, ['check', 'probe']).output).toContain('WORK_OWNER');
});

it('rejects a symlinked private directory before writing', async () => {
  const root = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'mio-work-outside-'));
  scratch.push(outside);
  await rm(join(root, '.work'), { recursive: true });
  await symlink(outside, join(root, '.work'));
  expect(invoke(root, ['init', 'alice']).output).toContain('WORK_SYMLINK');
  expect(await readdir(outside)).toEqual([]);
});

it('checks retrieved manual evidence and refuses release after its artifact is corrupted or missing', async () => {
  const root = await fixture();
  await ready(root);
  await edit(root, (task) => {
    task.plan.acceptance = [
      { id: 'observe', criterion: 'Actual behavior observed.', method: 'behavior' },
      task.plan.acceptance.find((item) => item.id === 'quality-review')!,
    ];
  });
  expect(invoke(root, ['sync', 'probe', 'Bound the observed acceptance method.']).status).toBe(0);
  verifying(root);
  const relative = '.work/tasks/probe/evidence/observation.md';
  await mkdir(dirname(join(root, relative)), { recursive: true });
  const current = await state(root);
  const original =
    '# Actual observation\nEnvironment and actions.\n\n```mio-evidence\n' +
    JSON.stringify({
      candidate: current.checkpoint!.candidate,
      contract: contractPlan(current),
      criterion: 'observe',
      result: 'pass',
      observation: 'Observed the fixture behavior in this isolated workspace.',
    }) +
    '\n```\n';
  await writeFile(join(root, relative), original);
  expect(
    invoke(root, ['evidence', 'probe', 'observe', relative, 'Observed the criterion.']).status,
  ).toBe(0);
  await accept(root);
  expect(invoke(root, ['check', 'probe']).status).toBe(0);
  await writeFile(join(root, relative), 'changed');
  expect(JSON.parse(invoke(root, ['check', 'probe']).output).evidence[0].result).toBe('corrupt');
  verifying(root);
  const before = await readFile(statePath(root), 'utf8');
  expect(
    invoke(root, ['evidence', 'probe', 'observe', relative, 'Replace the old observation.']).output,
  ).toContain('WORK_EVIDENCE_IMMUTABLE');
  expect(await readFile(statePath(root), 'utf8')).toBe(before);
  // On case-insensitive filesystems this is the same inode with nlink=1, not a hard link.
  const alias = relative.replace('observation.md', 'OBSERVATION.md');
  const aliasStat = await lstat(join(root, alias)).catch(() => null);
  if (aliasStat?.ino === (await lstat(join(root, relative))).ino) {
    const aliased = invoke(root, [
      'evidence',
      'probe',
      'observe',
      alias,
      'Alias must not bypass immutability.',
    ]);
    expect(aliased.output).toContain('WORK_EVIDENCE_IMMUTABLE');
    expect(await readFile(statePath(root), 'utf8')).toBe(before);
  }
  const fresh = '.work/tasks/probe/evidence/fresh-observation.md';
  await writeFile(join(root, fresh), original);
  expect(
    invoke(root, [
      'evidence',
      'probe',
      'observe',
      fresh,
      'Fresh observation of the same candidate.',
    ]).status,
  ).toBe(0);
  expect(JSON.parse(invoke(root, ['check', 'probe']).output).evidence[0].result).toBe('pass');
  await rm(join(root, fresh));
  expect(JSON.parse(invoke(root, ['check', 'probe']).output).evidence[0].result).toBe('missing');
  await rm(join(root, relative));
  expect(JSON.parse(invoke(root, ['check', 'probe']).output).evidence[0].result).toBe('missing');
  const replacement = '.work/tasks/probe/evidence/replacement.md';
  await writeFile(join(root, replacement), original);
  expect(
    invoke(root, [
      'evidence',
      'probe',
      'observe',
      replacement,
      'New observation after missing historical originals.',
    ]).status,
  ).toBe(0);
});

// Each observation is registered and checked through the real CLI.
it('binds ordinary manual observations to their declared candidate, criterion and result', async () => {
  const root = await fixture();
  await ready(root);
  await edit(root, (task) => {
    task.plan.acceptance.push(
      {
        id: 'observe',
        method: 'behavior',
        criterion: 'Observe the actual candidate.',
      },
      {
        id: 'manual-review',
        method: 'review',
        criterion: 'Review the actual candidate.',
      },
    );
  });
  expect(invoke(root, ['sync', 'probe', 'Added behavior acceptance.']).status).toBe(0);
  verifying(root);
  const relative = '.work/tasks/probe/evidence/observation.md';
  await mkdir(dirname(join(root, relative)), { recursive: true });
  const current = await state(root);
  const candidateA = current.checkpoint!.candidate;
  const original = (report: unknown) =>
    '# Actual fixture observation\n\n```mio-evidence\n' + JSON.stringify(report) + '\n```\n';
  const report = {
    candidate: candidateA,
    contract: contractPlan(current),
    criterion: 'observe',
    result: 'pass',
    observation: 'Observed the fixture candidate in this isolated workspace.',
  };
  await writeFile(join(root, relative), original(report));
  await implementing(root);
  await writeFile(join(root, 'src/value.ts'), 'export const value = 2;\n');
  commitFixture(root, 'Change the observed candidate', ['src/value.ts']);
  expect(invoke(root, ['sync', 'probe', 'Reviewed the changed fixture source.']).status).toBe(0);
  verifying(root);
  const candidateB = (await state(root)).checkpoint!.candidate;
  expect(candidateB).not.toEqual(candidateA);
  const before = await readFile(statePath(root), 'utf8');
  for (const body of [
    original(report),
    'An unbound historical observation.',
    original({
      candidate: candidateB,
      criterion: 'observe',
      result: 'pass',
      observation: report.observation,
    }),
    original({ ...report, candidate: candidateB, observation: '' }),
    original({ ...report, candidate: candidateB, contract: { ...report.contract, id: 'other' } }),
    original({ ...report, candidate: candidateB, criterion: 'different' }),
    original({ ...report, candidate: candidateB, result: 'unknown' }),
  ]) {
    await writeFile(join(root, relative), body);
    const rejected = invoke(root, [
      'evidence',
      'probe',
      'observe',
      relative,
      'Must not bind invalid observation.',
    ]);
    expect(rejected.status, rejected.output).toBe(1);
    expect(await readFile(statePath(root), 'utf8')).toBe(before);
  }
  expect(invoke(root, ['evidence', 'probe', 'observe', 'pass', relative, 'Old call.']).status).toBe(
    1,
  );
  expect(
    invoke(root, ['evidence', 'probe', 'checks', relative, 'Pretend automated.']).output,
  ).toContain('mio-coverage');
  expect(await readFile(statePath(root), 'utf8')).toBe(before);
  for (const result of ['fail', 'pending']) {
    const path = `.work/tasks/probe/evidence/observation-${result}.md`;
    await writeFile(join(root, path), original({ ...report, candidate: candidateB, result }));
    expect(
      invoke(root, ['evidence', 'probe', 'observe', path, 'Fixture observation.']).status,
    ).toBe(0);
    expect((await state(root)).evidence.at(-1)!.result).toBe(result);
  }
  const review = '.work/tasks/probe/evidence/ordinary-review.md';
  await writeFile(
    join(root, review),
    original({ ...report, candidate: candidateB, criterion: 'manual-review' }),
  );
  expect(
    invoke(root, ['evidence', 'probe', 'manual-review', review, 'Fixture review.']).status,
  ).toBe(0);
  expect((await state(root)).evidence.at(-1)!.result).toBe('pass');
  await writeFile(join(root, relative), original({ ...report, candidate: candidateB }));
  expect(invoke(root, ['evidence', 'probe', 'observe', relative, 'Observed B.']).status).toBe(0);
  // Simulate a legacy/imported record that claims B while its actual original still declares A.
  await writeFile(join(root, relative), original(report));
  await edit(root, (task) => {
    task.evidence.at(-1)!.sha256 = digest(original(report));
  });
  expect(
    JSON.parse(invoke(root, ['check', 'probe']).output).evidence.find(
      (entry: { criterion: string }) => entry.criterion === 'observe',
    ).result,
  ).toBe('invalid');
  expect((await state(root)).evidence.at(-1)!.candidate).toEqual(candidateB);
}, 30_000);

it('rejects linked original aliases at registration and when checking previously registered evidence', async () => {
  const root = await fixture();
  await ready(root);
  verifying(root);
  const relative = '.work/tasks/probe/evidence/review.md';
  await mkdir(dirname(join(root, relative)), { recursive: true });
  const current = await state(root);
  const content = reviewMarkdown({
    ...reviewFixture(current.checkpoint!.candidate),
    contract: contractPlan(current),
  });
  await writeFile(join(root, relative), content);
  const alias = join(root, '.work/review-alias.md');
  await link(join(root, relative), alias);
  const before = await readFile(statePath(root), 'utf8');
  const register = () =>
    invoke(root, ['evidence', 'probe', 'quality-review', relative, 'Fixture review.']);
  expect(register().output).toContain('WORK_ARTIFACT');
  expect(await readFile(statePath(root), 'utf8')).toBe(before);
  await rm(alias);
  expect(register().status).toBe(0);
  await link(join(root, relative), alias);
  expect(JSON.parse(invoke(root, ['check', 'probe']).output).evidence.at(-1).result).toBe(
    'missing',
  );
  await rm(alias);
  await rm(join(root, relative));
  await symlink(join(root, 'src/value.ts'), join(root, relative));
  expect(register().output).toContain('WORK_SYMLINK');
  await rm(join(root, relative));
  await mkdir(join(root, relative));
  expect(register().output).toContain('WORK_ARTIFACT');
});

it('rejects public candidate inputs as manual originals and accepts a private copy', async () => {
  const root = await fixture();
  await ready(root);
  const relative = 'docs/shared-review.md';
  await writeFile(join(root, relative), '# An observation included in the input scope\n');
  await edit(root, (task) => {
    task.plan.inputs.push(relative);
    task.plan.acceptance.push({
      id: 'inspect',
      method: 'review',
      criterion: 'Observe actual behavior.',
    });
  });
  commitFixture(root, 'Add the shared review input', [relative]);
  expect(invoke(root, ['sync', 'probe', 'Bound the shared observation as an input.']).status).toBe(
    0,
  );
  verifying(root);
  const before = await readFile(statePath(root), 'utf8');
  const rejected = invoke(root, [
    'evidence',
    'probe',
    'inspect',
    relative,
    'Must not create a self-bound observation.',
  ]);
  expect(rejected.output).toMatch(/WORK_ARTIFACT|WORK_EVIDENCE/);
  expect(await readFile(statePath(root), 'utf8')).toBe(before);
  const copy = '.work/tasks/probe/evidence/shared-review-copy.md';
  await mkdir(dirname(join(root, copy)), { recursive: true });
  const current = await state(root);
  await writeFile(
    join(root, copy),
    '# Retrieved observation\n\n```mio-evidence\n' +
      JSON.stringify({
        candidate: current.checkpoint!.candidate,
        contract: contractPlan(current),
        criterion: 'inspect',
        result: 'pending',
        observation: 'The independent fixture observation has not yet been completed.',
      }) +
      '\n```\n',
  );
  expect(
    invoke(root, [
      'evidence',
      'probe',
      'inspect',
      copy,
      'Independent retrieved observation remains pending.',
    ]).status,
  ).toBe(0);
  expect((await state(root)).evidence.at(-1)!.result).toBe('pending');
});

it('blocks unresolved dependencies without preventing preparation of a bounded handoff', async () => {
  const root = await fixture();
  await ready(root);
  await edit(root, (task) => {
    task.plan.dependencies = [{ task: 'upstream', ref: 'Shared upstream contract', ready: false }];
    task.plan.blockers = ['Upstream artifact has not arrived.'];
  });
  expect(invoke(root, ['sync', 'probe', 'Recorded the upstream blocker.']).output).toContain(
    'WORK_BLOCKED',
  );
  expect(run(root).status).toBe(1);
  expect(invoke(root, ['handoff', 'probe']).status).toBe(0);
});

it('receives a handoff into another member workspace only after retrieving matching code, without inheriting authority or passes', async () => {
  const sender = await fixture('alice');
  const receiver = await fixture('bob');
  await ready(sender);
  expect(run(sender).status).toBe(0);
  const prepared = invoke(sender, ['handoff', 'probe']);
  expect(prepared.status, prepared.output).toBe(0);
  const markdown = await readFile(prepared.output, 'utf8');
  expect(markdown).not.toContain(sender);
  expect(markdown).not.toContain('.work/tasks/');
  await mkdir(join(receiver, '.work/inbox'));
  await writeFile(join(receiver, '.work/inbox/probe.md'), markdown);
  await writeFile(join(receiver, 'src/value.ts'), 'different code');
  expect(invoke(receiver, ['receive', '.work/inbox/probe.md']).output).toContain(
    'WORK_HANDOFF_CODE',
  );
  await expect(readFile(statePath(receiver))).rejects.toThrow();
  await cp(join(sender, 'src/value.ts'), join(receiver, 'src/value.ts'));
  fetchFixtureCommit(receiver, sender);
  expect(invoke(receiver, ['receive', '.work/inbox/probe.md']).status).toBe(0);
  const received = await state(receiver);
  expect(received.member).toBe('bob');
  expect(received.plan.authorization).toBe('');
  expect(received.checkpoint).toBeNull();
  expect(received.evidence).toEqual([]);
  expect(received.notes.join(' ')).toContain('Current checks: pass; basis execution');
  expect(received.notes.join(' ')).toContain('acceptance does not transfer');
  expect(invoke(receiver, ['check', 'probe']).output).toContain('WORK_CONTRACT');
  expect(invoke(receiver, ['receive', '.work/inbox/probe.md']).status).toBe(1);
  await edit(receiver, (task) => {
    task.plan.authorization = 'Receiver user explicitly requests continuation.';
  });
  expect(
    invoke(receiver, [
      'sync',
      'probe',
      'Verified matching code and local authority; checks need rerun.',
    ]).status,
  ).toBe(0);
  expect(run(receiver).status).toBe(0);
  expect(invoke(sender, ['handoff', 'probe']).output).toBe(prepared.output);
});

it('receives a selected public result from records without inheriting authority, acceptance or evidence', async () => {
  const root = await fixture();
  const prd = 'docs/tasks/product/prd.md';
  await mkdir(dirname(join(root, prd)), { recursive: true });
  await writeFile(join(root, prd), '# Capability PRD\n');
  await writeTaskDocuments(root, [{ kind: 'prd', identity: prd, path: prd }]);
  const result = (key: string) => ({
    key,
    title: `Accepted ${key}`,
    outcomes: 'Historical outcome.',
    locations: [{ path: 'src/value.ts', purpose: 'Existing entry.' }],
    verification: 'Prior observation.',
    limitations: 'Historical only.',
    acceptance: {
      candidate: 'a'.repeat(64),
      statement: 'The user accepted the historical result.',
      reference: 'Prior acceptance.',
    },
  });
  const book = {
    version: 5 as const,
    prd,
    results: [result('alpha'), result('beta'), result('gamma')],
  };
  const records = recordsPath(prd);
  const report = 'docs/tasks/product/complete/report.md';
  await mkdir(dirname(join(root, records)), { recursive: true });
  await writeFile(join(root, records), JSON.stringify(book, null, 2) + '\n');
  await expect(readFile(join(root, report))).rejects.toHaveProperty('code', 'ENOENT');
  expect(invoke(root, ['receive', report]).output).toContain('WORK_RESULT_SELECTION');
  const received = invoke(root, ['receive', report, 'alpha']);
  expect(received.status, received.output).toBe(0);
  const id = received.output.match(/Received draft ([^;]+)/)![1]!;
  const task = await state(root, id);
  expect(task.plan.result).toEqual({ prd, key: 'alpha' });
  expect(task.plan.authorization).toBe('');
  expect(task.plan.scope).toEqual([]);
  expect(task.plan.acceptance).toEqual([]);
  expect(task.checkpoint).toBeNull();
  expect(task.evidence).toEqual([]);
  expect(task.reviewDecision).toBe('PENDING');
  expect(task.releaseDisposition).toBe('HOLD_FOR_EVIDENCE');
  expect(invoke(root, ['check', id]).output).toContain('WORK_CONTRACT');
  const current = JSON.parse(invoke(root, ['context', id, 'resume']).output);
  expect(
    invoke(root, ['update', id, '--stdin'], {
      revision: current.revision,
      reason: 'An accepted result cannot be cleared.',
      plan: { result: null },
    }).output,
  ).toContain('WORK_DELIVERY_RESULT');
  expect((await state(root, id)).plan.result).toEqual({ prd, key: 'alpha' });
  await writeFile(join(root, report), 'A stale report with no result metadata.\n');
  const staleReport = invoke(root, ['receive', report, 'beta']);
  expect(staleReport.status, staleReport.output).toBe(0);
  const secondId = staleReport.output.match(/Received draft ([^;]+)/)![1]!;
  const second = await state(root, secondId);
  expect(second.plan.result).toEqual({ prd, key: 'beta' });
  expect(second.plan.authorization).toBe('');
  expect(second.evidence).toEqual([]);
  const beforeCorruption = await readFile(statePath(root, id), 'utf8');
  const secondBeforeCorruption = await readFile(statePath(root, secondId), 'utf8');
  await writeFile(join(root, report), renderBook(book, prd));
  await writeFile(join(root, records), '{broken records');
  const rejected = invoke(root, ['receive', report, 'gamma']);
  expect(rejected.status, rejected.output).toBe(1);
  expect(await readFile(statePath(root, id), 'utf8')).toBe(beforeCorruption);
  expect(await readFile(statePath(root, secondId), 'utf8')).toBe(secondBeforeCorruption);
  expect((await readdir(join(root, '.work/tasks'))).sort()).toEqual([id, secondId].sort());
});

it('does not publish a public result for maintenance', async () => {
  const root = await fixture();
  await ready(root);
  expect(run(root).status).toBe(0);
  expect(invoke(root, ['deliver', 'probe', '--stdin'], { action: 'prepare' }).status).toBe(1);
  expect((await state(root)).plan.result).toBeNull();
  await expect(readFile(join(root, 'docs/tasks/complete/records.json'))).rejects.toHaveProperty(
    'code',
    'ENOENT',
  );
});

it('retains a legacy accepted result binding during an ordinary task update', async () => {
  const root = await fixture();
  await ready(root);
  const prd = 'docs/tasks/product/prd.md';
  await mkdir(dirname(join(root, prd)), { recursive: true });
  await writeFile(join(root, prd), '# Historical PRD\n');
  await writeTaskDocuments(root, [{ kind: 'prd', identity: prd, path: prd }]);
  const historical = { path: 'docs/tasks/product/complete/report.md', candidate: 'a'.repeat(64) };
  await edit(root, (task) => {
    task.plan.result = { prd, key: 'old' };
    task.delivery = { version: 1, accepted: historical };
  });
  const current = await state(root);
  const changed = invoke(root, ['update', 'probe', '--stdin'], {
    revision: taskRevision(current),
    reason: 'Preserve accepted history while changing progress only.',
    plan: { nextAction: 'Inspect the old accepted result.' },
  });
  expect(changed.status, changed.output).toBe(0);
  expect((await state(root)).delivery?.accepted).toEqual(historical);
});

it('rejects corrupt/unknown-version records and damaged handoff data without replacing originals', async () => {
  const root = await fixture();
  await ready(root);
  await edit(root, (task) => {
    (task as { version: number }).version = 2;
  });
  const original = await readFile(statePath(root), 'utf8');
  expect(invoke(root, ['sync', 'probe', 'Attempt unknown version.']).output).toContain(
    'WORK_SCHEMA',
  );
  expect(await readFile(statePath(root), 'utf8')).toBe(original);
  await mkdir(join(root, '.work/inbox'));
  await writeFile(join(root, '.work/inbox/bad.md'), '# No machine handoff\n');
  expect(invoke(root, ['receive', '.work/inbox/bad.md']).output).toContain('WORK_HANDOFF_FORMAT');
});

it('uses the same CLI identity before and after a source move and binds the current document, aliases and registry', async () => {
  const root = await fixture();
  const originalPath = 'docs/tasks/original/prd.md';
  await mkdir(dirname(join(root, originalPath)), { recursive: true });
  await writeFile(join(root, originalPath), '# API\n');
  await writeFile(
    join(root, requirement.source),
    '# 资料已迁移\n\n[当前资料](tasks/original/prd.md)\n',
  );
  let documents: TaskDocument[] = [
    {
      identity: requirement.source,
      kind: 'prd',
      path: originalPath,
      aliases: [requirement.source],
    },
  ];
  await writeTaskDocuments(root, documents);
  commitFixture(root, 'Register the initial source', ['docs']);
  const request = {
    ...proposal(),
    plan: { ...proposal().plan, result: { prd: requirement.source, key: 'value' } },
  };
  const first = JSON.parse(invoke(root, ['ensure', '--stdin'], request).output);
  const id = first.task.id as string;
  expect(run(root, 'console.log("old fixture observation")', id).status).toBe(0);
  const before = await readFile(statePath(root, id), 'utf8');
  await mkdir(join(root, 'docs/tasks/example'), { recursive: true });
  await writeFile(join(root, 'docs/tasks/example/prd.md'), '# API\n');
  await writeFile(
    join(root, 'docs/api.md'),
    '# 资料已迁移\n\n[当前资料](../docs/tasks/example/prd.md)\n',
  );
  await rm(join(root, originalPath));
  documents = [
    {
      identity: requirement.source,
      kind: 'prd',
      path: 'docs/tasks/example/prd.md',
      aliases: [requirement.source],
    },
  ];
  await writeTaskDocuments(root, documents);
  const moved = invoke(root, ['ensure', '--stdin'], {
    ...request,
    requirement: { ...requirement, source: 'docs/tasks/example/prd.md' },
    plan: { result: { ...request.plan.result, prd: 'docs/tasks/example/prd.md' } },
  });
  expect(moved.status, moved.output).toBe(0);
  expect(JSON.parse(moved.output)).toMatchObject({
    created: false,
    task: { id, requirement, result: request.plan.result },
  });
  expect(await readFile(statePath(root, id), 'utf8')).toBe(before);
  const changed = JSON.parse(invoke(root, ['check', id]).output);
  expect(changed.errors.join(' ')).toContain('WORK_CANDIDATE');
  expect(
    changed.evidence.find((item: { criterion: string }) => item.criterion === 'checks').result,
  ).toBe('pending');
  const movedCommit = commitFixture(root, 'Move the registered source', ['docs']);
  expect(invoke(root, ['sync', id, 'Inspected the moved source and stable mapping.']).status).toBe(
    0,
  );
  const current = await state(root, id);
  expect(current.checkpoint!.candidate).toEqual({
    commit: movedCommit,
    contractRevision: current.contractRevision,
  });
  await writeFile(
    join(root, 'docs/tasks/example/prd.md'),
    '# API\n\nChanged actual requirement.\n',
  );
  expect(invoke(root, ['check', id]).output).toContain('WORK_CANDIDATE');
  expect((await state(root, id)).checkpoint).toEqual(current.checkpoint);
  const illegal = invoke(root, ['ensure', '--stdin'], {
    requirement: { ...requirement, key: 'bad-result' },
    plan: { ...proposal().plan, result: { prd: 'docs/coordination.md', key: 'bad' } },
  });
  expect(illegal.output).toContain('WORK_RESULT');
});

it('resumes the same task after retiring its identity redirect and binds only current physical sources', async () => {
  const root = await fixture();
  const path = 'docs/tasks/example/prd.md';
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), '# API\n');
  await writeFile(
    join(root, requirement.source),
    '# 资料已迁移\n\n[当前资料](tasks/example/prd.md)\n',
  );
  const documents: TaskDocument[] = [
    { identity: requirement.source, kind: 'prd', path, aliases: [requirement.source] },
  ];
  await writeTaskDocuments(root, documents);
  commitFixture(root, 'Register the source redirect', ['docs']);
  const request = {
    ...proposal(),
    plan: { ...proposal().plan, result: { prd: requirement.source, key: 'value' } },
  };
  const first = JSON.parse(invoke(root, ['ensure', '--stdin'], request).output);
  const id = first.task.id as string;
  expect(run(root, 'console.log("before redirect retirement")', id).status).toBe(0);
  const before = await readFile(statePath(root, id), 'utf8');
  await rm(join(root, requirement.source));
  documents[0]!.aliases = [];
  await writeTaskDocuments(root, documents);
  const resumed = invoke(root, ['ensure', '--stdin'], {
    ...request,
    requirement: { ...requirement, source: path },
    plan: { result: { ...request.plan.result, prd: path } },
  });
  expect(resumed.status, resumed.output).toBe(0);
  expect(JSON.parse(resumed.output)).toMatchObject({
    created: false,
    task: { id, requirement, result: request.plan.result },
  });
  expect(await readFile(statePath(root, id), 'utf8')).toBe(before);
  const changed = JSON.parse(invoke(root, ['check', id]).output);
  expect(changed.errors.join(' ')).toContain('WORK_CANDIDATE');
  expect(changed.errors.join(' ')).not.toContain('WORK_SOURCE');
  const retiredCommit = commitFixture(root, 'Retire the source redirect', ['docs']);
  expect(
    invoke(root, ['sync', id, 'Inspected removal of an unused physical redirect.']).status,
  ).toBe(0);
  const current = await state(root, id);
  expect(current.checkpoint!.candidate).toEqual({
    commit: retiredCommit,
    contractRevision: current.contractRevision,
  });
  expect(current.evidence).toEqual(JSON.parse(before).evidence);
  expect(JSON.parse(invoke(root, ['check', id]).output).evidence[0].result).toBe('pending');
  await writeFile(join(root, path), '# API\n\nChanged current requirement.\n');
  expect(invoke(root, ['check', id]).output).toContain('WORK_CANDIDATE');
});

it('retrieves classified tasks artifacts and receives an exact-code handoff from a registered task proposal', async () => {
  const sender = await fixture('alice');
  const receiver = await fixture('bob');
  const shared = 'docs/tasks/example/handoff.md';
  for (const root of [sender]) {
    await mkdir(join(root, 'docs/tasks/example'), { recursive: true });
    await writeFile(join(root, 'docs/tasks/example/prd.md'), '# API\n');
    await writeFile(join(root, shared), '# Placeholder outside the candidate inputs.\n');
    await writeFile(
      join(root, 'docs/api.md'),
      '# 资料已迁移\n\n[当前资料](../docs/tasks/example/prd.md)\n',
    );
    const documents: TaskDocument[] = [
      {
        identity: requirement.source,
        kind: 'prd',
        path: 'docs/tasks/example/prd.md',
        aliases: [requirement.source],
      },
      { identity: shared, kind: 'proposal', path: shared },
    ];
    await writeTaskDocuments(root, documents);
  }
  commitFixture(sender, 'Register fixture documents', ['docs']);
  fetchFixtureCommit(receiver, sender);
  const first = invoke(sender, ['ensure', '--stdin'], proposal());
  expect(first.status, first.output).toBe(0);
  const id = JSON.parse(first.output).task.id as string;
  expect(invoke(sender, ['sync', id, 'Reviewed the committed handoff candidate.']).status).toBe(0);
  const portable = invoke(sender, ['handoff', id]);
  expect(portable.status, portable.output).toBe(0);
  const bytes = await readFile(portable.output, 'utf8');
  await writeFile(join(receiver, shared), bytes);
  expect((await artifact(receiver, id, shared)).toString('utf8')).toBe(bytes);
  expect(invoke(receiver, ['receive', shared]).output).toContain('WORK_HANDOFF_CODE');
  await writeFile(join(receiver, shared), '# Placeholder outside the candidate inputs.\n');
  await mkdir(join(receiver, '.work/inbox'), { recursive: true });
  await writeFile(join(receiver, '.work/inbox/task.md'), bytes);
  const received = invoke(receiver, ['receive', '.work/inbox/task.md']);
  expect(received.status, received.output).toBe(0);
  expect((await state(receiver, id)).plan.authorization).toBe('');
  await writeFile(join(receiver, 'docs/tasks/unclassified.md'), '# Unknown');
  await expect(artifact(receiver, id, 'docs/tasks/unclassified.md')).rejects.toThrow('WORK_SOURCE');
  await expect(artifact(receiver, id, 'tasks/outside.md')).rejects.toThrow('WORK_ARTIFACT');
  expect(invoke(receiver, ['receive', 'tasks/outside.md']).output).toContain('WORK_HANDOFF_PATH');
  expect(
    invoke(receiver, ['ensure', '--stdin'], {
      requirement: { ...requirement, source: 'tasks/outside.md' },
      plan: proposal().plan,
    }).output,
  ).toContain('WORK_SOURCE');
  expect(
    invoke(receiver, ['ensure', '--stdin'], {
      requirement: { ...requirement, key: 'invalid-result' },
      plan: { ...proposal().plan, result: { prd: 'tasks/outside.md', key: 'invalid' } },
    }).output,
  ).toContain('WORK_SOURCE');
});

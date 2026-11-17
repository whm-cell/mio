import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { digest } from '../../scripts/harness/work/records.ts';
import type { Candidate } from '../../scripts/harness/work/records.ts';
import {
  check,
  cloneFixture,
  commit,
  create,
  fixture,
  git,
  invoke,
  ok,
  state,
  verifyReady,
} from './fixtures/verification-fixture.ts';

const checks = (root: string, id: string) =>
  check(root, id).evidence.find((entry: { criterion: string }) => entry.criterion === 'checks');

function evidenceDraft(root: string, id: string, criterion: string, language: string) {
  let text = '';
  let args = ['read', id, 'evidence-draft', criterion, '--limit', '256'];
  let paged = false;
  for (;;) {
    const page = JSON.parse(ok(root, args));
    text += page.text;
    if (!page.page.next) break;
    args = page.page.next.argv;
    expect(args.slice(0, 4)).toEqual(['read', id, 'evidence-draft', criterion]);
    paged = true;
  }
  expect(paged).toBe(true);
  const match = text.match(new RegExp('```' + language + '\\n([\\s\\S]*?)```'));
  if (!match) throw new Error('Missing evidence draft block');
  return JSON.parse(match[1]!);
}

async function writeOriginal(root: string, id: string, language: string, report: unknown) {
  const path = `.work/tasks/${id}/evidence/contract-collision.md`;
  await mkdir(join(root, `.work/tasks/${id}/evidence`), { recursive: true });
  await writeFile(join(root, path), `\`\`\`${language}\n${JSON.stringify(report)}\n\`\`\`\n`);
  return path;
}

it('rejects coverage copied between different tasks even when commit and revision coincide', async () => {
  const root = await fixture();
  const a = create(root, 'contract-a');
  const b = create(root, 'contract-b');
  verifyReady(root, a);
  verifyReady(root, b);
  const first = await state(root, a);
  const second = await state(root, b);
  expect(first.checkpoint!.candidate).toEqual(second.checkpoint!.candidate);
  const report = evidenceDraft(root, a, 'checks', 'mio-coverage');
  expect(report).toMatchObject({
    candidate: first.checkpoint!.candidate,
    result: 'pending',
    executionCount: 0,
  });
  const pathA = await writeOriginal(root, a, 'mio-coverage', { ...report, result: 'pass' });
  expect(invoke(root, ['evidence', a, 'checks', pathA, 'Incomplete draft.']).status).toBe(1);
  Object.assign(report, {
    reviewer: 'Fixture reviewer',
    source: 'Reviewed fixture source',
    scope: 'Entire fixture check',
    environment: 'Isolated fixture',
    uncovered: 'None',
    assessment: 'Fixture coverage reviewed.',
    result: 'pass',
  });
  const oldReport = { ...report };
  delete oldReport.contract;
  await writeOriginal(root, a, 'mio-coverage', oldReport);
  expect(
    invoke(root, ['evidence', a, 'checks', pathA, 'Original without contract.']).output,
  ).toContain('WORK_EVIDENCE_CONTRACT');
  await writeOriginal(root, a, 'mio-coverage', report);
  ok(root, ['evidence', a, 'checks', pathA, 'Reviewed fixture coverage.']);
  expect(checks(root, a).result).toBe('pass');
  const pathB = await writeOriginal(root, b, 'mio-coverage', report);
  expect(
    invoke(root, ['evidence', b, 'checks', pathB, 'Attempt reused observation.']).output,
  ).toContain('WORK_EVIDENCE_CONTRACT');
  const forged = await state(root, b);
  const original = (await state(root, a)).evidence.at(-1)!;
  forged.evidence.push({ ...original, artifact: pathB });
  await writeFile(join(root, `.work/tasks/${b}/state.json`), JSON.stringify(forged));
  expect(checks(root, b).result).toBe('invalid');
}, 30000);

it('rejects a manual original from a different contract at the same task id and revision', async () => {
  const a = await fixture();
  const b = await cloneFixture(a);
  const id = create(a, 'same-task');
  expect(create(b, 'same-task')).toBe(id);
  for (const [root, goal] of [
    [a, 'First contract'],
    [b, 'Second contract'],
  ] as const) {
    const task = await state(root, id);
    ok(root, ['update', id, '--stdin'], {
      revision: task.revision,
      reason: 'Define the local observed behavior.',
      plan: {
        goal,
        acceptance: [
          ...task.plan.acceptance,
          { id: 'observed', criterion: 'Review behavior.', method: 'behavior' },
        ],
      },
    });
    verifyReady(root, id);
  }
  const first = await state(a, id);
  const second = await state(b, id);
  expect(first.checkpoint!.candidate).toEqual(second.checkpoint!.candidate);
  expect(first.contractRevision).toBe(1);
  const report = evidenceDraft(a, id, 'observed', 'mio-evidence');
  const pathA = await writeOriginal(a, id, 'mio-evidence', { ...report, result: 'pass' });
  expect(invoke(a, ['evidence', id, 'observed', pathA, 'Incomplete observation.']).status).toBe(1);
  report.observation = 'Inspected the fixture behavior.';
  report.result = 'pass';
  report.contract = Object.fromEntries(Object.entries(report.contract).reverse());
  await writeOriginal(a, id, 'mio-evidence', report);
  ok(a, ['evidence', id, 'observed', pathA, 'Reviewed behavior.']);
  const pathB = await writeOriginal(b, id, 'mio-evidence', report);
  expect(
    invoke(b, ['evidence', id, 'observed', pathB, 'Attempt reused observation.']).output,
  ).toContain('WORK_EVIDENCE_CONTRACT');
  const forged = await state(b, id);
  forged.evidence.push({ ...(await state(a, id)).evidence.at(-1)!, artifact: pathB });
  await writeFile(join(b, `.work/tasks/${id}/state.json`), JSON.stringify(forged));
  expect(
    check(b, id).evidence.find((entry: { criterion: string }) => entry.criterion === 'observed')
      .result,
  ).toBe('invalid');
}, 30000);

it('allows dirty implementation but refuses to sync or collect formal evidence', async () => {
  const root = await fixture();
  await writeFile(join(root, 'new-untracked.txt'), 'unfinished\n');
  const id = create(root);
  const implementation = JSON.parse(ok(root, ['context', id, 'implement']));
  expect(implementation.task.stage).toBe('C1_IMPLEMENTATION');
  expect(implementation.assessment.git.dirty).toBe(true);
  expect(implementation.assessment.candidate).toBeNull();
  expect(invoke(root, ['sync', id, 'Inspect dirty changes.']).output).toContain('WORK_CANDIDATE');
  git(root, ['add', 'new-untracked.txt']);
  expect(invoke(root, ['sync', id, 'Inspect staged changes.']).output).toContain('WORK_CANDIDATE');
  const context = JSON.parse(ok(root, ['context', id, 'verify']));
  ok(root, ['update', id, '--stdin'], {
    revision: context.revision,
    reason: 'Fixture attempts evidence on a dirty tree.',
    stage: 'C1_EVIDENCE_PENDING',
    plan: { nextAction: 'Attempt checks.' },
  });
  expect(invoke(root, ['run', id, 'checks']).output).toContain('WORK_CANDIDATE');
  expect((await state(root, id)).evidence).toEqual([]);
});

it('rejects private C1 scope or inputs without saving, while allowing a planned new file', async () => {
  const root = await fixture();
  await writeFile(join(root, 'new-untracked.txt'), 'unfinished\n');
  const id = create(root);
  const path = join(root, `.work/tasks/${id}/state.json`);
  const before = await readFile(path, 'utf8');
  const revision = (await state(root, id)).revision;
  for (const plan of [{ scope: ['.work'] }, { inputs: ['.work'] }]) {
    const result = invoke(root, ['update', id, '--stdin'], {
      revision,
      reason: 'Attempt a private implementation boundary.',
      stage: 'C1_IMPLEMENTATION',
      plan: { ...plan, nextAction: 'Continue implementation.' },
    });
    expect(result.output).toContain('WORK_PRIVATE');
    expect(await readFile(path, 'utf8')).toBe(before);
    expect((await state(root, id)).revision).toBe(revision);
  }
  const allowed = invoke(root, ['update', id, '--stdin'], {
    revision,
    reason: 'Declare a planned public source.',
    stage: 'C1_IMPLEMENTATION',
    plan: { scope: ['src/planned.ts'], nextAction: 'Implement the planned file.' },
  });
  expect(allowed.status, allowed.output).toBe(0);
});

it('does not bind an ignored declared source that is absent from the clean commit', async () => {
  const root = await fixture();
  await writeFile(join(root, '.gitignore'), '.work/\ndocs/ignored.md\n');
  commit(root, 'Ignore a fixture document');
  await writeFile(join(root, 'docs/ignored.md'), '# Ignored\n');
  const id = create(root);
  const current = JSON.parse(ok(root, ['context', id, 'implement']));
  expect(current.assessment.git.dirty).toBe(false);
  ok(root, ['update', id, '--stdin'], {
    revision: current.revision,
    reason: 'Declare a source that exists only in the worktree.',
    plan: { sources: ['docs/api.md', 'docs/ignored.md'] },
  });
  expect(invoke(root, ['sync', id, 'Attempt to bind the ignored source.']).output).toContain(
    'WORK_INPUT_UNCOMMITTED: docs/ignored.md',
  );
  expect((await state(root, id)).checkpoint).toBeNull();
});

it('keeps historical strings and originals without treating an old head as a current candidate', async () => {
  const root = await fixture();
  const id = create(root);
  verifyReady(root, id);
  ok(root, ['run', id, 'checks']);
  const task = await state(root, id);
  const original = task.evidence.at(-1)!;
  const bytes = await readFile(join(root, original.artifact));
  const historical = 'a'.repeat(64);
  task.checkpoint = { candidate: historical, head: git(root, ['rev-parse', 'HEAD']) };
  task.evidence = task.evidence.map((entry) => ({ ...entry, candidate: historical }));
  await writeFile(join(root, `.work/tasks/${id}/state.json`), JSON.stringify(task));
  expect(checks(root, id).result).toBe('pending');
  ok(root, ['sync', id, 'Bind the clean commit as a new candidate.']);
  const current = await state(root, id);
  expect(current.checkpoint?.candidate).toEqual({
    commit: git(root, ['rev-parse', 'HEAD']),
    contractRevision: current.contractRevision,
  });
  expect(current.evidence.every((entry) => entry.candidate === historical)).toBe(true);
  expect(await readFile(join(root, original.artifact))).toEqual(bytes);
  expect(checks(root, id).result).toBe('pending');
});

it('does not revive evidence after a contract changes from A to B and back to A', async () => {
  const root = await fixture();
  const id = create(root);
  verifyReady(root, id);
  ok(root, ['run', id, 'checks']);
  expect(checks(root, id).result).toBe('pass');
  const before = await state(root, id);
  const originalGoal = before.plan.goal;
  for (const goal of ['Different agreed goal', originalGoal]) {
    const context = JSON.parse(ok(root, ['context', id, 'resume']));
    ok(root, ['update', id, '--stdin'], {
      revision: context.revision,
      reason: 'Change the fixture contract.',
      plan: { goal },
    });
    ok(root, ['sync', id, 'Bind the changed contract to the clean commit.']);
  }
  const after = await state(root, id);
  expect(after.contractRevision).toBe((before.contractRevision ?? 0) + 2);
  expect(after.evidence).toEqual(before.evidence);
  expect(checks(root, id).result).toBe('pending');
});

it('keeps failures despite later passing supplements until a new complete execution', async () => {
  const root = await fixture();
  const id = create(root);
  verifyReady(root, id);
  ok(root, ['run', id, 'checks']);
  expect(checks(root, id).result).toBe('pass');
  expect(
    invoke(root, ['run', id, 'checks', '--', process.execPath, '-e', 'process.exit(4)']).status,
  ).toBe(1);
  ok(root, ['run', id, 'checks', '--', process.execPath, '-e', 'process.exit(0)']);
  expect(checks(root, id).result).toBe('fail');
  const before = await state(root, id);
  ok(root, ['run', id, 'checks']);
  expect(checks(root, id).result).toBe('pass');
  expect((await state(root, id)).evidence.slice(0, before.evidence.length)).toEqual(
    before.evidence,
  );
});

it.each(['dirty', 'head'])(
  'keeps an otherwise successful execution pending after persistent %s drift',
  async (kind) => {
    const root = await fixture();
    const id = create(root);
    verifyReady(root, id);
    const head = git(root, ['rev-parse', 'HEAD']);
    ok(root, ['run', id, 'checks']);
    const script =
      kind === 'dirty'
        ? 'require("node:fs").writeFileSync("src/value.ts","export const value = 2;\\n")'
        : 'require("node:child_process").execFileSync("git",["commit","--allow-empty","-qm","moved"])';
    expect(invoke(root, ['run', id, 'checks', '--', process.execPath, '-e', script]).status).toBe(
      1,
    );
    const observation = (await state(root, id)).evidence.at(-1)!;
    expect(observation.result).toBe('pending');
    const log = await readFile(join(root, observation.artifact));
    expect(digest(log)).toBe(observation.sha256);
    expect(log.toString()).toContain('"contextChanged": true');
    if (kind === 'dirty') git(root, ['restore', 'src/value.ts']);
    else git(root, ['checkout', '-q', '--detach', head]);
    expect(checks(root, id).result).toBe('pending');
  },
);

it('records the actual command, contract, environment and settled outcome', async () => {
  const root = await fixture();
  const id = create(root);
  verifyReady(root, id);
  ok(root, ['run', id, 'checks', '--stdin'], {
    conditions: { dependencies: 'Node builtins', configuration: 'fixture', external: 'none' },
  });
  const task = await state(root, id);
  const entry = task.evidence.at(-1)!;
  const log = await readFile(join(root, entry.artifact), 'utf8');
  const end = log.indexOf('\n}\n');
  const header = JSON.parse(log.slice(0, end + 2));
  expect(header.candidate).toEqual(task.checkpoint!.candidate as Candidate);
  expect(header.contract.goal).toBe(task.plan.goal);
  expect(header.environment.conditions.external).toBe('none');
  expect(log).toContain('"exitCode": 0');
  expect(log).toContain('"cancelled": false');
  expect(checks(root, id)).toMatchObject({ result: 'pass', basis: 'execution', executionCount: 1 });
});

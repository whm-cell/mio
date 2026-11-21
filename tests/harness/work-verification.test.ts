import { spawnSync } from 'node:child_process';
import { link, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { resultMarker } from '../../scripts/harness/work/evidence.ts';
import { contractPlan, digest, json } from '../../scripts/harness/work/records.ts';
import type { Candidate } from '../../scripts/harness/work/records.ts';
import { writeTaskDocuments } from './fixtures/task-documents-fixture.ts';
import {
  check,
  cloneFixture,
  commit,
  create,
  fixture,
  fullCommand,
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

it('preserves the first declared input error between Git and local checks', async () => {
  const root = await fixture();
  const ignored = 'docs/ignored.md';
  await writeFile(join(root, '.gitignore'), `.work/\n${ignored}\n`);
  commit(root, 'Ignore the candidate-only fixture path');
  await writeFile(join(root, ignored), '# Worktree file\n');
  const id = create(root);
  const task = await state(root, id);
  for (const [local, diagnostic] of [
    ['docs/missing.md', 'WORK_INPUT_MISSING: docs/missing.md'],
    ['.work/private.md', 'WORK_PRIVATE: .work/private.md'],
    ['docs/tasks/fixture/complete/records.json#result=', 'WORK_REPORT_SELECTOR:'],
  ] as const) {
    for (const [sources, first] of [
      [[ignored, local], `WORK_INPUT_UNCOMMITTED: ${ignored}`],
      [[local, ignored], diagnostic],
    ] as const) {
      // Set a malformed local fixture directly to exercise sync's first failing declaration.
      task.plan.sources = [...sources];
      await writeFile(join(root, `.work/tasks/${id}/state.json`), JSON.stringify(task));
      const result = invoke(root, ['sync', id, 'Check declaration order.']);
      expect(result.status, result.output).toBe(1);
      expect(result.output.startsWith(first), result.output).toBe(true);
    }
  }
  expect((await state(root, id)).checkpoint).toBeNull();
});

it('binds a directory and input names containing whitespace to the same clean commit', async () => {
  const root = await fixture();
  const paths = [
    'src/file with spaces.ts',
    ...(process.platform === 'win32' ? [] : ['src/file with a newline\n.ts']),
  ];
  for (const path of paths) await writeFile(join(root, path), 'export const fixture = true;\n');
  const commitId = commit(root, 'Add whitespace paths');
  const id = create(root);
  const task = await state(root, id);
  ok(root, ['update', id, '--stdin'], {
    revision: task.revision,
    reason: 'Declare committed files and directories.',
    plan: { inputs: [...paths, 'src', '.'] },
  });
  ok(root, ['sync', id, 'Bind the declared paths to the candidate.']);
  expect((await state(root, id)).checkpoint?.candidate).toMatchObject({ commit: commitId });
});

it.skipIf(process.platform === 'win32')(
  'rejects an earlier uncommitted source before opening a later result selector',
  async () => {
    const root = await fixture();
    const ignored = 'docs/ignored.md';
    const prd = 'docs/tasks/product/prd.md';
    const records = 'docs/tasks/product/complete/records.json';
    await writeFile(join(root, '.gitignore'), `.work/\n${ignored}\n${records}\n`);
    await writeTaskDocuments(root, [{ kind: 'prd', identity: prd, path: prd }]);
    await writeFile(join(root, prd), '# Fixture PRD\n');
    commit(root, 'Register a result fixture with ignored observations');
    await writeFile(join(root, ignored), '# Ignored\n');
    await mkdir(dirname(join(root, records)), { recursive: true });
    await writeFile(
      join(root, records),
      JSON.stringify({
        version: 5,
        prd,
        results: [
          {
            key: 'fixture',
            title: 'Fixture',
            outcomes: 'Fixture.',
            locations: [{ path: prd, purpose: 'Fixture requirement.' }],
            verification: 'Fixture.',
            limitations: 'Synthetic.',
            acceptance: { candidate: 'history', statement: 'Synthetic.', reference: 'Fixture.' },
          },
        ],
      }),
    );
    const id = create(root);
    const task = await state(root, id);
    ok(root, ['update', id, '--stdin'], {
      revision: task.revision,
      reason: 'Declare a later result input.',
      plan: { sources: [ignored], inputs: [`${records}#result=fixture`] },
    });
    expect(git(root, ['status', '--porcelain', '-z', '--untracked-files=all'])).toBe('');
    await rm(join(root, records));
    expect(spawnSync('mkfifo', [records], { cwd: root }).status).toBe(0);
    const result = spawnSync(
      process.execPath,
      [resolve('scripts/harness/work/cli.ts'), 'sync', id, 'Check the earlier source.'],
      { cwd: root, encoding: 'utf8', timeout: 2000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr.trim()).toBe(`WORK_INPUT_UNCOMMITTED: ${ignored}`);
    expect((await state(root, id)).checkpoint).toBeNull();
  },
);

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

it('verifies large command frames and reads codepoints across chunk boundaries', async () => {
  const root = await fixture();
  const id = create(root);
  verifyReady(root, id);
  ok(root, ['run', id, 'checks']);
  const task = await state(root, id);
  const entry = task.evidence.at(-1)!;
  const target = join(root, entry.artifact);
  const ledger = join(root, '.work/tasks', id, 'state.json');
  const chunk = 64 * 1024;
  const header = {
    candidate: entry.candidate,
    contract: contractPlan(task),
    argv: fullCommand,
    detail: '',
  };
  const emptyHeaderEnd = Buffer.byteLength(json(header)) - 3;
  header.detail = 'h'.repeat(2 * chunk - 1 - emptyHeaderEnd);
  const beforeOutput = json(header) + resultMarker + json({ exitCode: 7 });
  const prefix = beforeOutput.padEnd(3 * chunk - 1, 'a');
  const beforeResult = (prefix + '𠮷汉').padEnd(4 * chunk - 6, 'b');
  const original =
    beforeResult + resultMarker + json({ exitCode: 0, signal: null, detail: '尾'.repeat(chunk) });
  entry.sha256 = digest(original);
  await writeFile(target, original);
  await writeFile(ledger, json(task));

  expect(checks(root, id)).toMatchObject({ result: 'pass', basis: 'execution', executionCount: 1 });
  const read = ['read', id, 'evidence', '0'];
  const page = JSON.parse(ok(root, [...read, '--offset', String(prefix.length), '--limit', '2']));
  expect(page).toMatchObject({
    integrity: 'verified',
    actualSha256: entry.sha256,
    text: '𠮷汉',
    page: { total: [...original].length, offset: prefix.length, count: 2 },
  });
  expect(JSON.parse(ok(root, page.page.next.argv)).text).toBe('bb');
  expect(JSON.parse(ok(root, [...read, '--select', '/entry/sha256'])).text).toBe(entry.sha256);

  const damaged = Buffer.from(original);
  damaged[Buffer.byteLength(prefix) - 1] = 'z'.charCodeAt(0);
  await writeFile(target, damaged);
  expect(checks(root, id).result).toBe('corrupt');
  expect(JSON.parse(ok(root, [...read, '--limit', '2']))).toMatchObject({
    integrity: 'mismatch',
    text: '{\n',
  });

  damaged[Buffer.byteLength(prefix) + 1] = 0xff;
  await writeFile(target, damaged);
  for (const options of [[], ['--select', '/entry']]) {
    const invalid = invoke(root, [...read, ...options]);
    expect(invalid.status).toBe(1);
    expect(invalid.output).toContain('WORK_READ_ENCODING');
  }
});

it('distinguishes missing, malformed and unfinalized command originals', async () => {
  const root = await fixture();
  const id = create(root);
  verifyReady(root, id);
  ok(root, ['run', id, 'checks']);
  const task = await state(root, id);
  const entry = task.evidence.at(-1)!;
  const target = join(root, entry.artifact);
  const ledger = join(root, '.work/tasks', id, 'state.json');
  const original = await readFile(target, 'utf8');
  const read = ['read', id, 'evidence', '0'];

  const marker = original.lastIndexOf(resultMarker);
  const incomplete = original.slice(0, marker);
  const longOutput = 'x'.repeat(256 * 1024);
  for (const malformed of [
    original + resultMarker + '{',
    'Missing header\n' + original.slice(marker),
    incomplete,
    incomplete + resultMarker + 'Unframed output' + longOutput,
    incomplete + resultMarker + '{"unexpected":?' + longOutput,
    incomplete + resultMarker + '{"detail":"' + longOutput,
    '{\n"unexpected":?' + longOutput + '\n}\n' + original.slice(marker),
  ]) {
    await writeFile(target, malformed);
    entry.sha256 = digest(malformed);
    await writeFile(ledger, json(task));
    expect(checks(root, id).result).toBe('invalid');
  }

  await rm(target);
  expect(checks(root, id).result).toBe('missing');
  expect(invoke(root, read).output).toContain('ENOENT');

  const alias = join(dirname(target), 'aliased.log');
  await writeFile(alias, original);
  await symlink(alias, target);
  expect(checks(root, id).result).toBe('missing');
  expect(invoke(root, read).output).toContain('WORK_SYMLINK');
  await rm(target);
  await link(alias, target);
  expect(checks(root, id).result).toBe('missing');
  expect(invoke(root, read).output).toContain('WORK_ARTIFACT');
  await rm(target);

  await writeFile(target, incomplete);
  entry.result = 'pending';
  delete entry.sha256;
  await writeFile(ledger, json(task));
  expect(checks(root, id).result).toBe('pending');
  expect(JSON.parse(ok(root, read))).toMatchObject({ integrity: 'pending', actualSha256: null });
});

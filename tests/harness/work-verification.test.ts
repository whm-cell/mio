import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { matchingEvidence } from '../../scripts/harness/work/reports.ts';
import { observe } from '../../scripts/harness/work/verification-proof.ts';
import { refKey } from '../../scripts/harness/work/verification-format.ts';
import {
  check,
  create,
  fixture,
  fullCommand,
  inspect,
  invoke,
  ok,
  record,
  ref,
  run,
  state,
} from './fixtures/verification-fixture.ts';

const scratch: string[] = [];
async function setup() {
  const root = await fixture();
  scratch.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('runs once for four different tasks and uses the same resolver for assessment and delivery', async () => {
  const root = await setup();
  const ids = Array.from({ length: 4 }, (_, i) => create(root, `task-${i}`));
  const baseline = await run(root, ids[0]!);
  expect(baseline.status, baseline.output).toBe(0);
  for (const id of ids.slice(1)) {
    const reused = record(root, id, baseline.ref);
    expect(reused.status, reused.output).toBe(0);
    expect(check(root, id)).toMatchObject({ result: 'pass', basis: 'reuse' });
    const task = await state(root, id);
    await observe(root, ref(id, task.evidence.at(-1)!));
    expect(await matchingEvidence(root, task, task.checkpoint!.candidate)).toHaveLength(1);
  }
  expect(await readFile(join(root, '.work/count'), 'utf8')).toBe('full\n');
});

it('composes two successive local changes without running the full command again', async () => {
  const root = await setup();
  const id = create(root);
  let baseline = (await run(root, id)).ref;
  for (const value of [2, 3]) {
    await writeFile(join(root, 'src/value.ts'), `export const value = ${value};\n`);
    ok(root, ['sync', id, 'Reviewed the changed value and its only consumer.']);
    const rerun = await run(
      root,
      id,
      `if(!require('node:fs').readFileSync('src/value.ts','utf8').includes('= ${value}'))process.exit(1)`,
    );
    const result = record(root, id, baseline, {
      mode: 'incremental',
      runs: [rerun.ref],
      impact: [
        {
          path: 'src/value.ts',
          disposition: 'retest',
          reason: 'Only exported value changes; verify its consumer.',
          runs: [rerun.ref],
        },
      ],
    });
    expect(result.status, result.output).toBe(0);
    expect(check(root, id).result).toBe('pass');
    baseline = ref(id, (await state(root, id)).evidence.at(-1)!);
  }
  expect(await readFile(join(root, '.work/count'), 'utf8')).toBe('full\n');
});

it.each([
  ['same task', 'none'],
  ['another task', 'none'],
  ['another task', 'source failure'],
  ['another task', 'damaged original'],
])('uses scoped receipts across unrelated changes (%s, %s)', async (owner, damage) => {
  const root = await setup();
  const source = create(root);
  const baseline = await run(root, source);
  expect(baseline.status, baseline.output).toBe(0);
  const script = "require('node:fs').appendFileSync('.work/count','probe\\n')";
  const command = [process.execPath, '-e', script];
  const original = await run(root, source, script);
  expect(original.status, original.output).toBe(0);
  const bytes = await readFile(join(root, (await state(root, source)).evidence.at(-1)!.artifact));
  const scoped = owner === 'same task' ? source : create(root, 'scoped', command);
  const criterion = owner === 'same task' ? 'scoped' : 'checks';
  if (owner === 'same task') {
    const current = JSON.parse(ok(root, ['context', source, 'resume']));
    ok(root, ['update', source, '--stdin'], {
      revision: current.revision,
      reason: 'Declare the actual supplemental command without narrowing full checks.',
      plan: {
        acceptance: [
          {
            id: 'checks',
            method: 'automated',
            criterion: 'Full fixture check',
            command: fullCommand,
          },
          { id: criterion, method: 'automated', criterion: 'Focused fixture check', command },
        ],
      },
    });
  }
  await writeFile(join(root, 'src/stable.ts'), 'export const stable = false;\n');
  for (const id of new Set([source, scoped]))
    ok(root, ['sync', id, 'Reviewed an unrelated stable input; the focused command is unchanged.']);
  const retained = record(
    root,
    scoped,
    original.ref,
    {
      mode: 'incremental',
      impact: [
        {
          path: 'src/stable.ts',
          disposition: 'retain',
          reason: 'The focused command reads Node builtins and its counter only.',
          runs: [],
        },
      ],
    },
    criterion,
  );
  expect(retained.status, retained.output).toBe(0);
  const scopedRef = ref(scoped, (await state(root, scoped)).evidence.at(-1)!);
  const combined = record(root, source, baseline.ref, {
    mode: 'incremental',
    runs: [scopedRef],
    impact: [
      {
        path: 'src/stable.ts',
        disposition: 'retest',
        reason: 'The current scoped receipt retains the actual focused observation.',
        runs: [scopedRef],
      },
    ],
  });
  expect(combined.status, combined.output).toBe(0);
  expect(check(root, source)).toMatchObject({ result: 'pass', basis: 'incremental' });
  expect(JSON.parse(ok(root, ['context', source, 'resume'])).assessment.evidence[0].result).toBe(
    'pass',
  );
  const task = await state(root, source);
  await matchingEvidence(root, task, task.checkpoint!.candidate);
  expect(task.evidence.at(-1)!.summary).toContain('1 supplemental observations');
  expect(await readFile(join(root, '.work/count'), 'utf8')).toBe('full\nprobe\n');
  const originalEntry = task.evidence.find((entry) => entry.sha256 === original.ref.sha256)!;
  expect(await readFile(join(root, originalEntry.artifact))).toEqual(bytes);
  if (damage === 'source failure') await run(root, scoped, 'process.exit(1)');
  if (damage === 'damaged original') await writeFile(join(root, originalEntry.artifact), 'damaged');
  if (damage !== 'none') {
    expect(check(root, source).result).not.toBe('pass');
    await expect(matchingEvidence(root, task, task.checkpoint!.candidate)).rejects.toThrow(
      'WORK_DELIVERY_EVIDENCE',
    );
  }
});

it.each(['modify', 'add', 'delete'])(
  'rejects omitted %s inputs and direct reuse after drift',
  async (change) => {
    const root = await setup();
    const id = create(root);
    const baseline = (await run(root, id)).ref;
    if (change === 'delete') await rm(join(root, 'src/value.ts'));
    else
      await writeFile(
        join(root, change === 'add' ? 'src/new.ts' : 'src/value.ts'),
        'export const value = 2;',
      );
    ok(root, ['sync', id, 'Reviewed input delta.']);
    expect(record(root, id, baseline).output).toContain('WORK_VERIFY_INPUTS');
    expect(record(root, id, baseline, { mode: 'incremental' }).output).toContain(
      'WORK_VERIFY_COVERAGE',
    );
  },
);

it('keeps failures until an explicit reviewed resolution binds an actual rerun', async () => {
  const root = await setup();
  const id = create(root);
  const baseline = (await run(root, id)).ref;
  const failure = await run(root, id, 'process.exit(2)');
  const recovery = await run(root, id, 'console.log("recovered")');
  expect(check(root, id).result).toBe('fail');
  expect(record(root, id, baseline).output).toContain('WORK_VERIFY_ISSUES');
  const result = record(root, id, baseline, {
    mode: 'incremental',
    runs: [recovery.ref],
    resolves: [
      {
        issue: failure.ref,
        reason: 'Reproduced transient fixture failure and verified the repaired boundary.',
        runs: [recovery.ref],
      },
    ],
  });
  expect(result.status, result.output).toBe(0);
  expect(check(root, id).result).toBe('pass');
  expect((await state(root, id)).evidence.map((entry) => entry.result)).toEqual([
    'pass',
    'fail',
    'pass',
    'pass',
  ]);
});

it('revokes reused conclusions when a source records a later failure', async () => {
  const root = await setup();
  const source = create(root);
  const target = create(root, 'target');
  const baseline = (await run(root, source)).ref;
  expect(record(root, target, baseline).status).toBe(0);
  await run(root, source, 'process.exit(3)');
  expect(check(root, target).result).not.toBe('pass');
  const task = await state(root, target);
  await expect(matchingEvidence(root, task, task.checkpoint!.candidate)).rejects.toThrow(
    'WORK_DELIVERY_EVIDENCE',
  );
});

it.each(['missing', 'corrupt'])('rejects %s originals after registration', async (damage) => {
  const root = await setup();
  const source = create(root);
  const target = create(root, 'target');
  const baseline = (await run(root, source)).ref;
  expect(record(root, target, baseline).status).toBe(0);
  const original = (await state(root, source)).evidence[0]!;
  if (damage === 'missing') await rm(join(root, original.artifact));
  else await writeFile(join(root, original.artifact), 'changed original');
  expect(check(root, target).result).not.toBe('pass');
});

it('requires a matching environment, unchanged request revision and exclusive target writer', async () => {
  const root = await setup();
  const source = create(root);
  const target = create(root, 'target');
  const baseline = (await run(root, source)).ref;
  expect(
    record(root, target, baseline, {
      environment: { identity: 'other runtime', reason: 'Not comparable' },
    }).output,
  ).toContain('WORK_VERIFY_ENVIRONMENT');
  expect(record(root, target, baseline, { revision: 'stale' }).output).toContain(
    'WORK_VERIFY_STALE',
  );
  await writeFile(join(root, `.work/tasks/${target}.command.json`), '{"pid":0,"command":"run"}');
  expect(inspect(root, target, baseline).changed).toEqual([]);
  expect(record(root, target, baseline).output).toContain('WORK_BUSY');
});

it('rejects a supplemental-only baseline and a changed declared command', async () => {
  const root = await setup();
  const source = create(root);
  const target = create(root, 'target');
  const partial = (await run(root, source, 'console.log("partial")')).ref;
  expect(record(root, target, partial).output).toContain('WORK_VERIFY_COMMAND');
  const baseline = (await run(root, source)).ref;
  const current = JSON.parse(ok(root, ['context', target, 'resume']));
  ok(root, ['update', target, '--stdin'], {
    revision: current.revision,
    reason: 'Fixture changes the required check',
    plan: {
      acceptance: [
        {
          id: 'checks',
          method: 'automated',
          criterion: 'Different required check',
          command: [process.execPath, '-e', 'console.log("different")'],
        },
      ],
    },
  });
  ok(root, ['sync', target, 'Reviewed required command change']);
  expect(record(root, target, baseline).output).toContain('WORK_VERIFY_COMMAND');
});

it('retains read-only inspect and fails closed for cycles and active source writers', async () => {
  const root = await setup();
  const source = create(root);
  const target = create(root, 'target');
  const baseline = (await run(root, source)).ref;
  const before = JSON.stringify(await state(root, target));
  inspect(root, target, baseline);
  expect(JSON.stringify(await state(root, target))).toBe(before);
  await expect(observe(root, baseline, undefined, new Set([refKey(baseline)]))).rejects.toThrow(
    'WORK_VERIFY_CYCLE',
  );
  await writeFile(join(root, `.work/tasks/${source}.command.json`), '{"pid":0,"command":"run"}');
  expect(record(root, target, baseline).output).toContain('WORK_VERIFY_BUSY');
});

it('requires a new reviewed conclusion after candidate changes', async () => {
  const root = await setup();
  const id = create(root);
  const baseline = (await run(root, id)).ref;
  expect(record(root, id, baseline).status).toBe(0);
  await writeFile(join(root, 'src/value.ts'), 'export const value = 4;');
  ok(root, ['sync', id, 'Reviewed new input']);
  expect(check(root, id).result).toBe('pending');
  expect(
    invoke(root, ['verify', id, 'checks', '--stdin'], { action: 'record', baseline }).status,
  ).toBe(1);
});

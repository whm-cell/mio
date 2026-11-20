import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { withTaskCommand } from '../../scripts/harness/work/command.ts';
import type { Task } from '../../scripts/harness/work/records.ts';
import { digest, taskRevision } from '../../scripts/harness/work/records.ts';
import {
  accept,
  begin,
  commands,
  commitFixture,
  edit,
  fixture,
  implementing,
  invoke,
  proposal,
  ready,
  run,
  state,
  statePath,
  verifying,
} from './fixtures/work-cli-fixture.ts';

it.each(['checks', 'verification'])(
  'keeps the full %s failure after a successful partial probe',
  async (criterion) => {
    const root = await fixture();
    await ready(root);
    const command = [process.execPath, '-e', 'process.exit(1)'];
    const revision = JSON.parse(invoke(root, ['context', 'probe', 'resume']).output).revision;
    expect(
      invoke(root, ['update', 'probe', '--stdin'], {
        revision,
        reason: 'Declare the complete check, independent of its criterion name.',
        plan: {
          acceptance: [
            {
              id: criterion,
              method: 'automated',
              criterion: 'The complete check must pass.',
              command,
            },
          ],
        },
      }).status,
    ).toBe(0);
    expect(invoke(root, ['sync', 'probe', 'Inspected the complete check contract.']).status).toBe(
      0,
    );
    verifying(root);
    expect(invoke(root, ['run', 'probe', criterion, '--', ...command]).status).toBe(1);
    expect((await state(root)).plan.nextAction).toBe(
      `Review ${criterion} (fail), current originals and remaining gaps; The task declares no development result; return verified maintenance and archive when appropriate.`,
    );
    expect(invoke(root, ['run', 'probe', criterion, '--', process.execPath, '-e', '']).status).toBe(
      0,
    );
    expect((await state(root)).plan.nextAction).toBe(
      'Review the supplemental observation and the declared complete check; a passing probe cannot replace complete verification or clear failures.',
    );
    const result = JSON.parse(invoke(root, ['check', 'probe']).output);
    expect(
      result.evidence.find((entry: { criterion: string }) => entry.criterion === criterion).result,
    ).toBe('fail');
    expect((await state(root)).evidence.map((entry) => entry.result)).toEqual(['fail', 'pass']);
  },
);

it('requires a complete check and retains a failed supplement until a new complete check', async () => {
  const root = await fixture();
  await ready(root);
  expect(run(root, '').status).toBe(0);
  const result = () => JSON.parse(invoke(root, ['check', 'probe']).output).evidence[0].result;
  expect(result()).toBe('pending');
  expect(invoke(root, ['run', 'probe', 'checks']).status).toBe(0);
  expect(result()).toBe('pass');
  expect(run(root, 'process.exit(3)').status).toBe(1);
  expect(run(root, '').status).toBe(0);
  expect(result()).toBe('fail');
  const originals = (await state(root)).evidence;
  expect(invoke(root, ['run', 'probe', 'checks']).status).toBe(0);
  expect(result()).toBe('pass');
  expect((await state(root)).evidence.slice(0, originals.length)).toEqual(originals);
});

it.each(['missing', 'corrupt'])(
  'does not conceal a %s complete original with a passing supplement',
  async (damage) => {
    const root = await fixture();
    await ready(root);
    expect(run(root).status).toBe(0);
    expect(run(root).status).toBe(0);
    expect(run(root, '').status).toBe(0);
    const path = join(root, (await state(root)).evidence[1]!.artifact);
    if (damage === 'missing') await rm(path);
    else await writeFile(path, 'damaged complete original');
    expect(JSON.parse(invoke(root, ['check', 'probe']).output).evidence[0].result).toBe(damage);
    expect(invoke(root, ['run', 'probe', 'checks']).status).toBe(0);
    expect(JSON.parse(invoke(root, ['check', 'probe']).output).evidence[0].result).toBe('pass');
  },
);

it('requires an explicit result before implementation or evidence commands', async () => {
  const root = await fixture();
  await ready(root);
  // Model a readable legacy record, not a new classification inferred by the tool.
  await edit(root, (task) => {
    delete task.plan.result;
  });
  const before = await readFile(statePath(root), 'utf8');
  const context = JSON.parse(invoke(root, ['context', 'probe', 'resume']).output);
  expect(context.assessment.errors.join('\n')).toContain('WORK_RESULT_REQUIRED');
  expect(await readFile(statePath(root), 'utf8')).toBe(before);
  const blocked = invoke(root, ['update', 'probe', '--stdin'], {
    revision: context.revision,
    reason: 'Attempt implementation without resolving the missing contract.',
    stage: 'C1_IMPLEMENTATION',
    plan: { nextAction: 'Implement the probe.' },
  });
  expect(blocked.status).toBe(1);
  expect(run(root, 'require("node:fs").writeFileSync(".work/forbidden","bad")').status).toBe(1);
  await expect(readFile(join(root, '.work/forbidden'))).rejects.toThrow();
  expect((await state(root)).evidence).toHaveLength(0);
  const revision = JSON.parse(invoke(root, ['context', 'probe', 'resume']).output).revision;
  expect(
    invoke(root, ['update', 'probe', '--stdin'], {
      revision,
      reason: 'The fixture user requested maintenance; declare its actual complete command.',
      plan: {
        result: null,
        acceptance: [
          {
            id: 'checks',
            method: 'automated',
            criterion: 'The probe check passes.',
            command: [process.execPath, '-e', 'console.log("observed probe")'],
          },
        ],
      },
    }).status,
  ).toBe(0);
  expect(
    invoke(root, ['sync', 'probe', 'Inspected explicit maintenance and check contract.']).status,
  ).toBe(0);
  await implementing(root);
  verifying(root);
  expect(invoke(root, ['run', 'probe', 'checks']).status).toBe(0);
});

it('rejects malformed declared commands before creating a task', async () => {
  const root = await fixture();
  const request = proposal();
  for (const command of [[], [''], [42], 'node']) {
    const rejected = invoke(root, ['ensure', '--stdin'], {
      ...request,
      plan: { ...request.plan, acceptance: [{ ...request.plan.acceptance[0], command }] },
    });
    expect(rejected.status).toBe(1);
    expect(rejected.output).toContain('WORK_SCHEMA');
    expect(JSON.parse(invoke(root, ['status']).output).tasks).toEqual([]);
  }
});

it('permits dirty implementation but requires a declared check and clean candidate for evidence', async () => {
  const root = await fixture();
  const request = proposal();
  const created = JSON.parse(
    invoke(root, ['ensure', '--stdin'], {
      ...request,
      plan: {
        ...request.plan,
        acceptance: [{ id: 'checks', criterion: 'The value is 2.', method: 'automated' }],
      },
    }).output,
  );
  const id = created.task.id as string;
  const started = invoke(root, ['update', id, '--stdin'], {
    revision: created.revision,
    reason: 'Implement before choosing the check command.',
    stage: 'C1_IMPLEMENTATION',
    plan: { nextAction: 'Implement the value and its check.' },
  });
  expect(started.status, started.output).toBe(0);
  await writeFile(join(root, 'src/value.ts'), 'export const value = 2;\n');
  const pending = JSON.parse(invoke(root, ['context', id, 'verify']).output);
  const transition = invoke(root, ['update', id, '--stdin'], {
    revision: pending.revision,
    reason: 'Observe verification without a command or committed candidate.',
    stage: 'C1_EVIDENCE_PENDING',
    plan: { nextAction: 'Run the check.' },
  });
  if (transition.status === 0) {
    expect(invoke(root, ['run', id, 'checks']).status).toBe(1);
    const back = JSON.parse(invoke(root, ['context', id, 'implement']).output);
    expect(
      invoke(root, ['update', id, '--stdin'], {
        revision: back.revision,
        reason: 'Resume implementation of the missing check.',
        stage: 'C1_IMPLEMENTATION',
        plan: { nextAction: 'Declare the check.' },
      }).status,
    ).toBe(0);
  } else {
    expect(transition.output).toMatch(/WORK_CHECK_COMMAND|WORK_CANDIDATE/);
  }
  const script =
    'import assert from "node:assert/strict"; import { value } from "./value.ts"; assert.equal(value, 2);\n';
  await writeFile(join(root, 'src/check.ts'), script);
  const current = JSON.parse(invoke(root, ['context', id, 'implement']).output);
  const declared = invoke(root, ['update', id, '--stdin'], {
    revision: current.revision,
    reason: 'Declare the check for the implemented value.',
    plan: {
      acceptance: (await state(root, id)).plan.acceptance.map((entry) =>
        entry.id === 'checks' ? { ...entry, command: [process.execPath, 'src/check.ts'] } : entry,
      ),
    },
  });
  expect(declared.status, declared.output).toBe(0);
  expect(invoke(root, ['sync', id, 'Reject a dirty candidate.']).output).toContain(
    'WORK_CANDIDATE',
  );
  commitFixture(root, 'Implement and check value', ['src/value.ts', 'src/check.ts']);
  expect(invoke(root, ['sync', id, 'Reviewed the committed fixture and check.']).status).toBe(0);
  verifying(root, id);
  expect(invoke(root, ['run', id, 'checks']).status).toBe(0);
  expect(JSON.parse(invoke(root, ['check', id]).output).evidence[0].result).toBe('pass');
});

it('preserves evidence across phase updates but invalidates it when the declared check changes', async () => {
  const root = await fixture();
  await ready(root);
  expect(run(root).status).toBe(0);
  const before = await state(root);
  await implementing(root);
  verifying(root);
  expect((await state(root)).checkpoint!.candidate).toEqual(before.checkpoint!.candidate);
  expect(JSON.parse(invoke(root, ['check', 'probe']).output).evidence[0].result).toBe('pass');
  const revision = JSON.parse(invoke(root, ['context', 'probe', 'resume']).output).revision;
  expect(
    invoke(root, ['update', 'probe', '--stdin'], {
      revision,
      reason: 'The user changed the actual acceptance contract, not just the next action.',
      plan: {
        acceptance: before.plan.acceptance.map((entry) =>
          entry.id === 'checks'
            ? { ...entry, command: [process.execPath, '-e', 'console.log("changed requirement")'] }
            : entry,
        ),
      },
    }).status,
  ).toBe(0);
  expect(invoke(root, ['sync', 'probe', 'Read the changed acceptance command.']).status).toBe(0);
  expect(JSON.parse(invoke(root, ['check', 'probe']).output).evidence[0].result).toBe('pending');
  expect((await state(root)).evidence).toEqual(before.evidence);
});

// This integration scenario starts many individually bounded CLI processes.
it('rejects competing task writes before launching them while reads and another task continue', async () => {
  const root = await fixture();
  await ready(root);
  await implementing(root);
  await ready(root, 'second');
  verifying(root);
  verifying(root, 'second');
  const handoff = invoke(root, ['handoff', 'probe']);
  expect(handoff.status, handoff.output).toBe(0);
  await mkdir(join(root, '.work/inbox'));
  await cp(handoff.output, join(root, '.work/inbox/probe.md'));
  const before = await readFile(statePath(root), 'utf8');
  const revision = JSON.parse(invoke(root, ['context', 'probe', 'resume']).output).revision;
  const script =
    'const fs=require("node:fs");const t=JSON.parse(fs.readFileSync(".work/tasks/probe/state.json"));fs.writeFileSync(".work/child-observation",JSON.stringify(t.evidence.at(-1)));fs.writeFileSync(".work/started","ready");setInterval(()=>{if(fs.existsSync(".work/finish"))process.exit(0)},20)';
  const running = begin(
    root,
    ['run', 'probe', 'checks', '--', process.execPath, '-e', script],
    30_000,
  );
  commands.push(running);
  await expect
    .poll(() => readFile(join(root, '.work/started'), 'utf8').catch(() => ''))
    .toBe('ready');
  const inFlight = await readFile(statePath(root), 'utf8');
  const start = (JSON.parse(inFlight) as Task).evidence.at(-1)!;
  expect((JSON.parse(inFlight) as Task).evidence).toEqual([
    ...(JSON.parse(before) as Task).evidence,
    expect.objectContaining({ result: 'pending' }),
  ]);
  expect(JSON.parse(await readFile(join(root, '.work/child-observation'), 'utf8'))).toEqual(start);
  expect(start).not.toHaveProperty('sha256');
  expect(JSON.parse(invoke(root, ['read', 'probe', 'evidence', '0']).output).integrity).toBe(
    'pending',
  );
  const write = [
    process.execPath,
    '-e',
    'require("node:fs").writeFileSync(".work/forbidden","bad")',
  ];
  for (const args of [
    ['run', 'probe', 'checks', '--', ...write],
    ['sync', 'probe', 'Must not sync a running check.'],
    ['archive', 'probe', 'Must not archive.'],
    ['evidence', 'probe', 'quality-review', 'missing.md', 'Must not register.'],
    ['handoff', 'probe'],
    ['receive', '.work/inbox/probe.md'],
  ])
    expect(invoke(root, args).output).toContain('WORK_BUSY');
  expect(
    invoke(root, ['update', 'probe', '--stdin'], {
      revision,
      reason: 'Competing update.',
      plan: { nextAction: 'wrong' },
    }).output,
  ).toContain('WORK_BUSY');
  expect(invoke(root, ['deliver', 'probe', '--stdin'], { action: 'prepare' }).output).toContain(
    'WORK_BUSY',
  );
  expect(await readFile(statePath(root), 'utf8')).toBe(inFlight);
  await expect(readFile(join(root, '.work/forbidden'))).rejects.toHaveProperty('code', 'ENOENT');
  expect(await readdir(join(root, '.work/tasks/probe/evidence'))).toHaveLength(1);
  for (const args of [
    ['check', 'probe'],
    ['context', 'probe', 'resume'],
    ['read', 'probe', 'task'],
    ['status'],
  ])
    expect(invoke(root, args).status).toBe(0);
  expect(
    invoke(root, [
      'run',
      'second',
      'checks',
      '--',
      process.execPath,
      '-e',
      'console.log("independent")',
    ]).status,
  ).toBe(0);
  await writeFile(join(root, '.work/finish'), 'finish');
  const result = await running.finished;
  expect(result.status, result.output).toBe(0);
  const settled = (await state(root)).evidence;
  expect(settled).toHaveLength(1);
  expect(settled[0]!.result).toBe('pass');
  expect(settled[0]!.artifact).toBe(start.artifact);
  expect(settled[0]!.candidate).toEqual(start.candidate);
  expect(digest(await readFile(join(root, start.artifact)))).toBe(settled[0]!.sha256);
  expect(JSON.parse(invoke(root, ['read', 'probe', 'evidence', '0']).output).integrity).toBe(
    'verified',
  );
  await expect(readFile(join(root, '.work/tasks/probe.command.json'))).rejects.toHaveProperty(
    'code',
    'ENOENT',
  );
}, 30_000);

it('never turns cancellation into a pass even when the child handles SIGTERM by exiting zero', async () => {
  const root = await fixture();
  await ready(root);
  verifying(root);
  const script =
    'const fs=require("node:fs");process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},100);fs.writeFileSync(".work/started","ready")';
  const running = begin(root, ['run', 'probe', 'checks', '--', process.execPath, '-e', script]);
  commands.push(running);
  await expect
    .poll(() => readFile(join(root, '.work/started'), 'utf8').catch(() => ''))
    .toBe('ready');
  running.child.kill('SIGTERM');
  const result = await running.finished;
  expect(result.status, result.output).toBe(1);
  const evidence = (await state(root)).evidence.at(-1)!;
  expect(evidence.result).toBe(process.platform === 'win32' ? 'pending' : 'fail');
  const log = await readFile(join(root, evidence.artifact), 'utf8');
  expect(log).toContain('"cancelled": true');
  if (process.platform !== 'win32') {
    expect(log).toContain('"exitCode": 0');
    await expect(readFile(join(root, '.work/tasks/probe.command.json'))).rejects.toHaveProperty(
      'code',
      'ENOENT',
    );
    expect(run(root).status).toBe(0);
  }
});

it.skipIf(process.platform === 'win32').each([false, true])(
  'retains occupancy when a same-group descendant outlives its cancelled leader (input changed: %s)',
  async (inputChanged) => {
    const root = await fixture();
    await ready(root);
    expect(run(root).status).toBe(0);
    const baseline = await state(root);
    expect(baseline.evidence.at(-1)!.result).toBe('pass');
    const descendant =
      'const fs=require("node:fs");process.on("SIGTERM",()=>fs.writeFileSync(".work/signalled","yes"));setInterval(()=>console.log("late output"),20);fs.writeFileSync(".work/descendant","ready")';
    const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},100)`;
    const running = begin(root, ['run', 'probe', 'checks', '--', process.execPath, '-e', script]);
    commands.push(running);
    await expect
      .poll(() => readFile(join(root, '.work/descendant'), 'utf8').catch(() => ''))
      .toBe('ready');
    if (inputChanged) await writeFile(join(root, 'src/value.ts'), 'export const value = 2;\n');
    running.child.kill('SIGTERM');
    const result = await running.finished;
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('WORK_CHILD_ACTIVE');
    expect(await readFile(join(root, '.work/signalled'), 'utf8')).toBe('yes');
    const task = await state(root);
    const evidence = task.evidence.at(-1)!;
    expect(evidence.result).toBe('pending');
    expect(evidence.summary).toContain(
      `unsettled=true; contextChanged=${inputChanged}; coverage=supplement`,
    );
    expect(task.plan.nextAction).toBe(
      'Confirm the execution group has stopped, inspect the provisional log, then recover the retained command marker before continuing.',
    );
    expect(evidence).not.toHaveProperty('sha256');
    const length = (await readFile(join(root, evidence.artifact))).length;
    await expect
      .poll(async () => (await readFile(join(root, evidence.artifact))).length)
      .toBeGreaterThan(length);
    if (inputChanged) await writeFile(join(root, 'src/value.ts'), 'export const value = 1;\n');
    const check = JSON.parse(invoke(root, ['check', 'probe']).output);
    expect(check.candidate).toEqual(baseline.checkpoint!.candidate);
    expect(
      check.evidence.find((entry: { criterion: string }) => entry.criterion === 'checks').result,
    ).toBe('pending');
    expect(invoke(root, ['sync', 'probe', 'Do not clear an active group.']).output).toContain(
      'WORK_BUSY',
    );
    expect(
      JSON.parse(await readFile(join(root, '.work/tasks/probe.command.json'), 'utf8')).child,
    ).toBeGreaterThan(0);
  },
);

it.skipIf(process.platform === 'win32')(
  'keeps an interrupted marker after SIGKILL instead of stealing it by pid or age',
  async () => {
    const root = await fixture();
    await ready(root);
    verifying(root);
    expect(run(root).status).toBe(0);
    expect(JSON.parse(invoke(root, ['check', 'probe']).output).evidence[0].result).toBe('pass');
    const running = begin(root, [
      'run',
      'probe',
      'checks',
      '--',
      process.execPath,
      '-e',
      'setInterval(()=>{},100);require("node:fs").writeFileSync(".work/started","ready")',
    ]);
    commands.push(running);
    await expect
      .poll(() => readFile(join(root, '.work/started'), 'utf8').catch(() => ''))
      .toBe('ready');
    running.child.kill('SIGKILL');
    await running.finished;
    const path = join(root, '.work/tasks/probe.command.json');
    const marker = await readFile(path, 'utf8');
    expect(
      invoke(root, ['run', 'probe', 'checks', '--', process.execPath, '-e', 'process.exit(0)'])
        .output,
    ).toContain('WORK_BUSY');
    expect(await readFile(path, 'utf8')).toBe(marker);
    const evidence = (await state(root)).evidence;
    expect(evidence).toHaveLength(2);
    expect(evidence[1]!.result).toBe('pending');
    expect(evidence[1]).not.toHaveProperty('sha256');
    expect(await readFile(join(root, evidence[1]!.artifact), 'utf8')).toContain('"started"');
    expect(await readdir(join(root, '.work/tasks/probe/evidence'))).toHaveLength(2);
    expect(JSON.parse(invoke(root, ['check', 'probe']).output).evidence[0].result).toBe('pending');
    await rm(join(root, evidence[1]!.artifact));
    expect(JSON.parse(invoke(root, ['check', 'probe']).output).evidence[0].result).not.toBe('pass');
    expect(invoke(root, ['context', 'probe', 'resume']).status).toBe(0);
  },
);

it('applies occupancy to ensure and does not mistake a retained marker for a task stage', async () => {
  const root = await fixture();
  const created = invoke(root, ['ensure', '--stdin'], proposal());
  const id = JSON.parse(created.output).task.id as string;
  const before = await readFile(statePath(root, id), 'utf8');
  await writeFile(
    join(root, `.work/tasks/${id}.command.json`),
    '{"pid":0,"command":"interrupted"}',
  );
  expect(invoke(root, ['ensure', '--stdin'], proposal()).output).toContain('WORK_BUSY');
  expect(await readFile(statePath(root, id), 'utf8')).toBe(before);
  expect(invoke(root, ['check', id]).status).toBe(0);
});

it('keeps pre-record occupancy and retained markers outside task listings', async () => {
  const root = await fixture();
  // A failed first action must not remove the shared container another opener may be using.
  await expect(
    withTaskCommand(root, 'not-created', 'start', async () => {
      throw new Error('initialization failed before state');
    }),
  ).rejects.toThrow('initialization failed before state');
  expect(await readdir(join(root, '.work/tasks'))).toEqual([]);
  await ready(root);
  let release!: () => void;
  const finished = new Promise<void>((resolve) => {
    release = resolve;
  });
  const operation = withTaskCommand(root, 'new-task', 'ensure', () => finished);
  const marker = join(root, '.work/tasks/new-task.command.json');
  try {
    await expect.poll(() => readFile(marker, 'utf8').catch(() => '')).toContain('ensure');
    await expect(readdir(join(root, '.work/tasks/new-task'))).rejects.toHaveProperty(
      'code',
      'ENOENT',
    );
    const listed = invoke(root, ['status']);
    expect(listed.status, listed.output).toBe(0);
    expect(JSON.parse(listed.output).tasks.map((task: { id: string }) => task.id)).toEqual([
      'probe',
    ]);
  } finally {
    release();
    await operation;
  }
  // The same surviving marker after a hard stop creates no fake record or empty task directory.
  await writeFile(marker, '{"pid":0,"command":"interrupted initialization"}');
  expect(invoke(root, ['status', '--query', 'probe']).status).toBe(0);
  expect(invoke(root, ['start', 'new-task', 'Resume initialization']).output).toContain(
    'WORK_BUSY',
  );
  await rm(marker);
  expect(invoke(root, ['start', 'new-task', 'Resume initialization']).status).toBe(0);
  expect(JSON.parse(invoke(root, ['status']).output).tasks).toHaveLength(2);
});

it('does not execute the retired work exec command', async () => {
  const root = await fixture();
  await ready(root);
  await implementing(root);
  const attempt = invoke(root, [
    'exec',
    'probe',
    '--',
    process.execPath,
    '-e',
    'require("node:fs").writeFileSync(".work/forbidden", "executed")',
  ]);
  expect(attempt.status).toBe(1);
  await expect(readFile(join(root, '.work/forbidden'))).rejects.toHaveProperty('code', 'ENOENT');
});

it('initializes without Skills, retains existing records and refuses another member or duplicate task', async () => {
  const root = await fixture();
  await mkdir(join(root, '.work/evidence'));
  await writeFile(join(root, '.work/evidence/legacy.log'), 'original failure');
  await ready(root);
  const original = await readFile(statePath(root), 'utf8');
  expect(invoke(root, ['init', 'alice']).status).toBe(0);
  expect(invoke(root, ['init', 'bob']).output).toContain('WORK_MEMBER');
  expect(invoke(root, ['start', 'probe', 'Replacement']).status).toBe(1);
  expect(await readFile(statePath(root), 'utf8')).toBe(original);
  expect(await readFile(join(root, '.work/evidence/legacy.log'), 'utf8')).toBe('original failure');
});

it('preserves failed raw evidence and records the actual success separately', async () => {
  const root = await fixture();
  await ready(root);
  expect(run(root, 'console.error("original failure");process.exit(7)').status).toBe(1);
  expect(run(root).status).toBe(0);
  const task = await state(root);
  expect(task.evidence.map((entry) => entry.result)).toEqual(['fail', 'pass']);
  expect(task.evidence[0]!.artifact).not.toBe(task.evidence[1]!.artifact);
  expect(await readFile(join(root, task.evidence[0]!.artifact), 'utf8')).toContain(
    'original failure',
  );
  expect(JSON.parse(invoke(root, ['check', 'probe']).output).evidence[0].result).toBe('pass');
});

it('requires a clean committed candidate after a source change and retains old evidence', async () => {
  const root = await fixture();
  await ready(root);
  expect(run(root).status).toBe(0);
  const original = await state(root);
  await writeFile(join(root, 'docs/api.md'), '# API\nChanged contract.\n');
  const before = await readFile(statePath(root), 'utf8');
  expect(invoke(root, ['check', 'probe']).output).toContain('WORK_CANDIDATE');
  expect(await readFile(statePath(root), 'utf8')).toBe(before);
  expect(run(root).output).toContain('WORK_CANDIDATE');
  expect(invoke(root, ['sync', 'probe', 'Cannot sync a dirty source.']).output).toContain(
    'WORK_CANDIDATE',
  );
  const commit = commitFixture(root, 'Change requirement', ['docs/api.md']);
  expect(invoke(root, ['sync', 'probe', 'Reviewed the committed requirement.']).status).toBe(0);
  const task = await state(root);
  expect(task.checkpoint!.candidate).toEqual({
    commit,
    contractRevision: original.contractRevision,
  });
  expect(task.evidence).toEqual(original.evidence);
  expect(JSON.parse(invoke(root, ['check', 'probe']).output).evidence[0].result).toBe('pending');
  expect(run(root).status).toBe(0);
});

it('rejects untracked files and a check that leaves its tracked input dirty', async () => {
  const root = await fixture();
  await ready(root);
  await writeFile(join(root, 'src/new.ts'), 'export const next = 2;');
  expect(invoke(root, ['sync', 'probe', 'Reject an untracked source.']).output).toContain(
    'WORK_CANDIDATE',
  );
  commitFixture(root, 'Add fixture source', ['src/new.ts']);
  expect(invoke(root, ['sync', 'probe', 'Reviewed the new source.']).status).toBe(0);
  const outcome = run(
    root,
    'require("node:fs").writeFileSync("src/value.ts", "export const value = 3;")',
  );
  expect(outcome.status).toBe(1);
  const task = await state(root);
  expect(task.evidence.at(-1)!.result).toBe('pending');
  expect(invoke(root, ['check', 'probe']).output).toContain('WORK_CANDIDATE');
});

it('binds evidence to acceptance changes while allowing next-action updates without a new candidate', async () => {
  const root = await fixture();
  await ready(root);
  expect(run(root).status).toBe(0);
  const original = await state(root);
  const progress = invoke(root, ['update', 'probe', '--stdin'], {
    revision: taskRevision(original),
    reason: 'Update only the next action.',
    plan: { nextAction: 'Return results.' },
  });
  expect(progress.status, progress.output).toBe(0);
  expect(JSON.parse(invoke(root, ['check', 'probe']).output).evidence[0].result).toBe('pass');
  const changed = invoke(root, ['update', 'probe', '--stdin'], {
    revision: JSON.parse(progress.output).revision,
    reason: 'Change the acceptance criterion.',
    plan: {
      acceptance: original.plan.acceptance.map((entry) =>
        entry.id === 'checks' ? { ...entry, criterion: 'Different required behavior.' } : entry,
      ),
    },
  });
  expect(changed.status, changed.output).toBe(0);
  expect(invoke(root, ['check', 'probe']).output).toContain('WORK_CANDIDATE');
  expect(invoke(root, ['sync', 'probe', 'Reviewed the revised criterion.']).status).toBe(0);
  expect(JSON.parse(invoke(root, ['check', 'probe']).output).evidence[0].result).toBe('pending');
  expect((await state(root)).evidence).toEqual(original.evidence);
});

it('can refresh missing release evidence without manually bypassing release checks', async () => {
  const root = await fixture();
  await ready(root);
  expect(run(root).status).toBe(0);
  await accept(root);
  const task = await state(root);
  await rm(
    join(
      root,
      task.evidence.find((entry) => entry.criterion === 'checks' && entry.result === 'pass')!
        .artifact,
    ),
  );
  expect(invoke(root, ['check', 'probe']).output).toContain('WORK_RELEASE');
  expect(run(root).status).toBe(0);
  const refreshed = await state(root);
  expect(refreshed.evidence).toHaveLength(3);
  expect(refreshed.stage).toBe('C1_EVIDENCE_PENDING');
  expect(refreshed.reviewDecision).toBe('PENDING');
  expect(invoke(root, ['check', 'probe']).status).toBe(0);
});

it('requires a fresh evidence binding even for a same-content new Git commit', async () => {
  const root = await fixture();
  await ready(root);
  expect(run(root).status).toBe(0);
  const previous = await state(root);
  const committed = spawnSync('git', ['commit', '--allow-empty', '-qm', 'New fixture commit'], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(committed.status, committed.stderr).toBe(0);
  expect(invoke(root, ['check', 'probe']).output).toContain('WORK_CANDIDATE');
  expect(invoke(root, ['sync', 'probe', 'Reviewed the new clean commit.']).status).toBe(0);
  expect((await state(root)).checkpoint!.candidate).not.toEqual(previous.checkpoint!.candidate);
  expect((await state(root)).evidence).toEqual(previous.evidence);
  expect(JSON.parse(invoke(root, ['check', 'probe']).output).evidence[0].result).toBe('pending');
});

it('does not overwrite state edited during a check and preserves the unbound raw log', async () => {
  const root = await fixture();
  await ready(root);
  const script =
    'const fs=require("node:fs");const p=".work/tasks/probe/state.json";const t=JSON.parse(fs.readFileSync(p));t.plan.nextAction="Concurrent author update";fs.writeFileSync(p,JSON.stringify(t));';
  expect(run(root, script).output).toContain('WORK_CONFLICT');
  const task = await state(root);
  expect(task.plan.nextAction).toBe('Concurrent author update');
  expect(task.evidence).toHaveLength(1);
  expect(task.evidence[0]!.result).toBe('pending');
  expect(task.evidence[0]).not.toHaveProperty('sha256');
  expect(await readFile(join(root, task.evidence[0]!.artifact), 'utf8')).toContain('"exitCode": 0');
  expect(await readdir(join(root, '.work/tasks/probe/evidence'))).toHaveLength(1);
});

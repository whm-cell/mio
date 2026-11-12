import type { TaskDocument } from '../../scripts/harness/inventory.ts';
import { writeTaskDocuments } from './fixtures/task-documents-fixture.ts';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { Task } from '../../scripts/harness/work/records.ts';
import { digest } from '../../scripts/harness/work/records.ts';
import { reviewFixture, reviewMarkdown } from './fixtures/quality-review-fixture.ts';
import { artifact } from '../../scripts/harness/work/context.ts';
import { withTaskCommand } from '../../scripts/harness/work/command.ts';

const project = resolve('.');
const cli = join(project, 'scripts/harness/work/cli.ts');
const scratch: string[] = [];
const commands: ReturnType<typeof begin>[] = [];
afterEach(async () => {
  for (const command of commands.splice(0)) {
    const marker = await readFile(
      join(command.root, `.work/tasks/${command.id}.command.json`),
      'utf8',
    )
      .then((raw) => JSON.parse(raw) as { pid: number; child?: number })
      .catch(() => null);
    if (marker?.pid === command.child.pid && marker?.child && process.platform !== 'win32') {
      try {
        process.kill(-marker.child, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    if (command.child.exitCode === null && command.child.signalCode === null)
      command.child.kill('SIGKILL');
    await command.finished;
  }
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function begin(root: string, args: string[], timeout = 10_000) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '' },
    timeout,
  });
  let output = '';
  child.stdout.on('data', (bytes: Buffer) => {
    output += bytes.toString();
  });
  child.stderr.on('data', (bytes: Buffer) => {
    output += bytes.toString();
  });
  const finished = new Promise<{ status: number | null; output: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, output }));
  });
  child.stdin.end();
  return { root, id: args[1]!, child, finished };
}

async function fixture(actor = 'alice') {
  const root = await mkdtemp(join(tmpdir(), 'mio-work-'));
  scratch.push(root);
  await cp(join(project, 'harness.config.json'), join(root, 'harness.config.json'));
  for (const [file, source] of Object.entries({
    'package.json': '{"type":"module"}\n',
    '.gitignore': '.work/\n',
    'AGENTS.md': '# Development\n',
    'docs/api.md': '# API\n',
    'src/value.ts': 'export const value = 1;\n',
  })) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), source);
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
  expect(invoke(root, ['init', actor]).status).toBe(0);
  return root;
}

// The child has no Skill paths, Codex tools or conversation history; all behavior enters the real CLI.
function invoke(root: string, args: string[], input?: unknown) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
    timeout: 10000,
    ...(input === undefined ? {} : { input: JSON.stringify(input) }),
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}`.trim() };
}

const statePath = (root: string, id = 'probe') => join(root, `.work/tasks/${id}/state.json`);
const state = async (root: string, id = 'probe'): Promise<Task> =>
  JSON.parse(await readFile(statePath(root, id), 'utf8'));

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

async function edit(root: string, change: (task: Task) => void, id = 'probe') {
  const task = await state(root, id);
  change(task);
  await writeFile(statePath(root, id), JSON.stringify(task));
}

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

it('allows implementation before choosing a check command but blocks evidence until it is declared', async () => {
  const root = await fixture();
  const request = proposal();
  const created = JSON.parse(
    invoke(root, ['ensure', '--stdin'], {
      ...request,
      plan: {
        ...request.plan,
        acceptance: [
          { id: 'checks', criterion: 'The implemented value is 2.', method: 'automated' },
        ],
      },
    }).output,
  );
  const id = created.task.id as string;
  expect(created.task.stage).toBe('C0_READY');
  expect(created.assessment.ready).toBe(true);
  expect(created.assessment.evidence[0].result).toBe('pending');
  const implementation = invoke(root, ['update', id, '--stdin'], {
    revision: created.revision,
    reason: 'The result and method are known; develop the implementation and its check.',
    stage: 'C1_IMPLEMENTATION',
    plan: { nextAction: 'Implement the value and its check.' },
  });
  expect(implementation.status, implementation.output).toBe(0);
  expect(
    invoke(root, [
      'exec',
      id,
      '--',
      process.execPath,
      '-e',
      'require("node:fs").writeFileSync("src/value.ts", "export const value = 2;\\n")',
    ]).status,
  ).toBe(0);
  expect(await readFile(join(root, 'src/value.ts'), 'utf8')).toContain('value = 2');
  expect(invoke(root, ['sync', id, 'Inspected the implemented value.']).status).toBe(0);
  verifying(root, id);
  const before = await state(root, id);
  const pending = JSON.parse(invoke(root, ['context', id, 'verify']).output);
  expect(pending.assessment.errors.join()).toContain('WORK_CHECK_COMMAND');
  expect(pending.assessment.readyForAcceptance).toBe(false);
  for (const argv of [
    ['run', id, 'checks'],
    [
      'run',
      id,
      'checks',
      '--',
      process.execPath,
      '-e',
      'require("node:fs").writeFileSync(".work/forbidden", "bad")',
    ],
    ['evidence', id, 'quality-review', '.work/missing.md', 'Cannot bypass missing command'],
  ])
    expect(invoke(root, argv).output).toContain('WORK_CHECK_COMMAND');
  await expect(readFile(join(root, '.work/forbidden'))).rejects.toThrow();
  expect((await state(root, id)).evidence).toEqual(before.evidence);
  const returned = invoke(root, ['update', id, '--stdin'], {
    revision: pending.revision,
    reason: 'Return to authorized implementation to create the check script.',
    stage: 'C1_IMPLEMENTATION',
    plan: { nextAction: 'Create the value check, then declare its command.' },
  });
  expect(returned.status, returned.output).toBe(0);
  expect((await state(root, id)).checkpoint!.candidate).toBe(before.checkpoint!.candidate);
  const script =
    'import assert from "node:assert/strict"; import { value } from "./value.ts"; assert.equal(value, 2);\n';
  expect(
    invoke(root, [
      'exec',
      id,
      '--',
      process.execPath,
      '-e',
      `require("node:fs").writeFileSync("src/check.ts", ${JSON.stringify(script)})`,
    ]).status,
  ).toBe(0);
  const current = JSON.parse(invoke(root, ['context', id, 'resume']).output);
  const declared = invoke(root, ['update', id, '--stdin'], {
    revision: current.revision,
    reason: 'The implemented check now covers the original value criterion.',
    plan: {
      acceptance: (await state(root, id)).plan.acceptance.map((entry) =>
        entry.id === 'checks' ? { ...entry, command: [process.execPath, 'src/check.ts'] } : entry,
      ),
    },
  });
  expect(declared.status, declared.output).toBe(0);
  expect(JSON.parse(declared.output).assessment.errors.join()).toContain('WORK_CONTEXT_CHANGED');
  expect(invoke(root, ['sync', id, 'Reviewed the check implementation and command.']).status).toBe(
    0,
  );
  verifying(root, id);
  expect((await state(root, id)).checkpoint!.candidate).not.toBe(before.checkpoint!.candidate);
  expect(invoke(root, ['run', id, 'checks']).status).toBe(0);
  expect(JSON.parse(invoke(root, ['check', id]).output).evidence[0].result).toBe('pass');
});

it('still rejects actual drift when returning from missing-command verification to implementation', async () => {
  const root = await fixture();
  await ready(root);
  await edit(root, (task) => {
    delete task.plan.acceptance[0]!.command;
  });
  invoke(root, ['sync', 'probe', 'Inspected the missing command contract.']);
  verifying(root);
  await writeFile(join(root, 'src/value.ts'), 'export const value = 3;\n');
  const current = JSON.parse(invoke(root, ['context', 'probe', 'resume']).output);
  const before = await readFile(statePath(root), 'utf8');
  const rejected = invoke(root, ['update', 'probe', '--stdin'], {
    revision: current.revision,
    reason: 'Attempt a phase change without acknowledging changed inputs.',
    stage: 'C1_IMPLEMENTATION',
    plan: { nextAction: 'Implement the missing check.' },
  });
  expect(rejected.status).toBe(1);
  expect(rejected.output).toContain('WORK_CONTEXT_CHANGED');
  expect(await readFile(statePath(root), 'utf8')).toBe(before);
  invoke(root, ['sync', 'probe', 'Inspected the changed value before resuming implementation.']);
  await implementing(root);
  expect((await state(root)).stage).toBe('C1_IMPLEMENTATION');
});

it('preserves evidence across phase updates but invalidates it when the declared check changes', async () => {
  const root = await fixture();
  await ready(root);
  expect(run(root).status).toBe(0);
  const before = await state(root);
  await implementing(root);
  verifying(root);
  expect((await state(root)).checkpoint!.candidate).toBe(before.checkpoint!.candidate);
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

async function ready(root: string, id = 'probe') {
  expect(invoke(root, ['start', id, 'Verify the probe', 'docs/api.md']).status).toBe(0);
  const revision = digest(await readFile(statePath(root, id)));
  const updated = invoke(root, ['update', id, '--stdin'], {
    revision,
    reason: 'Derived the probe contract from the fixture user request.',
    plan: {
      result: null,
      scope: ['src'],
      authorization: 'Fixture user requests local probe implementation and checks.',
      acceptance: [
        {
          id: 'checks',
          criterion: 'The probe check passes.',
          method: 'automated',
          command: [process.execPath, '-e', 'console.log("observed probe")'],
        },
      ],
      nextAction: 'Implement and check the probe.',
      stopCondition: 'Return verified results for review.',
    },
  });
  expect(updated.status, updated.output).toBe(0);
  const result = invoke(root, ['sync', id, 'Read the contract and inspected the baseline.']);
  expect(result.status, result.output).toBe(0);
}

async function implementing(root: string) {
  const revision = digest(await readFile(statePath(root)));
  const result = invoke(root, ['update', 'probe', '--stdin'], {
    revision,
    reason: 'The fixture user authorized the implementation command.',
    stage: 'C1_IMPLEMENTATION',
    plan: { nextAction: 'Implement the authorized probe changes.' },
  });
  expect(result.status, result.output).toBe(0);
}

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
    'const fs=require("node:fs");fs.writeFileSync(".work/started","ready");setInterval(()=>{if(fs.existsSync(".work/finish"))process.exit(0)},20)';
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
  const write = [
    process.execPath,
    '-e',
    'require("node:fs").writeFileSync(".work/forbidden","bad")',
  ];
  for (const args of [
    ['exec', 'probe', '--', ...write],
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
  expect(await readdir(join(root, '.work/tasks/probe/evidence'))).toHaveLength(2);
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
  const log = await readFile(join(root, settled[0]!.artifact), 'utf8');
  expect(JSON.parse(log.slice(0, log.indexOf('\n}\n') + 2)).start).toEqual({
    artifact: start.artifact,
    sha256: start.sha256,
  });
  expect(digest(await readFile(join(root, start.artifact)))).toBe(start.sha256);
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
  const evidence = (await state(root)).evidence[0]!;
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
    const observation = JSON.parse(await readFile(join(root, evidence.artifact), 'utf8'));
    const length = (await readFile(join(root, observation.rawLog))).length;
    await expect
      .poll(async () => (await readFile(join(root, observation.rawLog))).length)
      .toBeGreaterThan(length);
    if (inputChanged) await writeFile(join(root, 'src/value.ts'), 'export const value = 1;\n');
    const check = JSON.parse(invoke(root, ['check', 'probe']).output);
    expect(check.candidate).toBe(baseline.checkpoint!.candidate);
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
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.result).toBe('pending');
    const start = await readFile(join(root, evidence[0]!.artifact), 'utf8');
    expect(digest(start)).toBe(evidence[0]!.sha256);
    expect(await readFile(join(root, JSON.parse(start).rawLog), 'utf8')).toContain('"started"');
    expect(await readdir(join(root, '.work/tasks/probe/evidence'))).toHaveLength(2);
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

it('keeps shell redirection inside the checked subprocess and releases occupancy after launch errors', async () => {
  const root = await fixture();
  await ready(root);
  const args = [
    'exec',
    'probe',
    '--',
    'sh',
    '-c',
    'printf "%s\\n" "export const value = 2;" > src/value.ts',
  ];
  const before = await readFile(join(root, 'src/value.ts'), 'utf8');
  expect(invoke(root, args).output).toContain('WORK_EXEC_STAGE');
  expect(await readFile(join(root, 'src/value.ts'), 'utf8')).toBe(before);
  await implementing(root);
  expect(invoke(root, ['exec', 'probe', '--', 'mio-command-does-not-exist']).status).toBe(1);
  await expect(readFile(join(root, '.work/tasks/probe.command.json'))).rejects.toHaveProperty(
    'code',
    'ENOENT',
  );
  expect(invoke(root, args).status).toBe(0);
  expect(await readFile(join(root, 'src/value.ts'), 'utf8')).toBe('export const value = 2;\n');
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

function verifying(root: string, id = 'probe') {
  const raw = readFileSync(statePath(root, id));
  if ((JSON.parse(raw.toString()) as Task).stage === 'C1_EVIDENCE_PENDING') return;
  const result = invoke(root, ['update', id, '--stdin'], {
    revision: digest(raw),
    reason: 'The fixture explicitly chooses verification of its existing candidate.',
    stage: 'C1_EVIDENCE_PENDING',
    plan: { nextAction: 'Collect the authorized fixture observations.' },
  });
  expect(result.status, result.output).toBe(0);
}

function run(root: string, script = 'console.log("observed probe")', id = 'probe') {
  verifying(root, id);
  return invoke(root, ['run', id, 'checks', '--', process.execPath, '-e', script]);
}

it('checks task existence and C1 before starting an implementation command', async () => {
  const root = await fixture();
  const argv = [
    '--',
    process.execPath,
    '-e',
    'require("node:fs").writeFileSync(".work/started", "yes")',
  ];
  expect(invoke(root, ['exec', 'missing', ...argv]).status).toBe(1);
  await ready(root);
  expect(invoke(root, ['exec', 'probe', ...argv]).output).toContain('WORK_EXEC_STAGE');
  await expect(readFile(join(root, '.work/started'))).rejects.toThrow();
  await implementing(root);
  const before = await state(root);
  const result = invoke(root, ['exec', 'probe', ...argv]);
  expect(result.status, result.output).toBe(0);
  expect(await readFile(join(root, '.work/started'), 'utf8')).toBe('yes');
  expect((await state(root)).evidence).toEqual([]);
  expect((await state(root)).plan.nextAction).toContain('then sync');
  expect(
    invoke(root, ['sync', 'probe', 'The command only wrote its private sentinel.']).status,
  ).toBe(0);
  expect((await state(root)).checkpoint).toEqual(before.checkpoint);
  expect((await state(root)).plan.nextAction).toContain('enter verification');
  expect((await state(root)).plan.nextAction).not.toContain('then sync');
});

it('refuses drift and non-implementation phases without running the child', async () => {
  const root = await fixture();
  await ready(root);
  await implementing(root);
  const args = [
    'exec',
    'probe',
    '--',
    process.execPath,
    '-e',
    'require("node:fs").writeFileSync(".work/started", "yes")',
  ];
  const file = join(root, 'src/value.ts');
  const before = await readFile(file, 'utf8');
  await writeFile(file, 'export const value = 9;\n');
  expect(invoke(root, args).output).toContain('WORK_CONTEXT_CHANGED');
  await writeFile(file, before);
  await edit(root, (task) => {
    task.stage = 'C1_EVIDENCE_PENDING';
  });
  expect(invoke(root, args).output).toContain('WORK_EXEC_STAGE');
  await expect(readFile(join(root, '.work/started'))).rejects.toThrow();
});

it('retains implementation changes and child failure without syncing or inventing evidence', async () => {
  const root = await fixture();
  await ready(root);
  await implementing(root);
  const before = await state(root);
  const result = invoke(root, [
    'exec',
    'probe',
    '--',
    process.execPath,
    '-e',
    'require("node:fs").writeFileSync("src/value.ts", "export const value = 2;\\n");process.exit(7)',
  ]);
  expect(result.status, result.output).toBe(7);
  expect(await readFile(join(root, 'src/value.ts'), 'utf8')).toContain('value = 2');
  expect((await state(root)).checkpoint).toEqual(before.checkpoint);
  expect((await state(root)).evidence).toEqual([]);
  expect(invoke(root, ['check', 'probe']).output).toContain('WORK_CONTEXT_CHANGED');
});

async function accept(root: string) {
  verifying(root);
  const current = await state(root);
  const relative = `.work/tasks/probe/evidence/review-${current.evidence.length}.md`;
  await mkdir(dirname(join(root, relative)), { recursive: true });
  await writeFile(
    join(root, relative),
    reviewMarkdown(reviewFixture(current.checkpoint!.candidate)),
  );
  expect(
    invoke(root, ['evidence', 'probe', 'quality-review', relative, 'Fixture review.']).status,
  ).toBe(0);
  await edit(root, (task) => {
    task.stage = 'C1_RELEASED';
    task.reviewDecision = 'ACCEPT';
    task.releaseDisposition = 'RELEASED';
  });
}

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

const requirement = { source: 'docs/api.md', section: 'API', key: 'value-probe' };
function proposal() {
  return {
    requirement,
    plan: {
      goal: 'Implement the PRD value subtask.',
      result: null,
      scope: ['src'],
      authorization: 'Fixture user requests this PRD subtask and local validation.',
      acceptance: [
        {
          id: 'checks',
          criterion: 'The value is 2.',
          method: 'automated',
          command: [process.execPath, '-e', 'console.log("observed probe")'],
        },
      ],
      nonGoals: ['No remote operations.'],
      nextAction: 'Implement the value subtask.',
      stopCondition: 'Return results for human review.',
    },
  };
}

it('requires a real unique requirement heading rather than a nonempty label or fenced example', async () => {
  const root = await fixture();
  for (const content of [
    '# Actual\n',
    '# Actual\n\n```md\n# API\n```\n',
    '# API\n\n## **API**\n',
  ]) {
    await writeFile(join(root, 'docs/api.md'), content);
    const result = invoke(root, ['ensure', '--stdin'], proposal());
    expect(result.output).toContain('WORK_REQUIREMENT_SECTION');
    expect(JSON.parse(invoke(root, ['status']).output).tasks).toEqual([]);
  }
  await writeFile(join(root, 'docs/api.md'), '# **API**\n\nActual source.\n');
  expect(invoke(root, ['ensure', '--stdin'], proposal()).status).toBe(0);
});

it.each(['C1_IMPLEMENTATION', 'C1_EVIDENCE_PENDING'])(
  'requires explicit reconciliation after a same-stage conflict in %s',
  async (stage) => {
    const root = await fixture();
    const first = JSON.parse(invoke(root, ['ensure', '--stdin'], proposal()).output);
    const id = first.task.id as string;
    const staged = invoke(root, ['update', id, '--stdin'], {
      revision: first.revision,
      reason: 'Choose the fixture phase.',
      stage,
      plan: { nextAction: 'Perform the authorized fixture action.' },
    });
    expect(staged.status, staged.output).toBe(0);
    const stale = JSON.parse(staged.output);
    expect(
      invoke(root, ['update', id, '--stdin'], {
        revision: stale.revision,
        reason: 'The current actor refined the next action.',
        plan: { nextAction: 'Current authorized action.' },
      }).status,
    ).toBe(0);
    const before = await readFile(statePath(root, id), 'utf8');
    expect(
      invoke(root, ['update', id, '--stdin'], {
        revision: stale.revision,
        reason: 'An obsolete request must not take effect.',
        plan: { nextAction: 'Obsolete action.' },
      }).output,
    ).toContain('WORK_CONFLICT');
    const receipt = await readFile(join(root, `.work/tasks/${id}/conflict.json`), 'utf8');
    expect(await readFile(statePath(root, id), 'utf8')).toBe(before);
    const script = 'require("node:fs").writeFileSync(".work/forbidden","started")';
    for (const args of [
      ['exec', id, '--', process.execPath, '-e', script],
      ['run', id, 'checks', '--', process.execPath, '-e', script],
      ['sync', id, 'Cannot acknowledge away the conflict.'],
      ['archive', id, 'Cannot hide the conflict.'],
      ['handoff', id],
    ])
      expect(invoke(root, args).output).toContain('WORK_RECONCILE');
    expect(invoke(root, ['ensure', '--stdin'], { requirement }).output).toContain('WORK_RECONCILE');
    const observed = JSON.parse(invoke(root, ['context', id, 'resume']).output);
    expect(observed.assessment.ready).toBe(false);
    expect(invoke(root, ['check', id]).output).toContain('WORK_RECONCILE');
    expect(invoke(root, ['read', id, 'task']).status).toBe(0);
    expect(invoke(root, ['status']).status).toBe(0);
    expect(invoke(root, ['exec', id, '--', process.execPath, '-e', script]).output).toContain(
      'WORK_RECONCILE',
    );
    await expect(readFile(join(root, '.work/forbidden'))).rejects.toHaveProperty('code', 'ENOENT');
    expect((await state(root, id)).evidence).toHaveLength(0);
    const recovered = invoke(root, ['update', id, '--stdin'], {
      revision: observed.revision,
      reason:
        'Compared the rejected request with current authority and retained the current action.',
      plan: { nextAction: 'Execute the reconciled fixture action.' },
    });
    expect(recovered.status, recovered.output).toBe(0);
    await expect(readFile(join(root, `.work/tasks/${id}/conflict.json`))).rejects.toHaveProperty(
      'code',
      'ENOENT',
    );
    expect((await state(root, id)).notes.join('\n')).toContain(receipt.trim());
    const args =
      stage === 'C1_IMPLEMENTATION'
        ? ['exec', id, '--', process.execPath, '-e', script]
        : ['run', id, 'checks', '--', process.execPath, '-e', script];
    expect(invoke(root, args).status).toBe(0);
    expect(await readFile(join(root, '.work/forbidden'), 'utf8')).toBe('started');
  },
);

it('does not use verification to complete a failed phase transition and replaces consumed next actions', async () => {
  const root = await fixture();
  await ready(root);
  await implementing(root);
  const current = JSON.parse(invoke(root, ['context', 'probe', 'verify']).output);
  expect(
    invoke(root, ['update', 'probe', '--stdin'], {
      revision: current.revision,
      reason: 'Missing the current next action.',
      stage: 'C1_EVIDENCE_PENDING',
    }).output,
  ).toContain('WORK_NEXT_ACTION');
  expect(
    invoke(root, ['run', 'probe', 'checks', '--', process.execPath, '-e', 'process.exit(0)'])
      .output,
  ).toContain('WORK_VERIFY_STAGE');
  expect((await state(root)).evidence).toHaveLength(0);
  verifying(root);
  const before = await state(root);
  expect(run(root).status).toBe(0);
  const after = await state(root);
  expect(after.plan.nextAction).not.toBe(before.plan.nextAction);
  expect(after.plan.nextAction).toBe(
    'Review checks (pass), current originals and remaining gaps; The task declares no development result; return verified maintenance and archive when appropriate.',
  );
  expect(after.checkpoint).toEqual(before.checkpoint);
  expect(after).toMatchObject({
    stage: 'C1_EVIDENCE_PENDING',
    reviewDecision: 'PENDING',
    releaseDisposition: 'HOLD_FOR_EVIDENCE',
  });
  expect(invoke(root, ['archive', 'probe', 'Fixture maintenance completed.']).status).toBe(0);
  expect((await state(root)).plan.nextAction).toContain('Archived history');
});

it('repairs the current section on the same task without changing identity or rewriting old evidence', async () => {
  const root = await fixture();
  const created = JSON.parse(invoke(root, ['ensure', '--stdin'], proposal()).output);
  const id = created.task.id as string;
  expect(run(root, 'console.log("original evidence")', id).status).toBe(0);
  const before = await state(root, id);
  await writeFile(join(root, 'docs/api.md'), '# Current **API**\n\nRenamed heading.\n');
  expect(invoke(root, ['check', id]).output).toContain('WORK_REQUIREMENT_SECTION');
  const observed = JSON.parse(invoke(root, ['context', id, 'resume']).output);
  const request = { revision: observed.revision, reason: 'Read the renamed source heading.' };
  for (const location of [{ section: 'Missing' }, { section: 'Current API', key: 'new-task' }]) {
    expect(
      invoke(root, ['update', id, '--stdin'], { ...request, plan: { requirement: location } })
        .status,
    ).toBe(1);
    expect((await state(root, id)).plan.requirement).toEqual(requirement);
  }
  // A stale update leaves a conflict while the source itself needs a valid section correction.
  expect(
    invoke(root, ['update', id, '--stdin'], {
      ...request,
      plan: { nextAction: 'Reconcile the renamed requirement.' },
    }).status,
  ).toBe(0);
  expect(invoke(root, ['update', id, '--stdin'], request).output).toContain('WORK_CONFLICT');
  request.revision = JSON.parse(invoke(root, ['context', id, 'resume']).output).revision;
  const repaired = invoke(root, ['update', id, '--stdin'], {
    ...request,
    plan: { requirement: { section: 'Current API' } },
  });
  expect(repaired.status, repaired.output).toBe(0);
  const current = await state(root, id);
  expect(current.plan.id).toBe(id);
  expect(current.plan.requirement).toEqual({ ...requirement, section: 'Current API' });
  expect(current.evidence).toEqual(before.evidence);
  expect(current.checkpoint).toEqual(before.checkpoint);
  await expect(readFile(join(root, `.work/tasks/${id}/conflict.json`))).rejects.toHaveProperty(
    'code',
    'ENOENT',
  );
  expect(JSON.parse(repaired.output).assessment.errors.join()).toContain('WORK_CONTEXT_CHANGED');
  expect(invoke(root, ['sync', id, 'Reconciled the source heading repair.']).status).toBe(0);
  const checked = JSON.parse(invoke(root, ['check', id]).output);
  expect(checked.errors).toEqual([]);
  expect(checked.evidence.every((entry: { result: string }) => entry.result === 'pending')).toBe(
    true,
  );
  expect(JSON.parse(invoke(root, ['status']).output).tasks).toHaveLength(1);
});

it('bootstraps one complete member record when independent subtasks start concurrently', async () => {
  const root = await fixture();
  await rm(join(root, '.work'), { recursive: true });
  const pending = Array.from({ length: 12 }, (_, index) => {
    const child = spawn(process.execPath, [cli, 'ensure', '--stdin'], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '' },
      timeout: 10000,
    });
    let output = '';
    child.stdout.on('data', (bytes: Buffer) => (output += bytes.toString()));
    child.stderr.on('data', (bytes: Buffer) => (output += bytes.toString()));
    const result = new Promise<{ status: number | null; output: string }>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, output }));
    });
    return { child, result, key: `parallel-${index}` };
  });
  for (const { child, key } of pending)
    child.stdin.end(JSON.stringify({ ...proposal(), requirement: { ...requirement, key } }));
  const results = await Promise.all(pending.map(({ result }) => result));
  for (const result of results) expect(result.status, result.output).toBe(0);
  const member = JSON.parse(await readFile(join(root, '.work/member.json'), 'utf8'));
  expect(member.workspace).toBe(await realpath(root));
  expect(await readdir(join(root, '.work'))).toEqual(['member.json', 'tasks']);
  expect(await readdir(join(root, '.work/tasks'))).toHaveLength(12);
  for (const result of results) {
    const id = JSON.parse(result.output).task.id as string;
    expect((await state(root, id)).member).toBe(member.member);
  }
});

it('automatically creates a PRD subtask and resumes it after interruption without replacing progress or evidence', async () => {
  const root = await fixture();
  await rm(join(root, '.work'), { recursive: true });
  expect(JSON.parse(invoke(root, ['status']).output).tasks).toEqual([]);
  await expect(readdir(join(root, '.work'))).rejects.toHaveProperty('code', 'ENOENT');
  const first = invoke(root, ['ensure', '--stdin'], proposal());
  expect(first.status, first.output).toBe(0);
  const created = JSON.parse(first.output);
  const id = created.task.id as string;
  expect(created.created).toBe(true);
  expect(created.assessment.ready).toBe(true);
  expect(created.task.requirement).toEqual(requirement);
  expect(JSON.parse(invoke(root, ['status']).output).tasks[0].requirement).toEqual(requirement);
  expect((await state(root, id)).member).toMatch(/^local-/);
  expect(invoke(root, ['ensure', '--stdin'], proposal()).output).toContain('"created": false');
  const implementing = invoke(root, ['update', id, '--stdin'], {
    revision: created.revision,
    reason: 'Started the authorized PRD subtask.',
    stage: 'C1_IMPLEMENTATION',
    plan: { nextAction: 'Implement the authorized value change.' },
  });
  expect(implementing.status, implementing.output).toBe(0);
  const script =
    'require("node:assert/strict").equal(require("node:fs").readFileSync("src/value.ts", "utf8"), "export const value = 2;\\n")';
  expect(run(root, script, id).status).toBe(1);
  const beforePause = JSON.parse(invoke(root, ['context', id, 'resume']).output);
  expect(
    invoke(root, ['update', id, '--stdin'], {
      revision: beforePause.revision,
      reason: 'Interrupted after observing the original failing value.',
      plan: { nextAction: 'Change value to 2, then rerun the same criterion.' },
    }).status,
  ).toBe(0);
  const saved = await readFile(statePath(root, id), 'utf8');
  const resumed = invoke(root, ['ensure', '--stdin'], { requirement });
  expect(resumed.status, resumed.output).toBe(0);
  const continuation = JSON.parse(resumed.output);
  expect(continuation.task.id).toBe(id);
  expect(continuation.task.nextAction).toBe('Change value to 2, then rerun the same criterion.');
  expect(continuation.revision).not.toBe(beforePause.revision);
  expect(await readFile(statePath(root, id), 'utf8')).toBe(saved);
  expect(invoke(root, ['ensure', '--stdin'], proposal()).output).toContain('WORK_CONFLICT');
  const conflict = JSON.parse(invoke(root, ['context', id, 'resume']).output);
  expect(
    invoke(root, ['update', id, '--stdin'], {
      revision: conflict.revision,
      reason:
        'Compared the retried proposal with current progress; retain the saved next action and original evidence.',
    }).status,
  ).toBe(0);
  const reconciled = await readFile(statePath(root, id), 'utf8');
  await writeFile(join(root, 'src/value.ts'), 'export const value = 2;\n');
  const stale = JSON.parse(invoke(root, ['ensure', '--stdin'], { requirement }).output);
  expect(stale.assessment.ready).toBe(false);
  expect(stale.assessment.errors.join()).toContain('WORK_CONTEXT_CHANGED');
  expect(await readFile(statePath(root, id), 'utf8')).toBe(reconciled);
  expect(
    invoke(root, ['sync', id, 'Reviewed the value change against the PRD subtask.']).status,
  ).toBe(0);
  expect(run(root, script, id).status).toBe(0);
  const final = await state(root, id);
  expect(final.evidence.map((entry) => entry.result)).toEqual(['fail', 'pass']);
  expect(final.reviewDecision).toBe('PENDING');
  expect(final.evidence[0]!.candidate).not.toBe(final.evidence[1]!.candidate);
  expect(await readdir(join(root, '.work/tasks'))).toEqual([id]);
  expect(
    invoke(root, ['ensure', '--stdin'], {
      requirement: { ...requirement, key: 'unknown-subtask' },
    }).output,
  ).toContain('new tasks require plan.goal');
  expect(await readdir(join(root, '.work/tasks'))).toEqual([id]);
});

it('rejects stale structured updates, protected fields and invalid contracts without altering the original record', async () => {
  const root = await fixture();
  await ready(root);
  const context = JSON.parse(invoke(root, ['context', 'probe', 'resume']).output);
  const request = { revision: context.revision, reason: 'Update the verified next action.' };
  expect(
    invoke(root, ['update', 'probe', '--stdin'], { ...request, plan: { nextAction: 'Next.' } })
      .status,
  ).toBe(0);
  const saved = await readFile(statePath(root), 'utf8');
  expect(invoke(root, ['update', 'probe', '--stdin'], request).output).toContain('WORK_CONFLICT');
  const revision = JSON.parse(invoke(root, ['context', 'probe', 'resume']).output).revision;
  for (const patch of [
    { evidence: [] },
    { member: 'bob' },
    { checkpoint: null },
    { reviewDecision: 'ACCEPT' },
    { releaseDisposition: 'RELEASED' },
    { stage: 'C1_RELEASED' },
    { plan: { id: 'new-id' } },
    { plan: { requirement } },
    { plan: null },
    { plan: { acceptance: [{ id: 'bad', criterion: 'Bad', method: 'unknown' }] } },
  ]) {
    expect(
      invoke(root, ['update', 'probe', '--stdin'], { ...request, revision, ...patch }).status,
    ).toBe(1);
    expect(await readFile(statePath(root), 'utf8')).toBe(saved);
  }
});

it.each([false, true])(
  'keeps rejected C1 requests unsaved and recovers the intended contract (already implementing: %s)',
  async (alreadyImplementing) => {
    const root = await fixture();
    await ready(root);
    if (alreadyImplementing) await implementing(root);
    const saved = await readFile(statePath(root), 'utf8');
    const original = await state(root);
    const plan = { goal: 'An authorized revised goal.', nextAction: 'Implement the revised goal.' };
    const rejected = invoke(root, ['update', 'probe', '--stdin'], {
      revision: digest(saved),
      reason: 'Revise the goal while requesting C1.',
      stage: 'C1_IMPLEMENTATION',
      plan,
    });
    expect(rejected.status).toBe(1);
    expect(rejected.output).toContain('WORK_CONTEXT_CHANGED');
    expect(rejected.output).toContain('rejected before saving any task changes');
    expect(await readFile(statePath(root), 'utf8')).toBe(saved);
    expect(
      invoke(root, ['sync', 'probe', 'Inspect the persisted record after rejection.']).status,
    ).toBe(0);
    expect((await state(root)).plan.goal).toBe(original.plan.goal);
    expect((await state(root)).stage).toBe(original.stage);
    const current = JSON.parse(invoke(root, ['context', 'probe', 'resume']).output);
    const changed = invoke(root, ['update', 'probe', '--stdin'], {
      revision: current.revision,
      reason: 'Save only the intended contract before reconciliation.',
      plan,
    });
    expect(changed.status, changed.output).toBe(0);
    expect(JSON.parse(changed.output).assessment.checkedReady).toBe(false);
    expect((await state(root)).plan.goal).toBe(plan.goal);
    expect(
      invoke(root, ['sync', 'probe', 'Reconciled the saved goal and actual files.']).status,
    ).toBe(0);
    await implementing(root);
    expect((await state(root)).stage).toBe('C1_IMPLEMENTATION');
    expect((await state(root)).plan.goal).toBe(plan.goal);
  },
);

it('recovers a C1 request rejected for file drift without inventing a contract update', async () => {
  const root = await fixture();
  await ready(root);
  const saved = await readFile(statePath(root), 'utf8');
  const original = await state(root);
  await writeFile(join(root, 'src/value.ts'), 'export const value = 2;\n');
  const rejected = invoke(root, ['update', 'probe', '--stdin'], {
    revision: digest(saved),
    reason: 'Request C1 before reconciling an actual file change.',
    stage: 'C1_IMPLEMENTATION',
    plan: { nextAction: 'Continue authorized implementation.' },
  });
  expect(rejected.status).toBe(1);
  expect(rejected.output).toContain('WORK_CONTEXT_CHANGED: src/value.ts');
  expect(await readFile(statePath(root), 'utf8')).toBe(saved);
  expect(invoke(root, ['sync', 'probe', 'Reviewed the changed source file.']).status).toBe(0);
  await implementing(root);
  const final = await state(root);
  expect(final.stage).toBe('C1_IMPLEMENTATION');
  expect(final.checkpoint!.contract).toBe(original.checkpoint!.contract);
  expect(final.checkpoint!.candidate).not.toBe(original.checkpoint!.candidate);
});

it('invalidates release on structured contract changes while preserving old evidence and requiring sync', async () => {
  const root = await fixture();
  await ready(root);
  expect(run(root).status).toBe(0);
  await accept(root);
  const original = await state(root);
  const current = JSON.parse(invoke(root, ['context', 'probe', 'resume']).output);
  const progress = JSON.parse(
    invoke(root, ['update', 'probe', '--stdin'], {
      revision: current.revision,
      reason: 'Only the next action changed.',
      plan: { nextAction: 'Wait for the next user instruction.' },
    }).output,
  );
  expect(progress.assessment.ready).toBe(true);
  expect((await state(root)).releaseDisposition).toBe('RELEASED');
  const changed = invoke(root, ['update', 'probe', '--stdin'], {
    revision: progress.revision,
    reason: 'User changed the required criterion.',
    plan: {
      acceptance: [
        {
          id: 'checks',
          criterion: 'A new required result.',
          method: 'automated',
          command: [process.execPath, '-e', 'console.log("observed probe")'],
        },
      ],
    },
  });
  expect(changed.status, changed.output).toBe(0);
  const task = await state(root);
  expect(task.stage).toBe('C1_EVIDENCE_PENDING');
  expect(task.reviewDecision).toBe('PENDING');
  expect(task.evidence).toEqual(original.evidence);
  expect(task.checkpoint).toEqual(original.checkpoint);
  expect(task.plan.nextAction).toContain('Reconcile the changed contract');
  expect(JSON.parse(changed.output).assessment.errors.join()).toContain('WORK_CONTEXT_CHANGED');
  expect(invoke(root, ['sync', 'probe', 'Reconciled the new acceptance target.']).status).toBe(0);
  expect(JSON.parse(invoke(root, ['check', 'probe']).output).evidence[0].result).toBe('pending');
});

it('keeps PRD source binding and requires explicit current authorization to reopen archived work', async () => {
  const root = await fixture();
  const result = JSON.parse(invoke(root, ['ensure', '--stdin'], proposal()).output);
  const id = result.task.id as string;
  expect((await state(root, id)).checkpoint!.files).toHaveProperty('docs/api.md');
  expect(invoke(root, ['archive', id, 'Paused by user.']).status).toBe(0);
  const archived = JSON.parse(invoke(root, ['ensure', '--stdin'], { requirement }).output);
  expect(archived.task.archived).toBe(true);
  const request = {
    revision: archived.revision,
    reason: 'User requests this subtask again.',
    reopen: true,
    plan: { nextAction: 'Reconcile this task against the new request.' },
  };
  expect(invoke(root, ['update', id, '--stdin'], request).output).toContain('reopening requires');
  expect(
    invoke(root, ['update', id, '--stdin'], {
      ...request,
      plan: {
        authorization: 'Current user explicitly requests resuming this subtask.',
        nextAction: 'Reconcile the current candidate and continue the authorized subtask.',
      },
    }).status,
  ).toBe(0);
  expect((await state(root, id)).archived).toBe(false);
  expect(invoke(root, ['check', id]).output).toContain('WORK_CONTEXT_CHANGED');
  expect(invoke(root, ['sync', id, 'Reconciled the new authorization.']).status).toBe(0);
  await writeFile(join(root, 'docs/api.md'), '# API\nUpdated PRD contract.\n');
  expect(invoke(root, ['check', id]).output).toContain('WORK_CONTEXT_CHANGED');
  const original = await readFile(statePath(root, id), 'utf8');
  expect(
    invoke(root, ['ensure', '--stdin'], { requirement: { ...requirement, section: 'Other' } })
      .output,
  ).toContain('WORK_CONFLICT');
  expect(await readFile(statePath(root, id), 'utf8')).toBe(original);
  expect(
    invoke(root, ['ensure', '--stdin'], {
      ...proposal(),
      requirement: { ...requirement, source: '.work/private.md' },
    }).output,
  ).toContain('WORK_PRIVATE');
});

it('preserves requirement identity across handoff while clearing recipient authority and evidence', async () => {
  const sender = await fixture();
  const first = JSON.parse(invoke(sender, ['ensure', '--stdin'], proposal()).output);
  const id = first.task.id as string;
  const portable = invoke(sender, ['handoff', id]);
  expect(portable.status, portable.output).toBe(0);
  const receiver = await fixture('bob');
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

it('offers start guidance without personal records and returns only the selected action', async () => {
  const root = await fixture();
  await rm(join(root, '.work'), { recursive: true });
  const start = invoke(root, ['guide', 'start']);
  expect(start.status, start.output).toBe(0);
  expect(JSON.parse(start.output).reading.map((item: { ref: string }) => item.ref)).toEqual([
    'docs/coordination.md#共同规则',
    'docs/coordination.md#开始任务',
    'docs/work-records.md#创建任务',
  ]);
  expect(start.output).not.toContain('## 跨人交接');
  expect(start.output).not.toContain('## 记录结构');
  const before = start.output;
  await writeFile(
    join(root, 'docs/coordination.md'),
    (await readFile(join(root, 'docs/coordination.md'), 'utf8')) +
      '\n## 无关模式\nunrelated newly added mode\n',
  );
  expect(invoke(root, ['guide', 'start']).output).toBe(before);
  expect(invoke(root, ['guide', 'constructor']).output).toContain('WORK_ACTION');
});

it('does not interpret example headings as guide sections and rejects absent or duplicate routing targets', async () => {
  const root = await fixture();
  const path = join(root, 'docs/coordination.md');
  await writeFile(
    path,
    '# Guide\n## 共同规则\nPreserve common obligations.\n## 开始任务\nCurrent task.\n```md\n## example heading\n```\n## 跨人交接\nforeign-mode-marker\n',
  );
  const result = invoke(root, ['guide', 'start']);
  expect(result.status).toBe(0);
  expect(result.output).not.toContain('example heading');
  const expanded = invoke(root, ['guide', 'start', '--section', 'docs/coordination.md#开始任务']);
  expect(expanded.status, expanded.output).toBe(0);
  expect(expanded.output).toContain('example heading');
  expect(result.output).not.toContain('foreign-mode-marker');
  await writeFile(path, '# Missing route\n');
  expect(invoke(root, ['guide', 'start']).output).toContain('WORK_GUIDE_SECTION');
  await writeFile(path, '## 共同规则\none\n## 共同规则\ntwo\n');
  expect(invoke(root, ['guide', 'start']).output).toContain('WORK_GUIDE_SECTION');
});

it('resumes from current facts without returning history/raw logs and keeps older records readable', async () => {
  const root = await fixture();
  await ready(root);
  expect(run(root, 'console.log("raw-log-marker")').status).toBe(0);
  await edit(root, (task) => {
    task.notes = ['historical-note-marker'];
    task.plan.sources.push('AGENTS.md', 'docs/coordination.md', 'docs/work-records.md');
  });
  expect(invoke(root, ['sync', 'probe', 'Old default source list retained.']).status).toBe(0);
  const before = await readFile(statePath(root), 'utf8');
  const output = invoke(root, ['context', 'probe', 'resume']);
  expect(output.status, output.output).toBe(0);
  const result = JSON.parse(output.output);
  expect(result.task.authorization).toBe((await state(root)).plan.authorization);
  expect(result.task.goal).toBe((await state(root)).plan.goal);
  expect(result.reading.map((item: { ref: string }) => item.ref)).toEqual([
    'docs/coordination.md#共同规则',
    'docs/coordination.md#恢复与同步',
    'docs/work-records.md#核对与同步',
  ]);
  expect(output.output).not.toContain('historical-note-marker');
  expect(output.output).not.toContain('raw-log-marker');
  expect(output.output).not.toContain('## 发送与接收');
  expect(await readFile(statePath(root), 'utf8')).toBe(before);
  await edit(root, (task) => {
    task.plan.inputs.push('missing.ts');
  });
  const blocked = JSON.parse(invoke(root, ['context', 'probe', 'resume']).output);
  expect(blocked.assessment.ready).toBe(false);
  expect(blocked.task.goal).toBe(result.task.goal);
});

it.each(['start', 'resume', 'implement', 'verify', 'deliver', 'handoff', 'archive'])(
  'can resolve the real documentation for %s',
  async (action) => {
    const root = await fixture();
    const result = invoke(root, ['guide', action]);
    expect(result.status, result.output).toBe(0);
    expect(JSON.parse(result.output).reading[0].ref).toBe('docs/coordination.md#共同规则');
  },
);

it.each(['verify', 'deliver', 'handoff', 'archive'])(
  'exposes the same handback reconciliation through guide and current task context for %s',
  async (action) => {
    const root = await fixture();
    await ready(root);
    const ref = 'docs/coordination.md#交回与下一步';
    for (const args of [
      ['guide', action],
      ['context', 'probe', action],
    ]) {
      const result = invoke(root, args);
      expect(result.status, result.output).toBe(0);
      const reading = JSON.parse(result.output).reading as { ref: string }[];
      expect(reading.some((entry) => entry.ref === ref)).toBe(true);
    }
    const expanded = invoke(root, [
      'guide',
      action,
      '--section',
      ref,
      '--select',
      '/blocks',
      '--limit',
      '20',
    ]);
    expect(expanded.status, expanded.output).toBe(0);
    const page = JSON.parse(expanded.output);
    let body = '';
    for (let index = 0; index < page.page.total; index++) {
      let offset = 0;
      do {
        const part = invoke(root, [
          'guide',
          action,
          '--section',
          ref,
          '--select',
          `/blocks/${index}/body`,
          '--offset',
          String(offset),
          '--limit',
          '2048',
        ]);
        expect(part.status, part.output).toBe(0);
        const text = JSON.parse(part.output);
        body += `${text.text}\n`;
        offset += text.page.count;
        if (!text.page.next) break;
      } while (true);
    }
    expect(body).toContain('需求与方案');
    expect(body).toContain('现行规范');
    expect(body).toContain('已接受成果');
    expect(body).toContain('取消、暂缓或未完成交接保留缺口');
    expect(body).toContain('不是实时成果镜像');
    expect(body).toContain('修正对应权威页后重验');
    expect(body).toContain('不能把待接受标成已接受');
    if (action !== 'deliver') expect(body).not.toContain('## 交付命令');
  },
);

it('preserves current decision authority and blocking reasons in progressive summaries', async () => {
  const root = await fixture();
  await ready(root);
  await edit(root, (task) => {
    task.plan.decisions = [
      { status: 'CONFIRMED', text: 'Preserve caller identity.', source: 'Current human contract' },
      { status: 'AI_PROPOSED', text: 'Optional implementation idea.', source: 'Agent proposal' },
    ];
  });
  expect(
    invoke(root, [
      'sync',
      'probe',
      'Read the confirmed decision and retained the proposal as a proposal.',
    ]).status,
  ).toBe(0);
  const current = JSON.parse(invoke(root, ['context', 'probe', 'implement']).output);
  expect(current.task.decisions).toEqual((await state(root)).plan.decisions);
  await edit(root, (task) => {
    task.plan.decisions.push({
      status: 'OPEN',
      text: 'Choose the shared contract.',
      source: 'Unresolved human decision',
    });
  });
  const blocked = JSON.parse(invoke(root, ['context', 'probe', 'resume']).output);
  expect(blocked.assessment.ready).toBe(false);
  expect(blocked.task.decisions.at(-1)).toEqual({
    status: 'OPEN',
    text: 'Choose the shared contract.',
    source: 'Unresolved human decision',
  });
  expect(blocked.task.reviewDecision).toBe('PENDING');
  expect(blocked.task.archived).toBe(false);
});

it('requires a real task contract and never treats a fresh draft or passing check as human acceptance', async () => {
  const root = await fixture();
  expect(invoke(root, ['start', 'draft', 'A goal']).status).toBe(0);
  const before = await readFile(statePath(root, 'draft'), 'utf8');
  expect(invoke(root, ['check', 'draft']).output).toContain('WORK_CONTRACT');
  expect(await readFile(statePath(root, 'draft'), 'utf8')).toBe(before);
  await ready(root);
  expect((await state(root)).stage).toBe('C0_READY');
  await accept(root);
  expect(invoke(root, ['check', 'probe']).output).toContain('WORK_RELEASE');
  await edit(root, (task) => {
    task.stage = 'C1_IMPLEMENTATION';
    task.releaseDisposition = 'HOLD_FOR_EVIDENCE';
    task.reviewDecision = 'PENDING';
  });
  expect(run(root).status).toBe(0);
  expect((await state(root)).reviewDecision).toBe('PENDING');
  await accept(root);
  expect(invoke(root, ['check', 'probe']).status).toBe(0);
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

it('detects changed child documents read-only, rejects execution, and retains stale evidence after reconciliation', async () => {
  const root = await fixture();
  await ready(root);
  expect(run(root).status).toBe(0);
  await accept(root);
  await writeFile(join(root, 'docs/api.md'), '# Changed API contract\n');
  const before = await readFile(statePath(root), 'utf8');
  const check = invoke(root, ['check', 'probe']);
  expect(check.status).toBe(1);
  expect(check.output).toContain('docs/api.md');
  expect(await readFile(statePath(root), 'utf8')).toBe(before);
  expect(run(root).output).toContain('WORK_CONTEXT_CHANGED');
  expect(invoke(root, ['sync', 'probe', 'Read changed API and rechecked its impact.']).status).toBe(
    0,
  );
  const task = await state(root);
  expect(task.evidence).toHaveLength(2);
  expect(task.stage).toBe('C1_EVIDENCE_PENDING');
  expect(task.reviewDecision).toBe('PENDING');
  expect(JSON.parse(invoke(root, ['check', 'probe']).output).evidence[0].result).toBe('pending');
  expect(run(root).status).toBe(0);
});

it('captures new untracked scoped files and fails an otherwise successful check that changes its own input', async () => {
  const root = await fixture();
  await ready(root);
  await writeFile(join(root, 'src/new.ts'), 'export const next = 2;');
  expect(invoke(root, ['check', 'probe']).output).toContain('src/new.ts');
  expect(invoke(root, ['sync', 'probe', 'Reviewed the new source.']).status).toBe(0);
  const outcome = run(
    root,
    'require("node:fs").writeFileSync("src/value.ts", "export const value = 3;")',
  );
  expect(outcome.status).toBe(1);
  expect(outcome.output).toContain('WORK_CONTEXT_CHANGED');
  const task = await state(root);
  expect(task.evidence[0]!.result).toBe('pending');
  expect(task.plan.nextAction).toBe(
    'Inspect the observed input changes and current authorization before sync and verification of the resulting candidate.',
  );
});

it('binds evidence to acceptance changes while allowing next-action updates without a new candidate', async () => {
  const root = await fixture();
  await ready(root);
  expect(run(root).status).toBe(0);
  await edit(root, (task) => {
    task.plan.nextAction = 'Return results.';
  });
  expect(invoke(root, ['check', 'probe']).status).toBe(0);
  await edit(root, (task) => {
    task.plan.acceptance[0]!.criterion = 'Different required behavior.';
  });
  expect(invoke(root, ['check', 'probe']).output).toContain('task contract');
});

it('does not pass evidence for temporary input bytes that a command restores before exiting', async () => {
  const root = await fixture();
  await ready(root);
  const original = await readFile(join(root, 'src/value.ts'), 'utf8');
  const script =
    'const fs=require("node:fs");const p="src/value.ts";const original=fs.readFileSync(p);fs.writeFileSync(p,"temporary candidate");if(fs.readFileSync(p,"utf8")!=="temporary candidate")process.exit(2);fs.writeFileSync(p,original);';
  expect(run(root, script).status).toBe(1);
  expect(await readFile(join(root, 'src/value.ts'), 'utf8')).toBe(original);
  expect((await state(root)).evidence[0]!.result).toBe('pending');
  await accept(root);
  expect(invoke(root, ['check', 'probe']).output).toContain('WORK_RELEASE');
});

it('can refresh missing release evidence without manually bypassing release checks', async () => {
  const root = await fixture();
  await ready(root);
  expect(run(root).status).toBe(0);
  await accept(root);
  const task = await state(root);
  await rm(join(root, task.evidence[0]!.artifact));
  expect(invoke(root, ['check', 'probe']).output).toContain('WORK_RELEASE');
  expect(run(root).status).toBe(0);
  const refreshed = await state(root);
  expect(refreshed.evidence).toHaveLength(3);
  expect(refreshed.stage).toBe('C1_EVIDENCE_PENDING');
  expect(refreshed.reviewDecision).toBe('PENDING');
  expect(invoke(root, ['check', 'probe']).status).toBe(0);
});

it('requires revision reconciliation and reuses same-content evidence after a commit', async () => {
  const root = await fixture();
  await ready(root);
  expect(run(root).status).toBe(0);
  const candidate = (await state(root)).checkpoint!.candidate;
  expect(spawnSync('git', ['add', '.'], { cwd: root }).status).toBe(0);
  expect(
    spawnSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '-qm',
        'fixture',
      ],
      { cwd: root },
    ).status,
  ).toBe(0);
  expect(invoke(root, ['check', 'probe']).output).toContain('WORK_REVISION_CHANGED');
  expect(invoke(root, ['sync', 'probe', 'Verified the commit preserved task inputs.']).status).toBe(
    0,
  );
  expect((await state(root)).checkpoint!.candidate).toBe(candidate);
  expect(JSON.parse(invoke(root, ['check', 'probe']).output).evidence[0].result).toBe('pass');
});

it('keeps sibling tasks independent and archives in place without deleting their evidence', async () => {
  const root = await fixture();
  await ready(root);
  await ready(root, 'second');
  const second = await readFile(statePath(root, 'second'), 'utf8');
  expect(run(root).status).toBe(0);
  const originals = (await readdir(join(root, '.work/tasks/probe/evidence'))).sort();
  expect(originals).toHaveLength(2);
  expect(
    invoke(root, ['archive', 'probe', 'Cancelled by the fixture user; preserve the result.'])
      .status,
  ).toBe(0);
  expect(invoke(root, ['check', 'probe']).output).toContain('WORK_ARCHIVED');
  expect(run(root).status).toBe(1);
  expect(await readFile(statePath(root, 'second'), 'utf8')).toBe(second);
  expect((await readdir(join(root, '.work/tasks/probe/evidence'))).sort()).toEqual(originals);
});

it('captures the public environment template while leaving private environment files outside candidate inputs', async () => {
  const root = await fixture();
  await writeFile(join(root, '.env.example'), 'MIO_ENVIRONMENT=dev\n');
  await writeFile(join(root, '.env.test'), 'SECRET=private\n');
  await ready(root);
  await edit(root, (task) => {
    task.plan.inputs.push('.env.example');
  });
  expect(invoke(root, ['sync', 'probe', 'Include the public environment template.']).status).toBe(
    0,
  );
  const task = await state(root);
  expect(task.checkpoint!.files['.env.example']).toBeDefined();
  expect(task.checkpoint!.files['.env.test']).toBeUndefined();
  await writeFile(join(root, '.env.example'), 'MIO_ENVIRONMENT=test\n');
  expect(invoke(root, ['check', 'probe']).output).toContain('WORK_CONTEXT_CHANGED');
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
  expect(invoke(root, ['check', 'probe']).output).toContain('INVENTORY_SYMLINK');
  await rm(join(root, 'src/alias.ts'));
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
  const start = await readFile(join(root, task.evidence[0]!.artifact), 'utf8');
  expect(digest(start)).toBe(task.evidence[0]!.sha256);
  expect(await readFile(join(root, JSON.parse(start).rawLog), 'utf8')).toContain('"exitCode": 0');
  expect(await readdir(join(root, '.work/tasks/probe/evidence'))).toHaveLength(2);
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
  const original =
    '# Actual observation\nEnvironment and actions.\n\n```mio-evidence\n' +
    JSON.stringify({
      candidate: (await state(root)).checkpoint!.candidate,
      criterion: 'observe',
      result: 'pass',
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
  const candidateA = (await state(root)).checkpoint!.candidate;
  const original = (report: unknown) =>
    '# Actual fixture observation\n\n```mio-evidence\n' + JSON.stringify(report) + '\n```\n';
  const report = { candidate: candidateA, criterion: 'observe', result: 'pass' };
  await writeFile(join(root, relative), original(report));
  await implementing(root);
  await writeFile(join(root, 'src/value.ts'), 'export const value = 2;\n');
  expect(invoke(root, ['sync', 'probe', 'Reviewed the changed fixture source.']).status).toBe(0);
  verifying(root);
  const candidateB = (await state(root)).checkpoint!.candidate;
  expect(candidateB).not.toBe(candidateA);
  const before = await readFile(statePath(root), 'utf8');
  for (const body of [
    original(report),
    'An unbound historical observation.',
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
  expect(
    invoke(root, ['evidence', 'probe', 'observe', 'pass', relative, 'Old call.']).output,
  ).toContain('WORK_EVIDENCE');
  expect(
    invoke(root, ['evidence', 'probe', 'checks', relative, 'Pretend automated.']).output,
  ).toContain('automated checks use work run');
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
  expect((await state(root)).evidence.at(-1)!.candidate).toBe(candidateB);
}, 30_000);

it('rejects linked original aliases at registration and when checking previously registered evidence', async () => {
  const root = await fixture();
  await ready(root);
  verifying(root);
  const relative = '.work/tasks/probe/evidence/review.md';
  await mkdir(dirname(join(root, relative)), { recursive: true });
  const content = reviewMarkdown(reviewFixture((await state(root)).checkpoint!.candidate));
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

it('rejects a manual original that is itself a candidate input before attempting candidate binding', async () => {
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
  expect(rejected.output).toContain('WORK_EVIDENCE_INPUT');
  expect(await readFile(statePath(root), 'utf8')).toBe(before);
  const copy = '.work/tasks/probe/evidence/shared-review-copy.md';
  await mkdir(dirname(join(root, copy)), { recursive: true });
  await writeFile(
    join(root, copy),
    '# Retrieved observation\n\n```mio-evidence\n' +
      JSON.stringify({
        candidate: (await state(root)).checkpoint!.candidate,
        criterion: 'inspect',
        result: 'pending',
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
  expect(changed.candidate).not.toBe(first.assessment.candidate);
  expect(
    changed.evidence.find((item: { criterion: string }) => item.criterion === 'checks').result,
  ).toBe('pending');
  expect(invoke(root, ['sync', id, 'Inspected the moved source and stable mapping.']).status).toBe(
    0,
  );
  const current = await state(root, id);
  expect(Object.keys(current.checkpoint!.files)).toEqual(
    expect.arrayContaining(['docs/tasks/example/prd.md', 'docs/api.md', 'harness.config.json']),
  );
  await writeFile(
    join(root, 'docs/tasks/example/prd.md'),
    '# API\n\nChanged actual requirement.\n',
  );
  expect(invoke(root, ['check', id]).output).toContain('docs/tasks/example/prd.md');
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
  expect(changed.errors.join(' ')).toContain('WORK_CONTEXT_CHANGED');
  expect(changed.errors.join(' ')).not.toContain('WORK_SOURCE');
  expect(
    invoke(root, ['sync', id, 'Inspected removal of an unused physical redirect.']).status,
  ).toBe(0);
  const current = await state(root, id);
  expect(Object.keys(current.checkpoint!.files)).toContain(path);
  expect(Object.keys(current.checkpoint!.files)).toContain('harness.config.json');
  expect(Object.keys(current.checkpoint!.files)).not.toContain(requirement.source);
  expect(current.evidence).toEqual(JSON.parse(before).evidence);
  expect(JSON.parse(invoke(root, ['check', id]).output).evidence[0].result).toBe('pending');
  await writeFile(join(root, path), '# API\n\nChanged current requirement.\n');
  expect(invoke(root, ['check', id]).output).toContain(path);
});

it('retrieves classified tasks artifacts and receives an exact-code handoff from a registered task proposal', async () => {
  const sender = await fixture('alice');
  const receiver = await fixture('bob');
  const shared = 'docs/tasks/example/handoff.md';
  for (const root of [sender, receiver]) {
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
  const first = invoke(sender, ['ensure', '--stdin'], proposal());
  expect(first.status, first.output).toBe(0);
  const id = JSON.parse(first.output).task.id as string;
  const portable = invoke(sender, ['handoff', id]);
  expect(portable.status, portable.output).toBe(0);
  const bytes = await readFile(portable.output, 'utf8');
  await writeFile(join(receiver, shared), bytes);
  expect((await artifact(receiver, id, shared)).toString('utf8')).toBe(bytes);
  const received = invoke(receiver, ['receive', shared]);
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

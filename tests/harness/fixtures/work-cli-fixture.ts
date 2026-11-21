import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect } from 'vitest';
import type { Task } from '../../../scripts/harness/work/records.ts';
import { contractPlan, taskRevision } from '../../../scripts/harness/work/records.ts';
import { reviewFixture, reviewMarkdown } from './quality-review-fixture.ts';

const project = resolve('.');
export const cli = join(project, 'scripts/harness/work/cli.ts');
export const scratch: string[] = [];
export const commands: ReturnType<typeof begin>[] = [];

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

export function begin(root: string, args: string[], timeout = 10_000) {
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

export async function fixture(actor = 'alice') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mio-work-')));
  scratch.push(root);
  await cp(join(project, 'harness.config.json'), join(root, 'harness.config.json'));
  for (const [file, source] of Object.entries({
    'package.json': '{"type":"module"}\n',
    '.gitignore': '.work/\n.env.test\n',
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
  for (const args of [
    ['config', 'user.name', 'Fixture'],
    ['config', 'user.email', 'fixture@example.test'],
    ['add', '-A'],
    ['commit', '-q', '-m', 'Initial fixture'],
  ])
    expect(spawnSync('git', args, { cwd: root }).status).toBe(0);
  expect(invoke(root, ['init', actor]).status).toBe(0);
  return root;
}

// The child has no Skill paths, Codex tools or conversation history; all behavior enters the real CLI.
export function invoke(root: string, args: string[], input?: unknown) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
    timeout: 10000,
    ...(input === undefined ? {} : { input: JSON.stringify(input) }),
  });
  return {
    status: result.status,
    stdout: result.stdout,
    output: `${result.stdout}\n${result.stderr}`.trim(),
  };
}

export const statePath = (root: string, id = 'probe') => join(root, `.work/tasks/${id}/state.json`);
export const state = async (root: string, id = 'probe'): Promise<Task> =>
  JSON.parse(await readFile(statePath(root, id), 'utf8'));

export function commitFixture(root: string, message: string, paths: string[]) {
  const added = spawnSync('git', ['add', '-A', '--', ...paths], { cwd: root, encoding: 'utf8' });
  expect(added.status, added.stderr).toBe(0);
  const committed = spawnSync('git', ['commit', '-q', '-m', message], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(committed.status, committed.stderr).toBe(0);
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
}

export function fetchFixtureCommit(receiver: string, sender: string) {
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: sender,
    encoding: 'utf8',
  }).stdout.trim();
  const fetched = spawnSync('git', ['fetch', '-q', sender, commit], {
    cwd: receiver,
    encoding: 'utf8',
  });
  expect(fetched.status, fetched.stderr).toBe(0);
  const checkout = spawnSync('git', ['checkout', '-q', '--detach', 'FETCH_HEAD'], {
    cwd: receiver,
    encoding: 'utf8',
  });
  expect(checkout.status, checkout.stderr).toBe(0);
  return commit;
}

export async function edit(root: string, change: (task: Task) => void, id = 'probe') {
  const task = await state(root, id);
  change(task);
  await writeFile(statePath(root, id), JSON.stringify(task));
}

export async function ready(root: string, id = 'probe') {
  expect(invoke(root, ['start', id, 'Verify the probe', 'docs/api.md']).status).toBe(0);
  const revision = taskRevision(await state(root, id));
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

export async function implementing(root: string) {
  const revision = taskRevision(await state(root));
  const result = invoke(root, ['update', 'probe', '--stdin'], {
    revision,
    reason: 'The fixture user authorized the implementation command.',
    stage: 'C1_IMPLEMENTATION',
    plan: { nextAction: 'Implement the authorized probe changes.' },
  });
  expect(result.status, result.output).toBe(0);
}

export function verifying(root: string, id = 'probe') {
  const raw = readFileSync(statePath(root, id));
  const current = JSON.parse(raw.toString()) as Task;
  if (current.stage === 'C1_EVIDENCE_PENDING') return;
  if (!current.checkpoint) {
    const synced = invoke(root, ['sync', id, 'Reviewed the clean fixture commit and contract.']);
    expect(synced.status, synced.output).toBe(0);
  }
  const latest = JSON.parse(readFileSync(statePath(root, id), 'utf8')) as Task;
  const result = invoke(root, ['update', id, '--stdin'], {
    revision: taskRevision(latest),
    reason: 'The fixture explicitly chooses verification of its existing candidate.',
    stage: 'C1_EVIDENCE_PENDING',
    plan: { nextAction: 'Collect the authorized fixture observations.' },
  });
  expect(result.status, result.output).toBe(0);
}

export function run(root: string, script = 'console.log("observed probe")', id = 'probe') {
  verifying(root, id);
  return invoke(root, ['run', id, 'checks', '--', process.execPath, '-e', script]);
}

export async function accept(root: string) {
  verifying(root);
  const current = await state(root);
  const relative = `.work/tasks/probe/evidence/review-${current.evidence.length}.md`;
  await mkdir(dirname(join(root, relative)), { recursive: true });
  await writeFile(
    join(root, relative),
    reviewMarkdown({
      ...reviewFixture(current.checkpoint!.candidate),
      contract: contractPlan(current),
    }),
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

export const requirement = { source: 'docs/api.md', section: 'API', key: 'value-probe' };

export function proposal() {
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

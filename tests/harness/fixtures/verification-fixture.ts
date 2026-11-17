import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect } from 'vitest';
import type { Task } from '../../../scripts/harness/work/records.ts';

const project = resolve('.');
const cli = join(project, 'scripts/harness/work/cli.ts');
const roots: string[] = [];
export const fullCommand = [process.execPath, '-e', 'console.log("complete fixture check")'];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

export function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

export async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mio-verification-')));
  roots.push(root);
  await cp(join(project, 'harness.config.json'), join(root, 'harness.config.json'));
  for (const [path, content] of Object.entries({
    'package.json': '{"type":"module"}\n',
    '.gitignore': '.work/\n',
    'AGENTS.md': '# Development\n',
    'docs/api.md': '# API\n',
    'src/value.ts': 'export const value = 1;\n',
  })) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  for (const path of [
    'docs/coordination.md',
    'docs/work-records.md',
    'docs/engineering/testing.md',
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await cp(join(project, path), join(root, path));
  }
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'user.email', 'fixture@example.test']);
  commit(root, 'Initial fixture');
  return root;
}

export async function cloneFixture(source: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mio-verification-clone-')));
  roots.push(root);
  git(root, ['clone', '-q', source, '.']);
  return root;
}

export function commit(root: string, message: string) {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

export function invoke(root: string, args: string[], input?: unknown) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
    timeout: 10_000,
    ...(input === undefined ? {} : { input: JSON.stringify(input) }),
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}`.trim() };
}

export function ok(root: string, args: string[], input?: unknown) {
  const result = invoke(root, args, input);
  expect(result.status, result.output).toBe(0);
  return result.output;
}

export function create(root: string, key = 'source', command = fullCommand) {
  const created = JSON.parse(
    ok(root, ['ensure', '--stdin'], {
      requirement: { source: 'docs/api.md', section: 'API', key },
      plan: {
        goal: `Verify ${key}`,
        result: null,
        scope: ['src/value.ts'],
        sources: ['docs/api.md'],
        authorization: 'Fixture authorizes local checks.',
        nonGoals: ['No external services.'],
        acceptance: [
          { id: 'checks', method: 'automated', criterion: 'Run complete check.', command },
        ],
        nextAction: 'Implement the fixture.',
        stopCondition: 'Return observations.',
      },
    }),
  );
  const id = created.task.id as string;
  ok(root, ['update', id, '--stdin'], {
    revision: created.revision,
    reason: 'Fixture starts authorized implementation.',
    stage: 'C1_IMPLEMENTATION',
    plan: { nextAction: 'Prepare the fixture.' },
  });
  return id;
}

export function verifyReady(root: string, id: string) {
  ok(root, ['sync', id, 'Reviewed the clean fixture commit and contract.']);
  const current = JSON.parse(ok(root, ['context', id, 'verify']));
  ok(root, ['update', id, '--stdin'], {
    revision: current.revision,
    reason: 'Fixture starts evidence collection.',
    stage: 'C1_EVIDENCE_PENDING',
    plan: { nextAction: 'Run checks.' },
  });
}

export async function state(root: string, id: string): Promise<Task> {
  return JSON.parse(await readFile(join(root, `.work/tasks/${id}/state.json`), 'utf8'));
}

export function check(root: string, id: string) {
  const result = invoke(root, ['check', id]);
  return JSON.parse(result.output.slice(0, result.output.lastIndexOf('}') + 1));
}

export function begin(root: string, id: string, args: string[]) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '' },
  });
  let output = '';
  child.stdout.on('data', (bytes: Buffer) => {
    output += bytes.toString();
  });
  child.stderr.on('data', (bytes: Buffer) => {
    output += bytes.toString();
  });
  child.stdin.end();
  const finished = new Promise<{ status: number | null; output: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, output }));
  });
  return { id, child, finished };
}

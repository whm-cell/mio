import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect } from 'vitest';
import type { Evidence, Task } from '../scripts/harness/work/records.ts';
import type { EvidenceRef } from '../scripts/harness/work/verification-format.ts';

const project = resolve('.');
export const fullCommand = [
  process.execPath,
  '-e',
  "const f=require('node:fs');f.appendFileSync('.work/count','full\\n')",
];
export const testConditions = {
  dependencies: 'Node builtins only; fixture has no installed packages',
  configuration: 'Fixture package.json and src inputs; no extra configuration',
  external: 'No external services; isolated local fixture',
};
export function invoke(root: string, args: string[], input?: unknown) {
  const result = spawnSync(
    process.execPath,
    [join(project, 'scripts/harness/work/cli.ts'), ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH ?? '' },
      timeout: 10000,
      ...(input === undefined ? {} : { input: JSON.stringify(input) }),
    },
  );
  return { status: result.status, output: `${result.stdout}\n${result.stderr}`.trim() };
}
export function ok(root: string, args: string[], input?: unknown) {
  const result = invoke(root, args, input);
  expect(result.status, result.output).toBe(0);
  return result.output;
}
export async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mio-verification-')));
  await cp(join(project, 'harness.config.json'), join(root, 'harness.config.json'));
  for (const [path, content] of Object.entries({
    'package.json': '{"type":"module"}',
    '.gitignore': '.work/\n',
    'AGENTS.md': '# Development',
    'docs/api.md': '# API',
    'src/value.ts': 'export const value = 1;\n',
    'src/stable.ts': 'export const stable = true;\n',
  })) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  for (const file of ['docs/coordination.md', 'docs/work-records.md'])
    await cp(join(project, file), join(root, file));
  expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
  return root;
}
export function create(root: string, key = 'source', command = fullCommand) {
  const created = JSON.parse(
    ok(root, ['ensure', '--stdin'], {
      requirement: { source: 'docs/api.md', section: 'API', key },
      plan: {
        goal: `Verify ${key}`,
        result: null,
        scope: ['docs/api.md'],
        inputs: ['src', 'package.json'],
        authorization: 'Fixture authorized verification',
        nonGoals: ['No external services'],
        acceptance: [
          {
            id: 'checks',
            method: 'automated',
            criterion: 'Validate the same inputs',
            command,
          },
        ],
        nextAction: 'Verify',
        stopCondition: 'Return verified observations',
      },
    }),
  );
  const id = created.task.id as string;
  ok(root, ['update', id, '--stdin'], {
    revision: created.revision,
    reason: 'Fixture enters verification',
    stage: 'C1_EVIDENCE_PENDING',
    plan: { nextAction: 'Run checks' },
  });
  return id;
}
export async function state(root: string, id: string): Promise<Task> {
  return JSON.parse(await readFile(join(root, `.work/tasks/${id}/state.json`), 'utf8'));
}
export const ref = (task: string, entry: Evidence): EvidenceRef => ({
  task,
  criterion: entry.criterion,
  sha256: entry.sha256,
});
export async function run(root: string, id: string, script?: string) {
  const result = invoke(root, ['run', id, 'checks', '--stdin'], {
    conditions: testConditions,
    ...(script === undefined ? {} : { command: [process.execPath, '-e', script] }),
  });
  if (!(await state(root, id)).evidence.length) throw new Error(result.output);
  return { ...result, ref: ref(id, (await state(root, id)).evidence.at(-1)!) };
}
export function check(root: string, id: string) {
  return JSON.parse(ok(root, ['check', id])).evidence[0] as { result: string; basis?: string };
}
export function inspect(
  root: string,
  id: string,
  baseline: EvidenceRef,
  extra = {},
  criterion = 'checks',
) {
  return JSON.parse(
    ok(root, ['verify', id, criterion, '--stdin'], { action: 'inspect', baseline, ...extra }),
  );
}
export function record(
  root: string,
  id: string,
  baseline: EvidenceRef,
  extra = {},
  criterion = 'checks',
) {
  const inspected = invoke(root, ['verify', id, criterion, '--stdin'], {
    action: 'inspect',
    baseline,
    ...extra,
  });
  if (inspected.status !== 0) return inspected;
  const current = JSON.parse(inspected.output);
  return invoke(root, ['verify', id, criterion, '--stdin'], {
    action: 'record',
    baseline,
    revision: current.revision,
    mode: 'reuse',
    coverage: 'Same command covers the target criterion.',
    environment: {
      identity: current.environment,
      reason: 'Identical isolated fixture; no external services.',
      conditions: testConditions,
    },
    ...extra,
  });
}

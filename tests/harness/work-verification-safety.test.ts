import { link, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { contractPlan } from '../../scripts/harness/work/records.ts';
import {
  begin,
  check,
  create,
  fixture,
  invoke,
  ok,
  state,
  verifyReady,
} from './fixtures/verification-fixture.ts';

const checks = (root: string, id: string) =>
  check(root, id).evidence.find((entry: { criterion: string }) => entry.criterion === 'checks');
async function waitFor(path: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await readFile(path);
      return;
    } catch {
      await delay(20);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}
async function coverage(root: string, id: string, mode: 'manual' | 'ci' = 'manual') {
  const task = await state(root, id);
  const path = `.work/tasks/${id}/evidence/coverage-${mode}.md`;
  await mkdir(join(root, `.work/tasks/${id}/evidence`), { recursive: true });
  const report = {
    candidate: task.checkpoint!.candidate,
    contract: contractPlan(task),
    criterion: 'checks',
    mode,
    executionCount: 0,
    reviewer: 'Fixture reviewer',
    source: mode === 'ci' ? 'CI result for the same candidate' : 'Reviewed baseline and diff',
    ...(mode === 'ci' ? { remoteExecution: 'CI run 123' } : {}),
    scope: 'Declared complete check',
    environment: 'Isolated fixture',
    uncovered: 'None for this fixture',
    assessment: 'The described observations cover the criterion.',
    result: 'pass',
  };
  await writeFile(
    join(root, path),
    `# Coverage\n\n\`\`\`mio-coverage\n${JSON.stringify(report)}\n\`\`\`\n`,
  );
  return { path, report };
}

it('persists pending before launch and keeps a cancelled zero exit from hiding an older pass', async () => {
  const root = await fixture();
  const id = create(root);
  verifyReady(root, id);
  ok(root, ['run', id, 'checks']);
  const script =
    'process.on("SIGTERM",()=>process.exit(0));require("node:fs").writeFileSync(".work/started","yes");setInterval(()=>{},1000)';
  const running = begin(root, id, ['run', id, 'checks', '--', process.execPath, '-e', script]);
  await waitFor(join(root, '.work/started'));
  const pending = (await state(root, id)).evidence.at(-1)!;
  expect(pending.result).toBe('pending');
  expect(pending.artifact).toMatch(/\.log$/);
  expect(pending.sha256).toBeUndefined();
  expect(checks(root, id).result).toBe('pending');
  expect(invoke(root, ['run', id, 'checks']).output).toContain('WORK_BUSY');
  running.child.kill('SIGTERM');
  const outcome = await running.finished;
  expect(outcome.status).toBe(1);
  const entry = (await state(root, id)).evidence.at(-1)!;
  expect(entry.result).toBe('fail');
  expect(entry.artifact).toBe(pending.artifact);
  expect(entry.sha256).toBeDefined();
  expect(await readFile(join(root, entry.artifact), 'utf8')).toContain('"cancelled": true');
  expect(checks(root, id).result).toBe('fail');
}, 15_000);

it('retains the task marker and provisional log without a checksum while a descendant is alive', async () => {
  const root = await fixture();
  const id = create(root);
  verifyReady(root, id);
  ok(root, ['run', id, 'checks']);
  const descendant =
    'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(".work/descendant-ready","yes");setInterval(()=>{},1000)';
  const script = `const fs=require("node:fs");require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{stdio:"ignore"});process.on("SIGTERM",()=>process.exit(0));const t=setInterval(()=>{if(fs.existsSync(".work/descendant-ready")){clearInterval(t);fs.writeFileSync(".work/group-ready","yes")}},20);setInterval(()=>{},1000)`;
  const running = begin(root, id, ['run', id, 'checks', '--', process.execPath, '-e', script]);
  await waitFor(join(root, '.work/group-ready'));
  running.child.kill('SIGTERM');
  const outcome = await running.finished;
  expect(outcome.status).toBe(1);
  expect(outcome.output).toContain('WORK_CHILD_ACTIVE');
  const markerPath = join(root, `.work/tasks/${id}.command.json`);
  const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { child: number };
  try {
    const entry = (await state(root, id)).evidence.at(-1)!;
    expect(entry.result).toBe('pending');
    expect(entry.artifact).toMatch(/\.log$/);
    expect(entry.sha256).toBeUndefined();
    expect(await readFile(join(root, entry.artifact), 'utf8')).toContain('"unsettled": true');
    const index = (await state(root, id)).evidence.length - 1;
    const viewed = JSON.parse(ok(root, ['read', id, 'evidence', String(index)]));
    expect(viewed.integrity).toBe('pending');
    expect(viewed.actualSha256).toBeNull();
    expect(checks(root, id).result).toBe('pending');
    expect(invoke(root, ['sync', id, 'Do not steal occupancy.']).output).toContain('WORK_BUSY');
  } finally {
    try {
      process.kill(-marker.child, 'SIGKILL');
    } catch {
      /* already stopped */
    }
  }
}, 15_000);

it.each(['manual', 'ci'] as const)(
  'records %s coverage as review with zero local executions and explicit source',
  async (mode) => {
    const root = await fixture();
    const id = create(root);
    verifyReady(root, id);
    const original = await coverage(root, id, mode);
    ok(root, ['evidence', id, 'checks', original.path, 'Reviewed coverage.']);
    const result = checks(root, id);
    expect(result).toMatchObject({
      result: 'pass',
      basis: mode === 'ci' ? 'remote CI review' : 'manual review',
      executionCount: 0,
    });
    if (mode === 'ci') expect(result.remoteExecution).toBe('CI run 123');
    const other = create(root, 'other');
    verifyReady(root, other);
    expect(checks(root, other).result).toBe('pending');
  },
);

it('refuses an unbound coverage claim and detects a changed registered original', async () => {
  const root = await fixture();
  const id = create(root);
  verifyReady(root, id);
  const original = await coverage(root, id);
  const bad = { ...original.report, candidate: 'a'.repeat(64) };
  await writeFile(
    join(root, original.path),
    `\`\`\`mio-coverage\n${JSON.stringify(bad)}\n\`\`\`\n`,
  );
  expect(
    invoke(root, ['evidence', id, 'checks', original.path, 'Attempt old identity.']).status,
  ).toBe(1);
  await writeFile(
    join(root, original.path),
    `\`\`\`mio-coverage\n${JSON.stringify(original.report)}\n\`\`\`\n`,
  );
  ok(root, ['evidence', id, 'checks', original.path, 'Reviewed coverage.']);
  await writeFile(
    join(root, original.path),
    `\`\`\`mio-coverage\n${JSON.stringify(original.report)}\n\`\`\`\nChanged\n`,
  );
  expect(checks(root, id).result).toBe('corrupt');
  expect(
    invoke(root, ['evidence', id, 'checks', original.path, 'Do not overwrite history.']).output,
  ).toContain('WORK_EVIDENCE_IMMUTABLE');
});

it('rejects symlink and hard-link aliases for new evidence originals', async () => {
  const root = await fixture();
  const id = create(root);
  verifyReady(root, id);
  const original = await coverage(root, id);
  const alias = `.work/tasks/${id}/evidence/alias.md`;
  await link(join(root, original.path), join(root, alias));
  expect(invoke(root, ['evidence', id, 'checks', original.path, 'Alias.']).output).toContain(
    'WORK_ARTIFACT',
  );
  await import('node:fs/promises').then(({ rm }) => rm(join(root, alias)));
  await symlink(join(root, original.path), join(root, alias));
  expect(invoke(root, ['evidence', id, 'checks', alias, 'Alias.']).output).toContain(
    'WORK_SYMLINK',
  );
  expect((await state(root, id)).evidence).toEqual([]);
});

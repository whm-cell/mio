import { spawn } from 'node:child_process';
import { readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { taskRevision } from '../../scripts/harness/work/records.ts';
import {
  accept,
  cli,
  commitFixture,
  edit,
  fixture,
  implementing,
  invoke,
  proposal,
  ready,
  requirement,
  run,
  state,
  statePath,
  verifying,
} from './fixtures/work-cli-fixture.ts';

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
  'rejects stale updates without persisting a conflict gate in %s',
  async (stage) => {
    const root = await fixture();
    const first = JSON.parse(invoke(root, ['ensure', '--stdin'], proposal()).output);
    const id = first.task.id as string;
    expect(invoke(root, ['sync', id, 'Reviewed the clean fixture commit.']).status).toBe(0);
    const synced = JSON.parse(invoke(root, ['context', id, 'resume']).output);
    const staged = invoke(root, ['update', id, '--stdin'], {
      revision: synced.revision,
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
    expect(await readFile(statePath(root, id), 'utf8')).toBe(before);
    await expect(readFile(join(root, `.work/tasks/${id}/conflict.json`))).rejects.toHaveProperty(
      'code',
      'ENOENT',
    );
    // Existing receipts are historical files: leave them untouched and do not resurrect a gate.
    const legacyReceipt = '{"message":"historical conflict"}\n';
    await writeFile(join(root, `.work/tasks/${id}/conflict.json`), legacyReceipt);
    const observed = JSON.parse(invoke(root, ['context', id, 'resume']).output);
    expect(observed.assessment.ready).toBe(true);
    expect(observed.task.nextAction).toBe('Current authorized action.');
    if (stage === 'C1_IMPLEMENTATION') {
      expect(
        invoke(root, ['update', id, '--stdin'], {
          revision: observed.revision,
          reason: 'Continue using the current revision.',
          plan: { nextAction: 'Continue implementation.' },
        }).status,
      ).toBe(0);
    } else {
      expect(invoke(root, ['run', id, 'checks']).status).toBe(0);
    }
    expect(await readFile(join(root, `.work/tasks/${id}/conflict.json`), 'utf8')).toBe(
      legacyReceipt,
    );
  },
);

it('serializes same-revision updates and never revives an older revision after reverting a value', async () => {
  const root = await fixture();
  const created = JSON.parse(invoke(root, ['ensure', '--stdin'], proposal()).output);
  const id = created.task.id as string;
  expect(created.revision).toBe(1);
  const originalAction = created.task.nextAction as string;
  const request = {
    revision: created.revision,
    reason: 'A concurrent actor updates the next action.',
    plan: { nextAction: 'Changed action.' },
  };
  const update = () => {
    const child = spawn(process.execPath, [cli, 'update', id, '--stdin'], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '' },
    });
    let output = '';
    child.stdout.on('data', (bytes: Buffer) => (output += bytes.toString()));
    child.stderr.on('data', (bytes: Buffer) => (output += bytes.toString()));
    child.stdin.end(JSON.stringify(request));
    return new Promise<{ status: number | null; output: string }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status) => resolve({ status, output }));
    });
  };
  const results = await Promise.all([update(), update()]);
  expect(results.filter((result) => result.status === 0)).toHaveLength(1);
  expect(results.find((result) => result.status !== 0)!.output).toMatch(/WORK_BUSY|WORK_CONFLICT/);
  const current = JSON.parse(invoke(root, ['context', id, 'resume']).output);
  expect(current.revision).toBe(created.revision + 1);
  expect(invoke(root, ['update', id, '--stdin'], request).output).toContain('WORK_CONFLICT');
  const restored = invoke(root, ['update', id, '--stdin'], {
    revision: current.revision,
    reason: 'Return to the original action.',
    plan: { nextAction: originalAction },
  });
  expect(restored.status, restored.output).toBe(0);
  expect(JSON.parse(restored.output).revision).toBe(current.revision + 1);
  expect(invoke(root, ['update', id, '--stdin'], request).output).toContain('WORK_CONFLICT');
});

it('reads a legacy record with revision zero and writes the current integer on its first change', async () => {
  const root = await fixture();
  const created = JSON.parse(invoke(root, ['ensure', '--stdin'], proposal()).output);
  const id = created.task.id as string;
  await edit(
    root,
    (task) => {
      delete task.revision;
    },
    id,
  );
  const legacy = await state(root, id);
  const current = JSON.parse(invoke(root, ['context', id, 'resume']).output);
  expect(current.revision).toBe(0);
  const result = invoke(root, ['update', id, '--stdin'], {
    revision: 0,
    reason: 'Record a new action for the existing task.',
    plan: { nextAction: 'Continue the existing task.' },
  });
  expect(result.status, result.output).toBe(0);
  const saved = await state(root, id);
  expect(saved.revision).toBe(1);
  expect(saved.checkpoint).toEqual(legacy.checkpoint);
  expect(saved.evidence).toEqual(legacy.evidence);
});

it('increments the contract revision only for actual contract changes, including A to B to A', async () => {
  const root = await fixture();
  const created = JSON.parse(invoke(root, ['ensure', '--stdin'], proposal()).output);
  const id = created.task.id as string;
  const original = (await state(root, id)).plan.goal;
  const progress = invoke(root, ['update', id, '--stdin'], {
    revision: created.revision,
    reason: 'Update progress without changing the contract.',
    plan: { nextAction: 'Review the next step.' },
  });
  expect(progress.status, progress.output).toBe(0);
  expect((await state(root, id)).contractRevision).toBe(0);
  const changed = invoke(root, ['update', id, '--stdin'], {
    revision: JSON.parse(progress.output).revision,
    reason: 'Change the agreed goal.',
    plan: { goal: 'A different goal.' },
  });
  expect(changed.status, changed.output).toBe(0);
  expect((await state(root, id)).contractRevision).toBe(1);
  const reverted = invoke(root, ['update', id, '--stdin'], {
    revision: JSON.parse(changed.output).revision,
    reason: 'Restore the original goal.',
    plan: { goal: original },
  });
  expect(reverted.status, reverted.output).toBe(0);
  expect((await state(root, id)).contractRevision).toBe(2);
});

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
  // A stale update must not prevent a valid section correction.
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
  expect(JSON.parse(repaired.output).assessment.errors.join()).toContain('WORK_CANDIDATE');
  commitFixture(root, 'Rename the requirement heading', ['docs/api.md']);
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
  expect(stale.assessment.errors.join()).toContain('WORK_CANDIDATE');
  expect(await readFile(statePath(root, id), 'utf8')).toBe(reconciled);
  commitFixture(root, 'Implement the fixture value', ['src/value.ts']);
  expect(
    invoke(root, ['sync', id, 'Reviewed the value change against the PRD subtask.']).status,
  ).toBe(0);
  expect(run(root, script, id).status).toBe(0);
  const final = await state(root, id);
  expect(final.evidence.map((entry) => entry.result)).toEqual(['fail', 'pass']);
  expect(final.reviewDecision).toBe('PENDING');
  expect(final.evidence[0]!.candidate).not.toEqual(final.evidence[1]!.candidate);
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
  'allows authorized contract changes during C1 without requiring a checkpoint (dirty: %s)',
  async (dirty) => {
    const root = await fixture();
    await ready(root);
    const original = await state(root);
    if (dirty) await writeFile(join(root, 'src/value.ts'), 'export const value = 2;\n');
    const changed = invoke(root, ['update', 'probe', '--stdin'], {
      revision: taskRevision(original),
      reason: 'Revise the authorized goal and start implementation.',
      stage: 'C1_IMPLEMENTATION',
      plan: { goal: 'An authorized revised goal.', nextAction: 'Implement the revised goal.' },
    });
    expect(changed.status, changed.output).toBe(0);
    const current = await state(root);
    expect(current.stage).toBe('C1_IMPLEMENTATION');
    expect(current.plan.goal).toBe('An authorized revised goal.');
    expect(current.contractRevision).toBe((original.contractRevision ?? 0) + 1);
    if (dirty)
      expect(invoke(root, ['sync', 'probe', 'Attempt to sync dirty files.']).output).toContain(
        'WORK_CANDIDATE',
      );
    else expect(invoke(root, ['sync', 'probe', 'Review the revised contract.']).status).toBe(0);
  },
);

it('allows dirty C1 implementation but requires commit before candidate sync', async () => {
  const root = await fixture();
  await ready(root);
  const original = await state(root);
  await writeFile(join(root, 'src/value.ts'), 'export const value = 2;\n');
  const started = invoke(root, ['update', 'probe', '--stdin'], {
    revision: taskRevision(original),
    reason: 'Continue authorized implementation with dirty files.',
    stage: 'C1_IMPLEMENTATION',
    plan: { nextAction: 'Review and commit the source.' },
  });
  expect(started.status, started.output).toBe(0);
  expect(invoke(root, ['sync', 'probe', 'Reject the dirty source.']).output).toContain(
    'WORK_CANDIDATE',
  );
  const commit = commitFixture(root, 'Review changed value', ['src/value.ts']);
  expect(invoke(root, ['sync', 'probe', 'Reviewed the committed value.']).status).toBe(0);
  expect((await state(root)).checkpoint!.candidate).toEqual({
    commit,
    contractRevision: original.contractRevision,
  });
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
  expect(JSON.parse(changed.output).assessment.errors.join()).toContain('WORK_CANDIDATE');
  expect(invoke(root, ['sync', 'probe', 'Reconciled the new acceptance target.']).status).toBe(0);
  expect(JSON.parse(invoke(root, ['check', 'probe']).output).evidence[0].result).toBe('pending');
});

it('keeps PRD source binding and requires explicit current authorization to reopen archived work', async () => {
  const root = await fixture();
  const result = JSON.parse(invoke(root, ['ensure', '--stdin'], proposal()).output);
  const id = result.task.id as string;
  expect((await state(root, id)).checkpoint).toBeNull();
  expect(invoke(root, ['sync', id, 'Reviewed the current fixture commit.']).status).toBe(0);
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
  expect(invoke(root, ['sync', id, 'Reconciled the new authorization.']).status).toBe(0);
  await writeFile(join(root, 'docs/api.md'), '# API\nUpdated PRD contract.\n');
  expect(invoke(root, ['sync', id, 'Do not sync a dirty PRD.']).output).toContain('WORK_CANDIDATE');
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

it('keeps sibling tasks independent and archives in place without deleting their evidence', async () => {
  const root = await fixture();
  await ready(root);
  await ready(root, 'second');
  const second = await readFile(statePath(root, 'second'), 'utf8');
  expect(run(root).status).toBe(0);
  const originals = (await readdir(join(root, '.work/tasks/probe/evidence'))).sort();
  expect(originals).toHaveLength(1);
  expect(
    invoke(root, ['archive', 'probe', 'Cancelled by the fixture user; preserve the result.'])
      .status,
  ).toBe(0);
  expect(invoke(root, ['check', 'probe']).output).toContain('WORK_ARCHIVED');
  expect(run(root).status).toBe(1);
  expect(await readFile(statePath(root, 'second'), 'utf8')).toBe(second);
  expect((await readdir(join(root, '.work/tasks/probe/evidence'))).sort()).toEqual(originals);
});

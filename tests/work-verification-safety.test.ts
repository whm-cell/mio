import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { observe } from '../scripts/harness/work/verification-proof.ts';
import { digest, json } from '../scripts/harness/work/records.ts';
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
  testConditions,
} from './verification-fixture.ts';

const scratch: string[] = [];
async function setup() {
  const root = await fixture();
  scratch.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('uses a supplied legacy checkpoint to preserve a settled full-check failure boundary after sync', async () => {
  const root = await setup();
  const target = create(root);
  const source = create(root, 'other');
  await run(root, target, 'process.exit(1)');
  await run(root, target);
  const historic = await state(root, target);
  const checkpoint = historic.checkpoint!;
  const entry = historic.evidence.at(-1)!;
  const path = join(root, entry.artifact);
  const text = await readFile(path, 'utf8');
  const end = text.indexOf('\n}\n') + 2;
  const header = JSON.parse(text.slice(0, end));
  delete header.checkpoint;
  const oldFormat = json(header).trimEnd() + text.slice(end);
  // Construct a legacy fixture whose execution predates embedded input snapshots.
  await writeFile(path, oldFormat);
  entry.sha256 = digest(oldFormat);
  await writeFile(join(root, `.work/tasks/${target}/state.json`), json(historic));
  await writeFile(join(root, 'src/value.ts'), 'export const value = 2;');
  for (const id of [target, source])
    ok(root, ['sync', id, 'Reviewed current inputs, preserving saved legacy checkpoint.']);
  const current = (await run(root, source)).ref;
  expect(
    record(root, target, current, { legacyCheckpoint: (await state(root, source)).checkpoint })
      .output,
  ).toContain('WORK_VERIFY_ISSUES');
  const result = record(root, target, current, { legacyCheckpoint: checkpoint });
  expect(result.status, result.output).toBe(0);
  expect(check(root, target).result).toBe('pass');
  await writeFile(path, 'damaged historical failure-clearing boundary');
  expect(check(root, target).result).not.toBe('pass');
});

it('does not let an earlier success resolve a subsequent failure', async () => {
  const root = await setup();
  const id = create(root);
  const base = (await run(root, id)).ref;
  const earlier = (await run(root, id, 'console.log("before failure")')).ref;
  const failure = (await run(root, id, 'process.exit(1)')).ref;
  const attempted = record(root, id, base, {
    mode: 'incremental',
    runs: [earlier],
    resolves: [{ issue: failure, reason: 'Earlier success is not recovery', runs: [earlier] }],
  });
  expect(attempted.output).toContain('WORK_VERIFY_ORDER');
  expect(check(root, id).result).toBe('fail');
});

it.each(['same task', 'another task'])(
  'rejects a newly recorded scoped receipt as recovery evidence in %s',
  async (owner) => {
    const root = await setup();
    const command = [
      process.execPath,
      '-e',
      "require('node:fs').appendFileSync('.work/count','probe\\n')",
    ];
    const source = create(root, 'source', command);
    const target = owner === 'same task' ? source : create(root, 'target');
    const criterion = owner === 'same task' ? 'recovery' : 'checks';
    if (owner === 'same task') {
      const current = JSON.parse(ok(root, ['context', source, 'resume']));
      ok(root, ['update', source, '--stdin'], {
        revision: current.revision,
        reason: 'Keep focused coverage separate from actual failure recovery.',
        plan: {
          acceptance: [
            { id: 'checks', method: 'automated', criterion: 'Focused fixture check', command },
            {
              id: criterion,
              method: 'automated',
              criterion: 'Complete recovery',
              command: fullCommand,
            },
          ],
        },
      });
      ok(root, ['sync', source, 'Reviewed the two independent fixture commands.']);
    }
    const focused = await run(root, source);
    expect(focused.status, focused.output).toBe(0);
    ok(root, ['run', target, criterion, '--stdin'], { conditions: testConditions });
    const baseline = ref(target, (await state(root, target)).evidence.at(-1)!);
    const failed = invoke(root, ['run', target, criterion, '--stdin'], {
      conditions: testConditions,
      command: [process.execPath, '-e', 'process.exit(1)'],
    });
    expect(failed.status, failed.output).toBe(1);
    const issue = ref(target, (await state(root, target)).evidence.at(-1)!);
    const wrapped = record(root, source, focused.ref);
    expect(wrapped.status, wrapped.output).toBe(0);
    const receipt = ref(source, (await state(root, source)).evidence.at(-1)!);
    const attempted = record(
      root,
      target,
      baseline,
      {
        mode: 'incremental',
        runs: [receipt],
        resolves: [{ issue, reason: 'A new receipt is not a new execution.', runs: [receipt] }],
      },
      criterion,
    );
    expect(attempted.status).toBe(1);
    expect(attempted.output).toContain('WORK_VERIFY_RECOVERY_EXECUTION');
    expect(await readFile(join(root, '.work/count'), 'utf8')).toBe('probe\nfull\n');
    const assessment = JSON.parse(ok(root, ['check', target]));
    expect(
      assessment.evidence.find((entry: { criterion: string }) => entry.criterion === criterion)
        .result,
    ).not.toBe('pass');
  },
);

it.each([
  ['failure', 'input'],
  ['failure', 'environment'],
  ['pending observation', 'input'],
] as const)('keeps a %s when verification returns to its original %s', async (issue, kind) => {
  const root = await setup();
  const relative = kind === 'input' ? 'src/value.ts' : '.env';
  const path = join(root, relative);
  if (kind === 'environment') await writeFile(path, 'MODE=original\n');
  const initial = await readFile(path, 'utf8');
  const source = create(root, 'source');
  const target = create(root, 'target');
  const baseline = await run(root, source);
  expect(baseline.status, baseline.output).toBe(0);
  const seeded = record(root, target, baseline.ref);
  expect(seeded.status, seeded.output).toBe(0);
  const template = (await state(root, target)).evidence.at(-1)!;
  const receipt = JSON.parse(await readFile(join(root, template.artifact), 'utf8'));

  const failure = await run(
    root,
    target,
    `const fs = require('node:fs'); const path = ${JSON.stringify(relative)}; const value = fs.readFileSync(path, 'utf8'); ${issue === 'failure' ? `if (value === ${JSON.stringify(initial)}) process.exit(1)` : 'fs.writeFileSync(path, value)'}`,
  );
  expect(failure.status, failure.output).toBe(1);
  expect((await state(root, target)).evidence.at(-1)!.result).toBe(
    issue === 'failure' ? 'fail' : 'pending',
  );

  await writeFile(path, kind === 'input' ? 'export const value = 2;\n' : 'MODE=changed\n');
  if (kind === 'input') ok(root, ['sync', target, 'Reviewed the different source inputs.']);
  const other = await run(root, target);
  expect(other.status, other.output).toBe(0);
  const otherCheckpoint = (await state(root, target)).checkpoint;
  await writeFile(path, initial);
  if (kind === 'input') ok(root, ['sync', target, 'Reviewed the restored source inputs.']);

  const inspection = inspect(root, target, baseline.ref, {
    environment: { conditions: testConditions },
  });
  const attempted = record(root, target, baseline.ref);
  expect({
    issues: inspection.issues,
    status: attempted.status,
    passes: check(root, target).result === 'pass',
  }).toEqual({ issues: expect.arrayContaining([failure.ref]), status: 1, passes: false });
  expect(attempted.output).toContain('WORK_VERIFY_ISSUES');

  // Recreate a receipt the earlier resolver could register with this unrelated boundary.
  const historic = json({
    ...receipt,
    priorBoundary: { ref: other.ref, checkpoint: otherCheckpoint },
  });
  const artifact = `.work/tasks/${target}/evidence/old-boundary.verification.json`;
  const ledger = await state(root, target);
  await writeFile(join(root, artifact), historic);
  ledger.evidence.push({ ...template, artifact, sha256: digest(historic) });
  await writeFile(join(root, `.work/tasks/${target}/state.json`), json(ledger));
  expect(check(root, target).result).not.toBe('pass');

  const current = await run(root, target);
  expect(current.status, current.output).toBe(0);
  const acceptedBoundary = record(root, target, baseline.ref);
  expect(acceptedBoundary.status, acceptedBoundary.output).toBe(0);
  expect(check(root, target).result).toBe('pass');
});

it('cannot bypass a later receipt with a failed transitive source by selecting an older full run', async () => {
  const root = await setup();
  const a = create(root, 'a');
  const s = create(root, 's');
  const t = create(root, 't');
  const first = (await run(root, s)).ref;
  const second = (await run(root, a)).ref;
  expect(record(root, s, second).status).toBe(0);
  await run(root, a, 'process.exit(1)');
  expect(check(root, s).result).not.toBe('pass');
  expect(record(root, t, first).output).toContain('WORK_VERIFY_ISSUES');
});

it.each(['input', 'environment'] as const)(
  'keeps transitive source failures when an unrelated %s success becomes the target boundary',
  async (kind) => {
    const root = await setup();
    const relative = kind === 'input' ? 'src/value.ts' : '.env';
    const path = join(root, relative);
    if (kind === 'environment') await writeFile(path, 'MODE=original\n');
    const initial = await readFile(path, 'utf8');
    const a = create(root, 'a');
    const b = create(root, 'b');
    const target = create(root, 'target');
    const first = await run(root, a);
    const independent = await run(root, b);
    expect(first.status, first.output).toBe(0);
    expect(independent.status, independent.output).toBe(0);
    expect(record(root, target, first.ref).status).toBe(0);
    const template = (await state(root, target)).evidence.at(-1)!;
    const receipt = JSON.parse(await readFile(join(root, template.artifact), 'utf8'));
    const failure = await run(root, a, 'process.exit(1)');
    expect(failure.status, failure.output).toBe(1);

    await writeFile(path, kind === 'input' ? 'export const value = 2;\n' : 'MODE=changed\n');
    if (kind === 'input') ok(root, ['sync', target, 'Reviewed the different source inputs.']);
    const other = await run(root, target);
    expect(other.status, other.output).toBe(0);
    const otherCheckpoint = (await state(root, target)).checkpoint;
    await writeFile(path, initial);
    if (kind === 'input') ok(root, ['sync', target, 'Reviewed the restored source inputs.']);

    const inspection = inspect(root, target, independent.ref, {
      environment: { conditions: testConditions },
    });
    const attempted = record(root, target, independent.ref);
    expect({
      issues: inspection.issues,
      status: attempted.status,
      passes: check(root, target).result === 'pass',
    }).toEqual({ issues: expect.arrayContaining([failure.ref]), status: 1, passes: false });

    const historic = json({
      ...receipt,
      baseline: independent.ref,
      priorBoundary: { ref: other.ref, checkpoint: otherCheckpoint },
    });
    const artifact = `.work/tasks/${target}/evidence/old-transitive-boundary.verification.json`;
    const ledger = await state(root, target);
    await writeFile(join(root, artifact), historic);
    ledger.evidence.push({ ...template, artifact, sha256: digest(historic) });
    await writeFile(join(root, `.work/tasks/${target}/state.json`), json(ledger));
    expect(check(root, target).result).not.toBe('pass');

    const recovery = await run(root, a);
    expect(recovery.status, recovery.output).toBe(0);
    const resolved = record(root, target, recovery.ref, {
      mode: 'incremental',
      runs: [recovery.ref],
      resolves: [
        {
          issue: failure.ref,
          reason: 'Shared full execution repairs this source.',
          runs: [recovery.ref],
        },
      ],
    });
    expect(resolved.status, resolved.output).toBe(0);
    expect(check(root, target).result).toBe('pass');
  },
);

it.each(['input', 'environment'] as const)(
  'keeps an unrelated intermediate receipt failure outside the restored %s scope',
  async (kind) => {
    const root = await setup();
    const relative = kind === 'input' ? 'src/value.ts' : '.env';
    const path = join(root, relative);
    if (kind === 'environment') await writeFile(path, 'MODE=original\n');
    const initial = await readFile(path, 'utf8');
    const a = create(root, 'a');
    const b = create(root, 'b');
    const c = create(root, 'c');
    const target = create(root, 'target');
    const first = await run(root, a);
    const independent = await run(root, b);
    expect(first.status, first.output).toBe(0);
    expect(independent.status, independent.output).toBe(0);
    expect(record(root, target, first.ref).status).toBe(0);

    await writeFile(path, kind === 'input' ? 'export const value = 2;\n' : 'MODE=changed\n');
    if (kind === 'input')
      for (const id of [c, target]) ok(root, ['sync', id, 'Reviewed the intermediate inputs.']);
    const changed = await run(root, c);
    expect(changed.status, changed.output).toBe(0);
    const intermediate = record(root, target, changed.ref);
    expect(intermediate.status, intermediate.output).toBe(0);
    const failure = await run(root, c, 'process.exit(1)');
    expect(failure.status, failure.output).toBe(1);
    expect(check(root, target).result).not.toBe('pass');
    const repaired = await run(root, target);
    expect(repaired.status, repaired.output).toBe(0);

    await writeFile(path, initial);
    if (kind === 'input') ok(root, ['sync', target, 'Reviewed the restored source inputs.']);
    const result = record(root, target, independent.ref);
    expect(result.status, result.output).toBe(0);
    expect(check(root, target).result).toBe('pass');
  },
);

it('revokes transitive reuse during active or interrupted source execution and reports that in handoff', async () => {
  const root = await setup();
  const a = create(root, 'a');
  const s = create(root, 's');
  const t = create(root, 't');
  const base = (await run(root, a)).ref;
  expect(record(root, s, base).status).toBe(0);
  const receipt = (await state(root, s)).evidence.at(-1)!;
  const chained = { task: s, criterion: 'checks', sha256: receipt.sha256 };
  expect(record(root, t, chained).status).toBe(0);
  await writeFile(join(root, `.work/tasks/${a}.command.json`), '{"pid":0,"command":"run"}');
  expect(check(root, t).result).not.toBe('pass');
  expect(record(root, t, chained).output).toContain('WORK_VERIFY_BUSY');
  const handoff = ok(root, ['handoff', t]).trim();
  const text = await readFile(handoff, 'utf8');
  expect(text).not.toContain('Current checks: pass');
  expect(text).toContain('Current checks: invalid');
});

it.skipIf(process.platform === 'win32')(
  'keeps direct and transitive checks unresolved after hard interruption and marker recovery',
  async () => {
    const root = await setup();
    const source = create(root, 'source');
    const middle = create(root, 'middle');
    const target = create(root, 'target');
    const ids = [source, middle, target];
    const baseline = await run(root, source);
    expect(baseline.status, baseline.output).toBe(0);
    const reused = record(root, middle, baseline.ref);
    expect(reused.status, reused.output).toBe(0);
    const chained = record(root, target, ref(middle, (await state(root, middle)).evidence.at(-1)!));
    expect(chained.status, chained.output).toBe(0);
    const passing = () => ids.map((id) => check(root, id).result === 'pass');
    expect(passing()).toEqual([true, true, true]);

    const marker = join(root, `.work/tasks/${source}.command.json`);
    const started = join(root, '.work/interrupted-probe-started');
    const script = `require('node:fs').writeFileSync('.work/interrupted-probe-started', String(process.pid));setInterval(() => {}, 100)`;
    const command = spawn(
      process.execPath,
      [
        resolve('scripts/harness/work/cli.ts'),
        'run',
        source,
        'checks',
        '--',
        process.execPath,
        '-e',
        script,
      ],
      { cwd: root, stdio: 'ignore' },
    );
    const finished = once(command, 'close');
    const worker = async (): Promise<number | undefined> => {
      try {
        const { child } = JSON.parse(await readFile(marker, 'utf8'));
        return typeof child === 'number' && child > 0 ? child : undefined;
      } catch {
        return undefined;
      }
    };
    let stopped = false;
    try {
      await expect.poll(() => readFile(started, 'utf8').catch(() => '')).toMatch(/^\d+$/);
      const pid = Number(await readFile(started, 'utf8'));
      await expect.poll(worker).toBe(pid);
      const inFlight = passing();
      command.kill('SIGKILL');
      await finished;
      expect(await worker()).toBe(pid);
      const interrupted = passing();

      process.kill(-pid, 'SIGKILL');
      await expect
        .poll(() => {
          try {
            process.kill(-pid, 0);
            return false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
            return true;
          }
        })
        .toBe(true);
      stopped = true;
      await rm(marker);
      const recovered = passing();
      const probe = await run(root, source, 'console.log("unrelated passing probe")');
      expect(probe.status, probe.output).toBe(0);

      const unresolved = [false, false, false];
      expect({ inFlight, interrupted, recovered, afterProbe: passing() }).toEqual({
        inFlight: unresolved,
        interrupted: unresolved,
        recovered: unresolved,
        afterProbe: unresolved,
      });
      expect((await state(root, source)).evidence.some((entry) => entry.result === 'pending')).toBe(
        true,
      );
    } finally {
      command.kill('SIGKILL');
      await finished;
      const pid = stopped ? undefined : await worker();
      if (pid) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    }
  },
  15000,
);

it('rejects changed ignored configuration and mismatched external conditions', async () => {
  const root = await setup();
  const id = create(root);
  const base = (await run(root, id)).ref;
  expect(record(root, id, base).status).toBe(0);
  await writeFile(join(root, '.env'), 'REMOTE_ENDPOINT=changed');
  expect(check(root, id).result).not.toBe('pass');
  expect(record(root, id, base).output).toContain('WORK_VERIFY_ENVIRONMENT');
  await rm(join(root, '.env'));
  const current = JSON.parse(
    ok(root, ['verify', id, 'checks', '--stdin'], { action: 'inspect', baseline: base }),
  );
  expect(
    record(root, id, base, {
      environment: {
        identity: current.environment,
        reason: 'External service changed',
        conditions: { ...testConditions, external: 'Different external server' },
      },
    }).output,
  ).toContain('WORK_VERIFY_ENVIRONMENT');
});

it.each([false, true])(
  'detects temporary environment configuration (already existed: %s)',
  async (existed) => {
    const root = await setup();
    const id = create(root);
    if (existed) await writeFile(join(root, '.env'), 'MODE=stable');
    const result = await run(
      root,
      id,
      "const f=require('node:fs');const b=f.existsSync('.env')?f.readFileSync('.env'):null;f.writeFileSync('.env','MODE=temporary');if(b)f.writeFileSync('.env',b);else f.unlinkSync('.env')",
    );
    expect(result.status).toBe(1);
    expect((await state(root, id)).evidence.at(-1)!.result).toBe('pending');
  },
);

it('supports repeated reviews of a fixed baseline without repeating execution', async () => {
  const root = await setup();
  const id = create(root);
  const base = (await run(root, id)).ref;
  for (let round = 0; round < 16; round++) {
    const result = record(root, id, base, {
      coverage: `Review ${round}: unchanged fixture inputs, commands and conditions.`,
    });
    expect(result.status, result.output).toBe(0);
  }
  expect(check(root, id).result).toBe('pass');
  expect(await readFile(join(root, '.work/count'), 'utf8')).toBe('full\n');
  const entry = (await state(root, id)).evidence.at(-1)!;
  const memo = { originals: new Map(), proofs: new Map(), observations: new Map() };
  let lookups = 0;
  const get = memo.observations.get.bind(memo.observations);
  memo.observations.get = (key: string) => {
    lookups++;
    return get(key);
  };
  await observe(
    root,
    { task: id, criterion: 'checks', sha256: entry.sha256 },
    undefined,
    new Set(),
    new Map(),
    memo,
  );
  expect(memo.originals.size).toBe(17);
  expect(lookups).toBeGreaterThan(16);
  expect(lookups).toBeLessThan(16 ** 3);
}, 30000);

it('shares one actual recovery execution across targets while preserving the original failure', async () => {
  const root = await setup();
  const a = create(root, 'a');
  const targets = [create(root, 'b'), create(root, 'c')];
  const base = (await run(root, a)).ref;
  for (const target of targets) expect(record(root, target, base).status).toBe(0);
  const failure = (await run(root, a, 'process.exit(1)')).ref;
  const recovered = (await run(root, a)).ref;
  for (const target of targets) {
    const result = record(root, target, recovered, {
      mode: 'incremental',
      runs: [recovered],
      resolves: [
        {
          issue: failure,
          reason:
            'Shared full execution after the failure covers these identical inputs and conditions.',
          runs: [recovered],
        },
      ],
    });
    expect(result.status, result.output).toBe(0);
    expect(check(root, target).result).toBe('pass');
  }
  expect(await readFile(join(root, '.work/count'), 'utf8')).toBe('full\nfull\n');
});

it('never uses drifted or failed executions as a baseline', async () => {
  const root = await setup();
  const id = create(root);
  const drifted = await run(
    root,
    id,
    "require('node:fs').writeFileSync('src/value.ts','export const value = 9;')",
  );
  expect((await state(root, id)).evidence.at(-1)!.result).toBe('pending');
  ok(root, ['sync', id, 'Reviewed fixture drift']);
  expect(record(root, id, drifted.ref).output).toContain('WORK_VERIFY_BASELINE');
  const failed = await run(root, id, 'process.exit(1)');
  expect(record(root, id, failed.ref).output).toContain('WORK_VERIFY_BASELINE');
});

it('requires explicit recovery of unrecorded legacy conditions without changing the original', async () => {
  const root = await setup();
  const id = create(root);
  const executed = invoke(root, ['run', id, 'checks']);
  expect(executed.status, executed.output).toBe(0);
  const entry = (await state(root, id)).evidence.at(-1)!;
  const base = { task: id, criterion: 'checks', sha256: entry.sha256 };
  expect(record(root, id, base).output).toContain('WORK_VERIFY_ENVIRONMENT');
  const original = await readFile(join(root, entry.artifact), 'utf8');
  const header = JSON.parse(original.slice(0, original.indexOf('\n}\n') + 2));
  const adopted = record(root, id, base, {
    legacyEnvironment: {
      reason:
        'Read the fixture command: builtins only; no services, unchanged fixture and dependency metadata.',
      snapshot: { ...header.environmentSnapshot, conditions: testConditions },
    },
  });
  expect(adopted.status, adopted.output).toBe(0);
  expect(await readFile(join(root, entry.artifact), 'utf8')).toBe(original);
});

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { addEvidence, assess, capture, inputStamp } from './context.ts';
import { checkedPath, digest, json, loadTask, saveTask } from './records.ts';
import {
  changedFiles,
  checkpoint as verificationLegacy,
  nonempty,
  object,
  reference,
  verification,
} from './verification-format.ts';
import {
  assertSourcesIdle,
  evaluateVerification,
  observe,
  runtimeEnvironment,
  targetIssues,
} from './verification-proof.ts';
import { withTaskCommand } from './command.ts';
import { captureEnvironment, conditions } from './verification-environment.ts';

export async function verify(root: string, id: string, criterionId: string, request: unknown) {
  const value = object(request);
  if (!['inspect', 'record'].includes(String(value.action)))
    throw new Error('WORK_VERIFY_ACTION: inspect or record required');
  const action = async () => {
    const { task, raw } = await loadTask(root, id);
    const criterion = task.plan.acceptance.find((item) => item.id === criterionId);
    if (criterion?.method !== 'automated' || !criterion.command)
      throw new Error('WORK_VERIFY_CRITERION: declared automated criterion required');
    const current = await capture(root, task);
    const baseline = reference(value.baseline);
    const legacy =
      value.legacyCheckpoint === undefined ? undefined : verificationLegacy(value.legacyCheckpoint);
    const base = await observe(root, baseline, legacy);
    const declared = value.environment ? object(value.environment) : {};
    const observedEnvironment = await captureEnvironment(
      root,
      declared.conditions ? conditions(declared.conditions) : null,
    );
    const history = await targetIssues(
      root,
      task,
      criterionId,
      criterion.command,
      [{ checkpoint: current, environmentSnapshot: observedEnvironment }, base],
      legacy,
    );
    const priorIssues = history.issues;
    if (value.action === 'inspect')
      return {
        revision: digest(raw),
        candidate: current.candidate,
        baseline: base.checkpoint.candidate,
        changed: changedFiles(base.checkpoint, current),
        environment: runtimeEnvironment(),
        baselineEnvironment: base.environment,
        baselineCommand: base.command,
        command: criterion.command,
        environmentSnapshot: observedEnvironment,
        baselineEnvironmentSnapshot: base.environmentSnapshot ?? null,
        issues: [
          ...new Map(
            [...base.issues, ...priorIssues].map((ref) => [JSON.stringify(ref), ref]),
          ).values(),
        ],
      };
    if (value.revision !== digest(raw))
      throw new Error('WORK_VERIFY_STALE: inspect the current revision');
    if (task.stage !== 'C1_EVIDENCE_PENDING')
      throw new Error('WORK_VERIFY_STAGE: enter C1_EVIDENCE_PENDING');
    const state = await assess(root, task);
    if (!state.ready) throw new Error(`WORK_VERIFY_CONTEXT: ${state.errors.join('; ')}`);
    nonempty(value.coverage);
    const doc = verification({
      kind: 'mio-verification',
      version: 1,
      mode: value.mode,
      target: { task: id, criterion: criterionId, command: criterion.command },
      checkpoint: current,
      baseline,
      ...(legacy ? { legacyCheckpoint: legacy } : {}),
      environment: { ...declared, snapshot: observedEnvironment },
      coverage: value.coverage,
      ...(value.legacyEnvironment ? { legacyEnvironment: value.legacyEnvironment } : {}),
      impact: value.impact ?? [],
      runs: value.runs ?? [],
      resolves: value.resolves ?? [],
      priorIssues,
      ...(history.boundary ? { priorBoundary: history.boundary } : {}),
    });
    const stamp = await inputStamp(root, current);
    await assertSourcesIdle(root, [doc.baseline, ...doc.runs, ...doc.priorIssues]);
    const observation = await evaluateVerification(root, doc);
    if (observation.issues.length)
      throw new Error(`WORK_VERIFY_ISSUES: unresolved ${json(observation.issues)}`);
    const after = await capture(root, task);
    if (after.candidate !== current.candidate || (await inputStamp(root, after)) !== stamp)
      throw new Error('WORK_VERIFY_CHANGED: inputs changed during verification');
    if (
      json(await captureEnvironment(root, conditions(declared.conditions))) !==
        json(observedEnvironment) ||
      (await evaluateVerification(root, doc)).issues.length
    )
      throw new Error(
        'WORK_VERIFY_CHANGED: execution conditions or source evidence changed during verification',
      );
    const relative = `.work/tasks/${id}/evidence/${randomUUID()}.verification.json`;
    const path = await checkedPath(root, relative);
    await mkdir(dirname(path), { recursive: true });
    const bytes = json(doc);
    await writeFile(path, bytes, { flag: 'wx' });
    addEvidence(task, {
      criterion: criterionId,
      method: 'automated',
      result: 'pass',
      candidate: current.candidate,
      artifact: relative,
      sha256: digest(bytes),
      environment: runtimeEnvironment(),
      summary: `${doc.mode}; reviewed baseline and ${doc.runs.length} supplemental observations; no command executed by verify`,
    });
    task.plan.nextAction =
      'Review remaining criteria and current originals; verification reuse does not grant human acceptance.';
    await saveTask(root, task, raw);
    return {
      result: 'pass',
      basis: doc.mode,
      candidate: current.candidate,
      artifact: relative,
      executions: 0,
    };
  };
  return value.action === 'record' ? withTaskCommand(root, id, 'verify', action) : action();
}

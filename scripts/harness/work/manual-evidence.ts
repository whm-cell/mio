import { lstat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { beneath } from '../inventory.ts';
import { candidateRef, checkedPath, contractPlan, sameCandidate } from './records.ts';
import type { Checkpoint, Task } from './records.ts';
import { metadata, record, textField } from './report-format.ts';
import { qualityCriterion, qualityReviewResult } from './quality-review.ts';
import { normsCriterion, normsReviewResult } from './norms-review.ts';

/** Compare existing physical files too: case-insensitive path aliases need not be hard links. */
export async function checkManualOriginal(
  root: string,
  task: Task,
  path: string,
  sha256: string,
): Promise<void> {
  const original = await lstat(await checkedPath(root, path));
  const sameFile = (other: typeof original) =>
    original.dev === other.dev && original.ino === other.ino;
  if (!beneath(path, `.work/tasks/${task.plan.id}/evidence`))
    throw new Error(
      'WORK_EVIDENCE_INPUT: use an independent original in this task evidence directory',
    );
  const changed = new Set(
    task.evidence.filter((entry) => entry.sha256 !== sha256).map((entry) => entry.artifact),
  );
  for (const previous of changed) {
    let same = previous === path;
    if (!same) {
      try {
        same = sameFile(await lstat(await checkedPath(root, previous)));
      } catch (error) {
        // Unavailable old originals remain deficient; they must not prevent fresh observations.
        if (
          (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
          !(error instanceof Error && error.message.startsWith('WORK_SYMLINK:'))
        )
          throw error;
      }
    }
    if (same)
      throw new Error(
        'WORK_EVIDENCE_IMMUTABLE: registered original changed; retain it and use a new path',
      );
  }
}

/** Check the original's declared observation, never infer its candidate at registration time. */
export async function manualEvidenceResult(
  root: string,
  source: string,
  task: Task,
  checkpoint: Checkpoint,
  criterion: string,
): Promise<'pass' | 'fail' | 'pending'> {
  if (typeof checkpoint.candidate === 'string')
    throw new Error('WORK_EVIDENCE: historical candidate cannot bind a new observation');
  const language =
    criterion === qualityCriterion.id
      ? 'mio-quality-review'
      : criterion === normsCriterion.id
        ? 'mio-norms-review'
        : 'mio-evidence';
  const report = record(metadata(source, language));
  if (!isDeepStrictEqual(report.contract, contractPlan(task)))
    throw new Error('WORK_EVIDENCE_CONTRACT: original contract does not match this task');
  if (criterion === qualityCriterion.id) return qualityReviewResult(report, checkpoint.candidate);
  if (criterion === normsCriterion.id)
    return normsReviewResult(root, report, task.plan, checkpoint);
  if (!sameCandidate(candidateRef(report.candidate), checkpoint.candidate))
    throw new Error('WORK_EVIDENCE: original candidate mismatch; review the current candidate');
  if (textField(report.criterion) !== criterion)
    throw new Error('WORK_EVIDENCE: original criterion mismatch');
  textField(report.observation);
  if (report.result !== 'pass' && report.result !== 'fail' && report.result !== 'pending')
    throw new Error('WORK_EVIDENCE: original result must be pass, fail or pending');
  return report.result;
}

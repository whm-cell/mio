import { lstat } from 'node:fs/promises';
import { checkedPath } from './records.ts';
import type { Checkpoint, Task, TaskPlan } from './records.ts';
import { hasResultSelector, parseSelector } from './compact-store.ts';
import { hashField, metadata, record, textField } from './report-format.ts';
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
  const inputs = new Set(
    Object.keys(task.checkpoint!.files).map((input) =>
      hasResultSelector(input) ? parseSelector(input).path : input,
    ),
  );
  for (const input of inputs) {
    if (sameFile(await lstat(await checkedPath(root, input))))
      throw new Error(
        'WORK_EVIDENCE_INPUT: original is a candidate input; retrieve an independent private copy before binding the observation',
      );
  }
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
  plan: TaskPlan,
  checkpoint: Checkpoint,
  criterion: string,
): Promise<'pass' | 'fail' | 'pending'> {
  if (criterion === qualityCriterion.id) return qualityReviewResult(source, checkpoint.candidate);
  if (criterion === normsCriterion.id) return normsReviewResult(root, source, plan, checkpoint);
  const report = record(metadata(source, 'mio-evidence'));
  if (hashField(report.candidate) !== checkpoint.candidate)
    throw new Error('WORK_EVIDENCE: original candidate mismatch; review the current candidate');
  if (textField(report.criterion) !== criterion)
    throw new Error('WORK_EVIDENCE: original criterion mismatch');
  if (report.result !== 'pass' && report.result !== 'fail' && report.result !== 'pending')
    throw new Error('WORK_EVIDENCE: original result must be pass, fail or pending');
  return report.result;
}

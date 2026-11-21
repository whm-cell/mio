import { isDeepStrictEqual } from 'node:util';
import { candidateRef, digest, json, sameCandidate } from './records.ts';
import type { Candidate, Evidence, Task } from './records.ts';
import { metadata, record, textField } from './report-format.ts';
import { artifact } from './original.ts';
import { readCommandOriginal } from './command-original.ts';
export { artifact } from './original.ts';
export { resultMarker } from './command-original.ts';

export function candidateEvidence(task: Task, candidate: Candidate | null) {
  const groups = new Map<string, Evidence[]>();
  if (!candidate) return groups;
  const methods = new Map(
    task.plan.acceptance.map((criterion) => [criterion.id, criterion.method]),
  );
  for (const entry of task.evidence) {
    if (methods.get(entry.criterion) !== entry.method || !sameCandidate(entry.candidate, candidate))
      continue;
    const entries = groups.get(entry.criterion);
    if (entries) entries.push(entry);
    else groups.set(entry.criterion, [entry]);
  }
  return groups;
}

/** Manual coverage is an explicit observation, never an automatically inherited pass. */
export function coverageEvidenceResult(
  source: string,
  candidate: Candidate,
  criterion: string,
  contract: unknown,
) {
  const report = record(metadata(source, 'mio-coverage'));
  if (!sameCandidate(candidateRef(report.candidate), candidate) || report.criterion !== criterion)
    throw new Error('WORK_COVERAGE: candidate or criterion mismatch');
  if (!isDeepStrictEqual(report.contract, contract))
    throw new Error('WORK_EVIDENCE_CONTRACT: original contract does not match this task');
  for (const field of ['reviewer', 'source', 'scope', 'environment', 'uncovered', 'assessment'])
    textField(report[field]);
  if (!['manual', 'ci'].includes(String(report.mode)) || report.executionCount !== 0)
    throw new Error('WORK_COVERAGE: mode and zero local executions required');
  if (report.mode === 'ci') textField(report.remoteExecution);
  if (!['pass', 'fail', 'pending'].includes(String(report.result)))
    throw new Error('WORK_COVERAGE: explicit pass/fail/pending required');
  return report.result as 'pass' | 'fail' | 'pending';
}

async function readAutomatedOriginal(root: string, id: string, entry: Evidence) {
  if (!entry.artifact.endsWith('.md')) return readCommandOriginal(root, id, entry);
  const bytes = await artifact(root, id, entry.artifact);
  if (digest(bytes) !== entry.sha256) return { result: 'corrupt' } as const;
  if (entry.result === 'pending') return { result: 'pending' } as const;
  return { result: 'read', source: bytes.toString('utf8') } as const;
}

/** A later failure, pending run or damaged original cannot be hidden by an older pass. */
export async function automatedEvidence(
  root: string,
  id: string,
  entries: Evidence[],
  command: string[] | undefined,
  contract: unknown,
) {
  if (!command) return { result: 'pending', evidence: [] };
  let newerIssue: string | undefined;
  const selected: Evidence[] = [];
  for (const entry of entries.toReversed()) {
    selected.push(entry);
    if (entry.result === 'pending' && entry.sha256 === undefined) {
      newerIssue ??= 'pending';
      continue;
    }
    let original: Awaited<ReturnType<typeof readAutomatedOriginal>>;
    try {
      original = await readAutomatedOriginal(root, id, entry);
    } catch {
      newerIssue ??= 'missing';
      continue;
    }
    if (original.result !== 'read') {
      newerIssue ??= original.result;
      continue;
    }
    try {
      if ('source' in original) {
        const { source } = original;
        if (typeof entry.candidate === 'string') throw new Error('Historical candidate');
        const observed = coverageEvidenceResult(source, entry.candidate, entry.criterion, contract);
        if (observed !== entry.result) throw new Error('Coverage result mismatch');
        const coverage = record(metadata(source, 'mio-coverage'));
        return {
          result: observed === 'pass' ? (newerIssue ?? 'pass') : observed,
          evidence: selected.toReversed(),
          basis: coverage.mode === 'ci' ? 'remote CI review' : 'manual review',
          executionCount: 0,
          ...(coverage.mode === 'ci' ? { remoteExecution: coverage.remoteExecution } : {}),
        };
      }
      const { header, outcome } = original;
      if (
        !sameCandidate(candidateRef(header.candidate), entry.candidate) ||
        !isDeepStrictEqual(header.contract, contract) ||
        !Array.isArray(header.argv) ||
        !header.argv.length ||
        header.argv.some((part: unknown) => typeof part !== 'string') ||
        (entry.result === 'pass' &&
          (outcome.exitCode !== 0 ||
            outcome.signal !== null ||
            outcome.error ||
            outcome.cancelled ||
            outcome.unsettled ||
            outcome.contextChanged))
      )
        throw new Error('Invalid command observation');
      if (json(header.argv) === json(command))
        return {
          result: entry.result === 'pass' ? (newerIssue ?? 'pass') : entry.result,
          evidence: selected.toReversed(),
          basis: 'execution',
          executionCount: 1,
        };
      if (entry.result !== 'pass') newerIssue ??= entry.result;
    } catch {
      newerIssue ??= 'invalid';
    }
  }
  return { result: newerIssue ?? 'pending', evidence: selected.toReversed() };
}

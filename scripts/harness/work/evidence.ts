import { isDeepStrictEqual } from 'node:util';
import { candidateRef, digest, json, sameCandidate } from './records.ts';
import type { Candidate, Evidence } from './records.ts';
import { metadata, record, textField } from './report-format.ts';
import { artifact } from './original.ts';
export { artifact } from './original.ts';

export const resultMarker = '\n--- mio-command-result ---\n';

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
    let bytes: Buffer;
    try {
      bytes = await artifact(root, id, entry.artifact);
    } catch {
      newerIssue ??= 'missing';
      continue;
    }
    if (digest(bytes) !== entry.sha256) {
      newerIssue ??= 'corrupt';
      continue;
    }
    if (entry.result === 'pending') {
      newerIssue ??= 'pending';
      continue;
    }
    try {
      const source = bytes.toString('utf8');
      if (entry.artifact.endsWith('.md')) {
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
      const end = source.indexOf('\n}\n');
      const header = JSON.parse(source.slice(0, end + 2));
      const marker = source.lastIndexOf(resultMarker);
      const outcome = JSON.parse(source.slice(marker + resultMarker.length));
      if (
        end < 0 ||
        marker < 0 ||
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

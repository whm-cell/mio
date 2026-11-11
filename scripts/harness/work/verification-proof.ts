import { readFile } from 'node:fs/promises';
import { artifact } from './original.ts';
import { checkedPath, digest, json, loadTask } from './records.ts';
import type { Checkpoint, Evidence, Task } from './records.ts';
import {
  changedFiles,
  checkpoint,
  nonempty,
  object,
  reference,
  refKey,
  stringArray,
  verification,
} from './verification-format.ts';
import type { EvidenceRef, Verification, EnvironmentSnapshot } from './verification-format.ts';
import { conditions, environmentSnapshot, runtimeEnvironment } from './verification-environment.ts';

export { runtimeEnvironment } from './verification-environment.ts';
export const evidenceRef = (task: string, entry: Evidence): EvidenceRef => ({
  task,
  criterion: entry.criterion,
  sha256: entry.sha256,
});
const unique = (refs: EvidenceRef[]) => [
  ...new Map(refs.map((ref) => [refKey(ref), ref])).values(),
];
interface Original {
  task: Task;
  entry: Evidence;
  index: number;
  text: string;
}
const proofMemo = () => ({
  originals: new Map<string, Original>(),
  proofs: new Map<string, Observation>(),
  observations: new Map<string, Observation>(),
});
type ProofMemo = ReturnType<typeof proofMemo>;

async function original(root: string, ref: EvidenceRef, memo: ProofMemo) {
  reference(ref);
  const key = refKey(ref);
  const cached = memo.originals.get(key);
  if (cached) return cached;
  await assertSourcesIdle(root, [ref]);
  const { task } = await loadTask(root, ref.task);
  const index = task.evidence.findIndex(
    (item) =>
      item.sha256 === ref.sha256 && item.criterion === ref.criterion && item.method === 'automated',
  );
  if (index < 0)
    throw new Error('WORK_VERIFY_REF: source is not a registered automated observation');
  const entry = task.evidence[index]!;
  const bytes = await artifact(root, ref.task, entry.artifact);
  if (digest(bytes) !== ref.sha256) throw new Error('WORK_VERIFY_ORIGINAL: original changed');
  const value = { task, entry, index, text: bytes.toString('utf8') };
  memo.originals.set(key, value);
  return value;
}

function observationHeader(text: string) {
  return object(JSON.parse(text.slice(0, text.indexOf('\n}\n') + 2)));
}

function executionHeader(text: string, entry: Evidence) {
  const header = observationHeader(text);
  stringArray(header.argv);
  if (
    !header.argv.length ||
    header.candidate !== entry.candidate ||
    header.environment !== entry.environment
  )
    throw new Error('WORK_VERIFY_ORIGINAL: execution header mismatch');
  const end = object(JSON.parse(text.slice(text.lastIndexOf('\n{') + 1)));
  if (
    end.exitCode !== 0 ||
    end.cancelled !== false ||
    end.unsettled !== false ||
    end.signal !== null ||
    end.error ||
    !entry.summary.includes('contextChanged=false')
  )
    throw new Error('WORK_VERIFY_EXECUTION: no settled successful execution');
  return header as Record<string, unknown> & { argv: string[] };
}

/** Only explicit source ledgers are read; no global scan or inferred ownership. */
async function laterIssues(
  root: string,
  task: Task,
  criterion: string,
  after: number,
  bounds = new Map<string, number>(),
  memo = proofMemo(),
): Promise<EvidenceRef[]> {
  const issues: EvidenceRef[] = [];
  for (const entry of task.evidence.slice(after + 1, bounds.get(`${task.plan.id}:${criterion}`))) {
    if (entry.method !== 'automated' || entry.criterion !== criterion) continue;
    let invalid = entry.result !== 'pass';
    try {
      if (!invalid) await original(root, evidenceRef(task.plan.id, entry), memo);
      if (!invalid && entry.artifact.endsWith('.verification.json')) {
        const later = await observe(
          root,
          evidenceRef(task.plan.id, entry),
          undefined,
          new Set(),
          bounds,
          memo,
        );
        issues.push(...later.issues);
      }
    } catch {
      invalid = true;
    }
    if (invalid) issues.push(evidenceRef(task.plan.id, entry));
  }
  return issues;
}

export interface Observation {
  checkpoint: Checkpoint;
  command: string[];
  environment: string;
  environmentSnapshot?: EnvironmentSnapshot;
  kind: 'execution' | 'reuse' | 'incremental';
  issues: EvidenceRef[];
}

type ObservationScope = Pick<Observation, 'checkpoint' | 'environmentSnapshot'>;

function differentEnvironment(a?: EnvironmentSnapshot, b?: EnvironmentSnapshot) {
  if (!a || !b) return false;
  const { conditions: aConditions, ...aFingerprint } = a;
  const { conditions: bConditions, ...bFingerprint } = b;
  return (
    json(aFingerprint) !== json(bFingerprint) ||
    (!!aConditions && !!bConditions && json(aConditions) !== json(bConditions))
  );
}

/** An unrelated success cannot hide failures of the target inputs or the baseline being retained. */
async function skippedTargetIssues(
  root: string,
  source: { task: Task; index: number },
  criterion: string,
  boundary: Observation,
  scopes: readonly [ObservationScope, ObservationScope],
  bounds: Map<string, number>,
  memo: ProofMemo,
) {
  const [current, baseline] = scopes;
  const boundaryFiles = json(boundary.checkpoint.files);
  const covered = (scope: ObservationScope) =>
    !!scope.environmentSnapshot?.conditions &&
    json(scope.environmentSnapshot) === json(boundary.environmentSnapshot) &&
    json(scope.checkpoint.files) === boundaryFiles;
  if (covered(current)) return [];
  const uncovered = (covered(baseline) ? [current] : scopes).map((scope) => ({
    ...scope,
    inputMap: digest(json(scope.checkpoint.files)),
  }));
  const issues: EvidenceRef[] = [];
  const ledgerKey = `${source.task.plan.id}:${criterion}`;
  for (const [index, entry] of source.task.evidence.slice(0, source.index).entries()) {
    if (entry.method !== 'automated' || entry.criterion !== criterion) continue;
    const receipt = entry.artifact.endsWith('.verification.json');
    if (entry.result === 'pass' && !receipt) continue;
    const ref = evidenceRef(source.task.plan.id, entry);
    let inputs: unknown;
    let environment: EnvironmentSnapshot | undefined;
    try {
      const { text } = await original(root, ref, memo);
      if (receipt) {
        const doc = verification(JSON.parse(text));
        inputs = digest(json(doc.checkpoint.files));
        environment = environmentSnapshot(doc.environment.snapshot);
      } else {
        const header = observationHeader(text);
        if (header.candidate !== entry.candidate) throw new Error('Observation candidate mismatch');
        inputs = header.checkpoint
          ? digest(json(checkpoint(header.checkpoint).files))
          : header.inputMap;
        if (header.environmentSnapshot)
          environment = environmentSnapshot(header.environmentSnapshot);
      }
    } catch {
      // A damaged original cannot rule out a known candidate match.
    }
    if (
      !uncovered.some(
        (scope) =>
          (entry.candidate === scope.checkpoint.candidate || inputs === scope.inputMap) &&
          !differentEnvironment(environment, scope.environmentSnapshot),
      )
    )
      continue;
    if (entry.result !== 'pass') issues.push(ref);
    else {
      try {
        // Other local entries are reviewed separately by scope. Keep later failures from external sources.
        const prefix = new Map(bounds).set(
          ledgerKey,
          Math.min(index, bounds.get(ledgerKey) ?? index),
        );
        issues.push(...(await observe(root, ref, undefined, new Set(), prefix, memo)).issues);
      } catch {
        issues.push(ref);
      }
    }
  }
  return issues;
}

export async function observe(
  root: string,
  ref: EvidenceRef,
  legacy?: Checkpoint,
  visited = new Set<string>(),
  bounds = new Map<string, number>(),
  memo = proofMemo(),
): Promise<Observation> {
  const key = refKey(ref);
  if (visited.has(key)) throw new Error('WORK_VERIFY_CYCLE: cyclic evidence reference');
  const observationKey = `${key}:${legacy?.candidate ?? ''}:${json([...bounds].sort())}`;
  const cached = memo.observations.get(observationKey);
  if (cached) return cached;
  const next = new Set(visited).add(key);
  const { task, entry, index, text } = await original(root, ref, memo);
  if (entry.result !== 'pass')
    throw new Error('WORK_VERIFY_BASELINE: baseline/rerun must have passed');
  let observation: Observation;
  if (entry.artifact.endsWith('.verification.json')) {
    const doc = verification(JSON.parse(text));
    if (
      doc.target.task !== ref.task ||
      doc.target.criterion !== ref.criterion ||
      doc.checkpoint.candidate !== entry.candidate
    )
      throw new Error('WORK_VERIFY_BINDING: receipt target mismatch');
    const cutoff = new Map(bounds).set(`${ref.task}:${ref.criterion}`, index);
    const memoKey = `${key}:${json([...cutoff].sort())}`;
    observation =
      memo.proofs.get(memoKey) ?? (await evaluateVerification(root, doc, next, cutoff, memo));
    memo.proofs.set(memoKey, observation);
  } else {
    const header = executionHeader(text, entry);
    const saved =
      header.checkpoint ??
      legacy ??
      (task.checkpoint?.candidate === entry.candidate ? task.checkpoint : undefined);
    if (!saved) throw new Error('WORK_VERIFY_SNAPSHOT: retrieve the matching legacy checkpoint');
    const snapshot = checkpoint(saved);
    if (snapshot.candidate !== entry.candidate)
      throw new Error('WORK_VERIFY_SNAPSHOT: execution and snapshot disagree');
    observation = {
      checkpoint: snapshot,
      command: header.argv,
      environment: entry.environment,
      ...(header.environmentSnapshot
        ? { environmentSnapshot: environmentSnapshot(header.environmentSnapshot) }
        : {}),
      kind: 'execution',
      issues: [],
    };
  }
  const complete = {
    ...observation,
    issues: unique([
      ...observation.issues,
      ...(await laterIssues(root, task, ref.criterion, index, bounds, memo)),
    ]),
  };
  memo.observations.set(observationKey, complete);
  return complete;
}

export async function targetIssues(
  root: string,
  task: Task,
  criterion: string,
  command: string[],
  scopes: readonly [ObservationScope, ObservationScope],
  legacy?: Checkpoint,
) {
  const memo = proofMemo();
  for (let index = task.evidence.length - 1; index >= 0; index--) {
    const entry = task.evidence[index]!;
    if (entry.criterion !== criterion || entry.method !== 'automated' || entry.result !== 'pass')
      continue;
    try {
      const value = await observe(
        root,
        evidenceRef(task.plan.id, entry),
        legacy,
        new Set(),
        new Map(),
        memo,
      );
      if (
        json(value.command) === json(command) &&
        !(
          await skippedTargetIssues(
            root,
            { task, index },
            criterion,
            value,
            scopes,
            new Map(),
            memo,
          )
        ).length
      )
        return {
          issues: value.issues,
          boundary: { ref: evidenceRef(task.plan.id, entry), checkpoint: value.checkpoint },
        };
    } catch {
      /* Older invalid observations remain issues, not a reset boundary. */
    }
  }
  return { issues: await laterIssues(root, task, criterion, -1, new Map(), memo) };
}

export async function evaluateVerification(
  root: string,
  doc: Verification,
  visited = new Set<string>(),
  bounds = new Map<string, number>(),
  memo = proofMemo(),
): Promise<Observation> {
  const base = await observe(root, doc.baseline, doc.legacyCheckpoint, visited, bounds, memo);
  if (
    doc.priorBoundary &&
    (doc.priorBoundary.ref.task !== doc.target.task ||
      doc.priorBoundary.ref.criterion !== doc.target.criterion)
  )
    throw new Error('WORK_VERIFY_BOUNDARY: prior success must belong to the target criterion');
  const boundary = doc.priorBoundary
    ? await observe(
        root,
        doc.priorBoundary.ref,
        doc.priorBoundary.checkpoint,
        visited,
        bounds,
        memo,
      )
    : undefined;
  if (boundary && json(boundary.command) !== json(doc.target.command))
    throw new Error('WORK_VERIFY_BOUNDARY: prior success must cover the declared command');
  if (json(base.command) !== json(doc.target.command))
    throw new Error('WORK_VERIFY_COMMAND: baseline does not cover the declared command');
  if (
    doc.environment.identity !== runtimeEnvironment() ||
    base.environment !== doc.environment.identity
  )
    throw new Error('WORK_VERIFY_ENVIRONMENT: execution environments differ');
  conditions(doc.environment.conditions);
  const currentEnvironment = environmentSnapshot(doc.environment.snapshot);
  let baselineEnvironment = base.environmentSnapshot;
  if (!baselineEnvironment?.conditions) {
    if (!doc.legacyEnvironment)
      throw new Error(
        'WORK_VERIFY_ENVIRONMENT: restore legacy execution conditions with observed evidence',
      );
    nonempty(doc.legacyEnvironment.reason);
    const restored = environmentSnapshot(doc.legacyEnvironment.snapshot);
    if (
      baselineEnvironment &&
      json({ ...restored, conditions: null }) !== json(baselineEnvironment)
    )
      throw new Error(
        'WORK_VERIFY_ENVIRONMENT: restored conditions cannot replace recorded fingerprints',
      );
    baselineEnvironment = restored;
  }
  if (
    !baselineEnvironment.conditions ||
    baselineEnvironment.runtime !== base.environment ||
    currentEnvironment.runtime !== doc.environment.identity ||
    json(currentEnvironment.conditions) !== json(doc.environment.conditions)
  )
    throw new Error('WORK_VERIFY_ENVIRONMENT: conditions are incomplete or inconsistent');
  const environmentChanged = json(baselineEnvironment) !== json(currentEnvironment);
  if (doc.mode === 'reuse' && environmentChanged)
    throw new Error(
      'WORK_VERIFY_ENVIRONMENT: direct reuse requires matching execution conditions and fingerprints',
    );
  const changed = changedFiles(base.checkpoint, doc.checkpoint);
  if (doc.mode === 'reuse' && changed.length)
    throw new Error('WORK_VERIFY_INPUTS: reuse requires identical input maps');
  if (json([...doc.impact.map((item) => item.path)].sort()) !== json(changed))
    throw new Error(
      'WORK_VERIFY_COVERAGE: account for every added, changed and deleted input exactly once',
    );
  const runs = new Map<string, Observation>();
  for (const ref of doc.runs) {
    const run = await observe(root, ref, undefined, visited, bounds, memo);
    if (
      json(run.checkpoint.files) !== json(doc.checkpoint.files) ||
      run.environment !== doc.environment.identity ||
      json(run.environmentSnapshot) !== json(currentEnvironment)
    )
      throw new Error(
        'WORK_VERIFY_RERUN: use verified observations of the current input map and environment',
      );
    runs.set(refKey(ref), run);
  }
  if (environmentChanged && !runs.size)
    throw new Error(
      'WORK_VERIFY_ENVIRONMENT: changed conditions require current execution evidence and an applicability review',
    );
  const requireRuns = (refs: EvidenceRef[]) => {
    if (!refs.length || refs.some((ref) => !runs.has(refKey(ref))))
      throw new Error(
        'WORK_VERIFY_COVERAGE: affected inputs/issues need declared successful reruns',
      );
  };
  for (const item of doc.impact) {
    if (item.disposition === 'retest') requireRuns(item.runs);
    else if (item.runs.length)
      throw new Error('WORK_VERIFY_COVERAGE: retained inputs do not name reruns');
  }
  // Prior target failures are immutable references; later source/target failures are re-read.
  for (const ref of doc.priorIssues) await original(root, ref, memo);
  const skipped =
    doc.priorBoundary && boundary
      ? await skippedTargetIssues(
          root,
          await original(root, doc.priorBoundary.ref, memo),
          doc.target.criterion,
          boundary,
          [
            { checkpoint: doc.checkpoint, environmentSnapshot: currentEnvironment },
            { checkpoint: base.checkpoint, environmentSnapshot: baselineEnvironment },
          ],
          bounds,
          memo,
        )
      : [];
  const issues = unique([
    ...base.issues,
    ...(boundary?.issues ?? []),
    ...skipped,
    ...doc.priorIssues,
    ...[...runs.values()].flatMap((run) => run.issues),
  ]);
  const resolved = new Set<string>();
  for (const resolution of doc.resolves) {
    const key = refKey(resolution.issue);
    if (!issues.some((ref) => refKey(ref) === key) || resolved.has(key))
      throw new Error('WORK_VERIFY_RESOLUTION: unknown or duplicate issue');
    requireRuns(resolution.runs);
    if (resolution.runs.some((ref) => runs.get(refKey(ref))!.kind !== 'execution'))
      throw new Error(
        'WORK_VERIFY_RECOVERY_EXECUTION: recovery requires actual execution originals',
      );
    const issue = await original(root, resolution.issue, memo);
    for (const ref of resolution.runs) {
      const run = await original(root, ref, memo);
      if (ref.task === resolution.issue.task) {
        if (run.index <= issue.index)
          throw new Error('WORK_VERIFY_ORDER: recovery must execute after the issue');
      } else {
        const end = object(JSON.parse(issue.text.slice(issue.text.lastIndexOf('\n{') + 1)));
        const start = executionHeader(run.text, run.entry);
        if (
          typeof end.finished !== 'string' ||
          typeof start.started !== 'string' ||
          !Number.isFinite(Date.parse(end.finished)) ||
          Date.parse(start.started) <= Date.parse(end.finished)
        )
          throw new Error(
            'WORK_VERIFY_ORDER: cross-task recovery needs an observed end followed by a new execution',
          );
      }
    }
    resolved.add(key);
  }
  return {
    checkpoint: doc.checkpoint,
    command: doc.target.command,
    environment: doc.environment.identity,
    environmentSnapshot: currentEnvironment,
    kind: doc.mode,
    issues: issues.filter((ref) => !resolved.has(refKey(ref))),
  };
}

export async function assertSourcesIdle(root: string, refs: EvidenceRef[]) {
  for (const id of new Set(refs.map((ref) => ref.task))) {
    try {
      const owner = JSON.parse(
        await readFile(await checkedPath(root, `.work/tasks/${id}.command.json`), 'utf8'),
      );
      if (owner.pid === process.pid) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(`WORK_VERIFY_BUSY: source ${id} has an active or interrupted command`);
  }
}

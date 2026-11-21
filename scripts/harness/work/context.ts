import { spawnSync } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { beneath, loadConfig } from '../inventory.ts';
import { checkedPath, contractPlan, contractRevision, digest, sameCandidate } from './records.ts';
import type { Candidate, Evidence, Task } from './records.ts';
import { deliveryOutput, readDraft, readResultInput } from './reports.ts';
import { hasResultSelector, parseSelector } from './compact-store.ts';
import { needsQualityReview, qualityCriterion } from './quality-review.ts';
import { documentCatalog, resolveDocument } from '../task-documents.ts';
import { normsCriterion, normsIssues } from './norms-review.ts';
import { requirementIssues } from './requirements.ts';
import { manualEvidenceResult } from './manual-evidence.ts';
import { artifact, automatedEvidence, candidateEvidence } from './evidence.ts';
export { runtimeEnvironment as environment } from './verification-environment.ts';

export { artifact } from './evidence.ts';

export function firstUncommittedPath(root: string, commit: string, paths: readonly string[]) {
  const requested = [...new Set(paths)];
  if (!requested.length) return undefined;

  const input = requested.map((path) => `${commit}:${path}\0`).join('');
  const batch = spawnSync('git', ['cat-file', '--batch-check=present', '-z'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    input,
    maxBuffer: Math.max(1024 * 1024, Buffer.byteLength(input) + requested.length * 16),
  });
  if (batch.error) return requested[0];

  // Requests use NUL separators. Each successful reply is the same line, even for paths with LF.
  const present = 'present\n';
  const output = batch.stdout ?? '';
  let offset = 0;
  for (const path of requested) {
    if (!output.startsWith(present, offset)) return path;
    offset += present.length;
  }
  return batch.status === 0 && offset === output.length ? undefined : requested[0];
}

/** Validate declared ownership and paths without computing a tree of file contents. */
export async function validateInputs(root: string, task: Task, commit?: string): Promise<void> {
  const config = await loadConfig(root);
  const catalog = await documentCatalog(root, config);
  const candidatePaths: string[] = [];
  let localFailure: { error: unknown } | undefined;
  try {
    for (const [kind, paths] of [
      [
        'source',
        [
          ...task.plan.sources,
          ...(task.plan.requirement ? [task.plan.requirement.source] : []),
          ...(task.plan.result ? [task.plan.result.prd] : []),
          ...(task.plan.norms?.paths ?? []),
        ],
      ],
      ['input', task.plan.inputs],
      ['scope', task.plan.scope],
    ] as const) {
      for (const reference of paths) {
        if (hasResultSelector(reference)) {
          const selector = parseSelector(reference);
          await checkedPath(root, selector.path);
          if (kind !== 'input')
            throw new Error('WORK_REPORT_SELECTOR: use selectors only in inputs');
          if (deliveryOutput(task, reference, catalog))
            throw new Error('WORK_DELIVERY_INPUT: own result cannot be an input');
          await readResultInput(root, reference, catalog);
          if (commit) candidatePaths.push(selector.path);
          continue;
        }
        const path =
          kind === 'source' ? resolveDocument(reference, catalog).currentPath : reference;
        if (path !== '.') await checkedPath(root, path);
        if (
          [...config.privateRoots, ...config.generatedRoots].some((base) => beneath(path, base)) ||
          (path !== '.env.example' && path.split('/').some((part) => /^\.env(?:\.|$)/.test(part)))
        )
          throw new Error(`WORK_PRIVATE: ${path}`);
        if (deliveryOutput(task, path, catalog) && kind === 'source')
          throw new Error(
            'WORK_DELIVERY_INPUT: own delivery output cannot be a requirement/source',
          );
        if (kind !== 'scope') {
          let stat;
          try {
            stat = await lstat(path === '.' ? root : await checkedPath(root, path));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            throw new Error(`WORK_INPUT_MISSING: ${path}`);
          }
          if (kind === 'source' && (!path.endsWith('.md') || !stat.isFile()))
            throw new Error(`WORK_SOURCE: name an existing public Markdown file: ${path}`);
          if (commit && path !== '.') candidatePaths.push(path);
        }
      }
    }
  } catch (error) {
    localFailure = { error };
  }
  // Check earlier paths before returning a later local error, as with one lookup per path.
  const missing = commit && firstUncommittedPath(root, commit, candidatePaths);
  if (missing) throw new Error(`WORK_INPUT_UNCOMMITTED: ${missing}`);
  if (localFailure) throw localFailure.error;
}

/** Git determines whether a committed candidate exists; ignored process records are outside it. */
export async function capture(root: string, task: Task) {
  const git = (args: string[]) => {
    const result = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status === null) throw new Error('WORK_GIT: cannot inspect working tree status');
  const head = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  const dirty = status.length !== 0;
  return {
    head,
    branch: git(['symbolic-ref', '--short', '-q', 'HEAD']),
    dirty,
    candidate: !dirty && head ? { commit: head, contractRevision: contractRevision(task) } : null,
  };
}

export async function requireCandidate(root: string, task: Task): Promise<Candidate> {
  const current = await capture(root, task);
  if (!current.candidate || !sameCandidate(current.candidate, task.checkpoint?.candidate))
    throw new Error('WORK_CANDIDATE: commit and sync a clean HEAD for the current contract');
  await validateInputs(root, task, current.candidate.commit);
  if (!sameCandidate((await capture(root, task)).candidate, current.candidate))
    throw new Error('WORK_CANDIDATE: HEAD or working tree changed during validation');
  return current.candidate;
}

export function contractIssues(task: Task): string[] {
  const errors: string[] = [];
  if (task.plan.result === undefined)
    errors.push(
      'WORK_RESULT_REQUIRED: declare plan.result for development, or explicit null for work with no development result; inspect the actual goal before implementation',
    );
  for (const criterion of task.plan.acceptance) {
    if (
      ['C1_EVIDENCE_PENDING', 'C1_RELEASED'].includes(task.stage ?? '') &&
      criterion.method === 'automated' &&
      !criterion.command
    )
      errors.push(
        `WORK_CHECK_COMMAND: declare acceptance ${criterion.id}.command as the complete check argv before collecting evidence`,
      );
  }
  for (const key of ['goal', 'authorization', 'nextAction', 'stopCondition'] as const) {
    if (!task.plan[key].trim()) errors.push(`WORK_CONTRACT: plan.${key} is required`);
  }
  if (!task.plan.scope.length || !task.plan.acceptance.length)
    errors.push('WORK_CONTRACT: define scope and acceptance');
  if (task.archived) errors.push('WORK_ARCHIVED: history is not an active instruction');
  if (
    task.plan.blockers.length ||
    task.plan.decisions.some((entry) => entry.status === 'OPEN') ||
    task.plan.dependencies.some((entry) => !entry.ready)
  )
    errors.push('WORK_BLOCKED: reconcile open decisions, dependencies and blockers');
  if (task.reviewDecision === 'REQUEST_CHANGES' && task.stage === 'C1_RELEASED')
    errors.push('WORK_REVIEW: requested changes are unresolved');
  return errors;
}

export async function assessWithEvidence(
  root: string,
  task: Task,
  options: { inspectDelivery?: boolean } = {},
) {
  const { inspectDelivery = true } = options;
  const current = await capture(root, task);
  const errors = [...contractIssues(task), ...(await requirementIssues(root, task.plan))];
  await validateInputs(root, task);
  const qualityRequired = needsQualityReview(task.plan, await loadConfig(root));
  const normsErrors = await normsIssues(
    root,
    task.plan,
    inspectDelivery && !!(task.plan.result || task.plan.norms) && task.stage !== 'C1_RELEASED',
  );
  const quality = task.plan.acceptance.find((item) => item.id === qualityCriterion.id);
  if ((qualityRequired && !quality) || (quality && quality.method !== qualityCriterion.method))
    errors.push(
      'WORK_QUALITY_CONTRACT: register quality-review with method review using work update',
    );
  const candidate = sameCandidate(task.checkpoint?.candidate, current.candidate)
    ? current.candidate
    : null;
  if (!candidate && ['C1_EVIDENCE_PENDING', 'C1_RELEASED'].includes(task.stage ?? ''))
    errors.push('WORK_CANDIDATE: commit and sync a clean HEAD for the current contract');
  const evidence = [];
  const selectedEvidence: Evidence[] = [];
  const grouped = candidateEvidence(task, candidate);
  const contract = contractPlan(task);
  for (const criterion of task.plan.acceptance) {
    const entries = grouped.get(criterion.id) ?? [];
    if (criterion.method === 'automated') {
      const observation = await automatedEvidence(
        root,
        task.plan.id,
        entries,
        criterion.command,
        contract,
      );
      if (observation.result === 'pass')
        for (const entry of observation.evidence) selectedEvidence.push(entry);
      evidence.push({
        criterion: criterion.id,
        method: criterion.method,
        result: observation.result,
        ...('basis' in observation ? { basis: observation.basis } : {}),
        ...('executionCount' in observation ? { executionCount: observation.executionCount } : {}),
        ...('remoteExecution' in observation
          ? { remoteExecution: observation.remoteExecution }
          : {}),
      });
      continue;
    }
    const entry = entries.at(-1);
    let result = entry?.result ?? 'pending';
    if (entry) {
      try {
        const bytes = await artifact(root, task.plan.id, entry.artifact);
        if (digest(bytes) !== entry.sha256) result = 'corrupt';
        else {
          try {
            if (
              (await manualEvidenceResult(
                root,
                bytes.toString('utf8'),
                task,
                { candidate: candidate! },
                criterion.id,
              )) !== entry.result
            )
              result = 'invalid';
          } catch {
            result = 'invalid';
          }
        }
      } catch {
        result = 'missing';
      }
    }
    if (entry && result === 'pass') selectedEvidence.push(entry);
    evidence.push({ criterion: criterion.id, method: criterion.method, result });
  }
  if (task.stage === 'C1_RELEASED' || task.releaseDisposition === 'RELEASED') {
    if (
      task.stage !== 'C1_RELEASED' ||
      task.releaseDisposition !== 'RELEASED' ||
      task.reviewDecision !== 'ACCEPT' ||
      evidence.some((entry) => entry.result !== 'pass')
    )
      errors.push('WORK_RELEASE: matching evidence and explicit human ACCEPT are required');
  }
  let readyForAcceptance = false;
  let draftIssue: string | null = null;
  if (
    inspectDelivery &&
    task.delivery &&
    !errors.length &&
    !normsErrors.length &&
    evidence.every((entry) => entry.result === 'pass') &&
    task.stage === 'C1_EVIDENCE_PENDING' &&
    task.reviewDecision === 'PENDING' &&
    candidate
  ) {
    try {
      await readDraft(root, task, candidate);
      readyForAcceptance = true;
    } catch (error) {
      draftIssue = error instanceof Error ? error.message : String(error);
    }
  }
  const releaseDisposition =
    !errors.length && task.stage === 'C1_RELEASED'
      ? 'RELEASED'
      : readyForAcceptance
        ? 'HOLD_FOR_HUMAN_REVIEW'
        : 'HOLD_FOR_EVIDENCE';
  const assessment = {
    ready: errors.length === 0,
    stage: task.stage,
    candidate,
    git: { head: current.head, branch: current.branch, dirty: current.dirty },
    changed: [],
    errors,
    evidence,
    reviewDecision: task.reviewDecision,
    releaseDisposition,
    readyForAcceptance,
    draftIssue,
    qualityReview: {
      required: qualityRequired,
      criterion: qualityCriterion.id,
      result:
        evidence.find((item) => item.criterion === qualityCriterion.id)?.result ??
        (qualityRequired ? 'unregistered' : 'not_required'),
    },
    normsReview: {
      required: !!(task.plan.result || task.plan.norms),
      issues: normsErrors,
      result:
        evidence.find((item) => item.criterion === normsCriterion.id)?.result ??
        (task.plan.result || task.plan.norms ? 'unregistered' : 'not_required'),
    },
    nextAction: task.plan.nextAction,
  };
  return { assessment, selectedEvidence };
}

export async function assess(root: string, task: Task) {
  return (await assessWithEvidence(root, task)).assessment;
}

export function addEvidence(
  task: Task,
  entry: Evidence,
  nextAction?: string,
  replaceIndex?: number,
) {
  if (!sameCandidate(entry.candidate, task.checkpoint?.candidate))
    throw new Error('WORK_EVIDENCE: checkpoint mismatch');
  if (replaceIndex === undefined) task.evidence.push(entry);
  else {
    const pending = task.evidence[replaceIndex];
    if (!pending || pending.result !== 'pending' || pending.artifact !== entry.artifact)
      throw new Error('WORK_RUN_SETTLEMENT: pending observation mismatch');
    task.evidence[replaceIndex] = entry;
  }
  task.reviewDecision = 'PENDING';
  task.releaseDisposition = 'HOLD_FOR_EVIDENCE';
  task.stage = 'C1_EVIDENCE_PENDING';
  task.plan.nextAction =
    nextAction ??
    `Review ${entry.criterion} (${entry.result}), current originals and remaining gaps; ` +
      (task.plan.result
        ? 'when sufficient, prepare the candidate for actual acceptance.'
        : 'The task declares no development result; return verified maintenance and archive when appropriate.');
}

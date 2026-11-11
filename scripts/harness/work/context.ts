import { spawnSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { beneath, inventory, loadConfig } from '../inventory.ts';
import { checkedPath, deliveryPending, digest, json } from './records.ts';
import type { Checkpoint, Evidence, Task } from './records.ts';
import { compactInputs, deliveryOutput, readDraft, readResultInput } from './reports.ts';
import { hasResultSelector, parseSelector, recordsFile } from './compact-store.ts';
import { needsQualityReview, qualityCriterion } from './quality-review.ts';
import { documentCatalog, resolveDocument } from '../task-documents.ts';
import { normsCriterion, normsIssues } from './norms-review.ts';
import { requirementIssues } from './requirements.ts';
import { readConflict } from './reconciliation.ts';
import { manualEvidenceResult } from './manual-evidence.ts';
import { artifact, automatedEvidence } from './evidence.ts';
export { runtimeEnvironment as environment } from './verification-proof.ts';

export { artifact } from './evidence.ts';

export const requiredSources = ['AGENTS.md', 'docs/coordination.md', 'docs/work-records.md'];

export async function capture(root: string, task: Task): Promise<Checkpoint> {
  const config = await loadConfig(root);
  const scan = await inventory(root, config);
  if (scan.errors.length) throw new Error(scan.errors.join('\n'));
  const catalog = await documentCatalog(root, config);
  const selected = new Set<string>(['harness.config.json']);
  for (const [kind, paths] of [
    [
      'source',
      [
        ...requiredSources,
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
        if (kind !== 'input') throw new Error('WORK_REPORT_SELECTOR: use selectors only in inputs');
        if (deliveryOutput(task, reference, catalog))
          throw new Error('WORK_DELIVERY_INPUT: own result cannot be an input');
        await readResultInput(root, reference, catalog);
        selected.add(reference);
        for (const entry of catalog.documents)
          if (beneath(selector.path, dirname(entry.registry))) selected.add(entry.registry);
        continue;
      }
      const path = kind === 'source' ? resolveDocument(reference, catalog).currentPath : reference;
      if (path !== '.') await checkedPath(root, path);
      if (
        [...config.privateRoots, ...config.generatedRoots].some((base) => beneath(path, base)) ||
        (path !== '.env.example' && path.split('/').some((part) => /^\.env(?:\.|$)/.test(part)))
      )
        throw new Error(`WORK_PRIVATE: ${path}`);
      const matches = scan.files.filter((file) => path === '.' || beneath(file, path));
      if (kind === 'source' && (!path.endsWith('.md') || !scan.files.includes(path)))
        throw new Error(`WORK_SOURCE: name an existing public Markdown file: ${path}`);
      if (!matches.length && kind !== 'scope') throw new Error(`WORK_INPUT_MISSING: ${path}`);
      if (deliveryOutput(task, path, catalog) && kind === 'source')
        throw new Error('WORK_DELIVERY_INPUT: own delivery output cannot be a requirement/source');
      matches.forEach((file) => {
        if (!deliveryOutput(task, file, catalog)) selected.add(file);
      });
      for (const entry of catalog.documents) {
        const references = [entry.identity, entry.path, ...(entry.aliases ?? [])];
        const readsDocument = references.some((file) => path === '.' || beneath(file, path));
        if (readsDocument)
          [entry.path, ...(entry.aliases ?? [])].forEach((file) => selected.add(file));
        if (readsDocument || beneath(path, dirname(entry.registry))) selected.add(entry.registry);
      }
    }
  }
  const files: Record<string, string> = {};
  for (const file of [...selected].sort()) {
    if (recordsFile(file)) Object.assign(files, await compactInputs(root, file, task, catalog));
    else if (hasResultSelector(file)) {
      const content = await readResultInput(root, file, catalog);
      if (content === null) throw new Error(`WORK_INPUT_MISSING: ${file}`);
      files[file] = digest(content);
    } else files[file] = digest(await readFile(await checkedPath(root, file)));
  }
  const plan = task.plan;
  const contractPlan = {
    id: plan.id,
    goal: plan.goal,
    scope: plan.scope,
    inputs: plan.inputs,
    sources: plan.sources,
    authorization: plan.authorization,
    nonGoals: plan.nonGoals,
    acceptance: plan.acceptance,
    decisions: plan.decisions,
    dependencies: plan.dependencies,
    stopCondition: plan.stopCondition,
    ...(plan.requirement ? { requirement: plan.requirement } : {}),
    ...(plan.result !== undefined ? { result: plan.result } : {}),
    ...(plan.norms ? { norms: plan.norms } : {}),
    ...(task.delivery ? { deliveryVersion: task.delivery.version } : {}),
  };
  const contract = digest(json(contractPlan));
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  return {
    head: git(['rev-parse', '--verify', 'HEAD']),
    branch: git(['symbolic-ref', '--short', '-q', 'HEAD']),
    files,
    contract,
    candidate: digest(json({ files, contract })),
  };
}

/** A restore can hide a write from byte snapshots. Observe file identity/change times and source directories too. */
export async function inputStamp(root: string, checkpoint: Checkpoint): Promise<string> {
  const physical = Object.keys(checkpoint.files).map((file) =>
    hasResultSelector(file) ? parseSelector(file).path : file,
  );
  const paths = new Set(physical);
  for (const file of physical) {
    for (let parent = dirname(file); parent !== '.'; parent = dirname(parent)) paths.add(parent);
  }
  const stamps: Record<string, string> = {};
  for (const path of [...paths].sort()) {
    const stat = await lstat(await checkedPath(root, path), { bigint: true });
    stamps[path] =
      `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;
  }
  return json(stamps);
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

export async function assess(
  root: string,
  task: Task,
  options: { inspectDelivery?: boolean; reconciling?: boolean } = {},
) {
  const { inspectDelivery = true, reconciling = false } = options;
  const current = await capture(root, task);
  const errors = [...contractIssues(task), ...(await requirementIssues(root, task.plan))];
  if (!reconciling && (await readConflict(root, task.plan.id)) !== null)
    errors.push(
      `WORK_RECONCILE: unresolved conflict at .work/tasks/${task.plan.id}/conflict.json; inspect current context, then update using its revision and a reconciliation reason`,
    );
  if (inspectDelivery && (await deliveryPending(root, task.plan.id)))
    errors.push('WORK_DELIVERY_PENDING: resume the original delivery request');
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
  const previous = task.checkpoint;
  const changed = [
    ...new Set([...Object.keys(previous?.files ?? {}), ...Object.keys(current.files)]),
  ].filter((path) => previous?.files[path] !== current.files[path]);
  if (!previous) errors.push('WORK_CHECKPOINT: reconcile with work sync');
  else {
    if (changed.length || previous.contract !== current.contract)
      errors.push(
        `WORK_CONTEXT_CHANGED: ${changed.join(', ') || 'task contract'}; inspect changes before work sync`,
      );
    if (previous.head !== current.head || previous.branch !== current.branch)
      errors.push('WORK_REVISION_CHANGED: inspect branch/HEAD and diff before work sync');
  }
  const evidence = [];
  for (const criterion of task.plan.acceptance) {
    const entries = task.evidence.filter(
      (item) =>
        item.criterion === criterion.id &&
        item.method === criterion.method &&
        item.candidate === current.candidate,
    );
    if (criterion.method === 'automated') {
      const observation = await automatedEvidence(root, task.plan.id, entries, criterion.command);
      evidence.push({
        criterion: criterion.id,
        method: criterion.method,
        result: observation.result,
        ...('basis' in observation ? { basis: observation.basis } : {}),
      });
      continue;
    }
    const entry = entries.at(-1);
    let result = entry?.result ?? 'pending';
    if (entry) {
      try {
        const bytes = await artifact(root, task.plan.id, entry.artifact);
        if (digest(bytes) !== entry.sha256) result = 'corrupt';
        else if (criterion.method !== 'automated') {
          try {
            if (
              (await manualEvidenceResult(
                root,
                bytes.toString('utf8'),
                task.plan,
                current,
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
    task.delivery?.version === 2 &&
    !errors.length &&
    !normsErrors.length &&
    evidence.every((entry) => entry.result === 'pass') &&
    task.stage === 'C1_EVIDENCE_PENDING' &&
    task.reviewDecision === 'PENDING'
  ) {
    try {
      await readDraft(root, task, current.candidate);
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
  return {
    ready: errors.length === 0,
    stage: task.stage,
    candidate: current.candidate,
    changed,
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
}

export function addEvidence(task: Task, entry: Evidence, nextAction?: string) {
  if (!task.checkpoint || entry.candidate !== task.checkpoint.candidate)
    throw new Error('WORK_EVIDENCE: checkpoint mismatch');
  task.evidence.push(entry);
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

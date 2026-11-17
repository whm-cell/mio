import { beneath } from '../inventory.ts';
import {
  documentCatalog,
  publicDocument,
  resolveDocument,
  resolvePrd,
  resultDocument,
  taskNavigation,
} from '../task-documents.ts';
import { candidateRef, contractPlan, identifier, json, sameCandidate } from './records.ts';
import type { Checkpoint, Task, TaskPlan } from './records.ts';
import { record, textField } from './report-format.ts';

export const normsCriterion = {
  id: 'norms-review',
  method: 'review',
  criterion:
    '交回前对账需求与方案、现行规范、已接受成果；审阅当前候选页面、完成范围和剩余决定，保留接受事实与未采用状态。',
};

export function registerNormsReview(plan: TaskPlan) {
  const existing = plan.acceptance.find((item) => item.id === normsCriterion.id);
  if (existing && existing.method !== 'review')
    throw new Error('WORK_NORMS_CONTRACT: norms-review must use method review');
  if ((plan.result || plan.norms) && !existing)
    plan.acceptance = [...plan.acceptance, { ...normsCriterion }];
}

/** A missing declaration is a delivery gate, not an implicit migration of old records. */
export async function normsIssues(
  root: string,
  plan: TaskPlan,
  required = false,
): Promise<string[]> {
  if (!plan.result && !plan.norms && !required) return [];
  const errors: string[] = [];
  if (!plan.norms)
    errors.push('WORK_NORMS_CONTRACT: use work update to declare plan.norms.paths and reason');
  if (!plan.acceptance.some((item) => item.id === normsCriterion.id && item.method === 'review'))
    errors.push('WORK_NORMS_CONTRACT: register norms-review with method review using work update');
  const catalog = await documentCatalog(root);
  const aliases = new Set(catalog.documents.flatMap((item) => item.aliases ?? []));
  for (const path of plan.norms?.paths ?? [])
    if (
      !publicDocument(path, catalog.config) ||
      (!beneath(path, 'docs') && !['README.md', 'AGENTS.md'].includes(path)) ||
      beneath(path, 'docs/tasks') ||
      aliases.has(path) ||
      catalog.documents.some((item) => item.path === path || item.identity === path)
    )
      errors.push(`WORK_NORMS_PATH: use a current normative document: ${path}`);
  return errors;
}

function result(value: unknown): 'pass' | 'fail' | 'pending' {
  if (typeof value !== 'string' || !['pass', 'fail', 'pending'].includes(value))
    throw new Error('WORK_NORMS_EVIDENCE: explicit pass/fail/pending observation required');
  return value as 'pass' | 'fail' | 'pending';
}

function pages(value: unknown, paths: string[], outcomes?: string[]) {
  if (!Array.isArray(value) || value.length !== paths.length)
    throw new Error('WORK_NORMS_EVIDENCE: observations for every declared page required');
  const expected = new Set(paths);
  for (const entry of value) {
    const observation = record(entry);
    const path = textField(observation.path);
    if (!expected.delete(path)) throw new Error('WORK_NORMS_EVIDENCE: page path mismatch');
    textField(observation.assessment);
    if (outcomes) outcomes.push(result(observation.result));
  }
}

function requirementPages(plan: TaskPlan, catalog: Awaited<ReturnType<typeof documentCatalog>>) {
  return [
    ...new Set(
      [
        ...(plan.requirement ? [plan.requirement.source] : []),
        ...(plan.result ? [plan.result.prd] : []),
        ...plan.sources.filter((path) => {
          const source = resolveDocument(path, catalog);
          return (
            source.kind !== undefined ||
            (catalog.documents.length === 0 &&
              !plan.norms!.paths.includes(path) &&
              path !== 'docs/index.md' &&
              !taskNavigation(path) &&
              !resultDocument(path))
          );
        }),
      ].map((path) => resolveDocument(path, catalog).currentPath),
    ),
  ];
}

/** A read-only starting point; empty observations cannot be registered as a completed review. */
export async function normsDraft(root: string, task: Task, current: Checkpoint) {
  const plan = task.plan;
  const catalog = await documentCatalog(root);
  const sourcePages = requirementPages(plan, catalog);
  const report = {
    version: 2,
    candidate: current.candidate,
    contract: contractPlan(task),
    reviewer: '',
    reason: plan.norms!.reason,
    requirements: {
      result: 'pending',
      assessment: '',
      documents: sourcePages.map((path) => ({ path, assessment: '' })),
    },
    documents: plan.norms!.paths.map((path) => ({
      path,
      result: 'pending',
      assessment: '',
    })),
    accepted: { result: 'pending', assessment: '', results: [] },
    remaining: '',
    conclusion: { result: 'pending', evidence: '' },
    limitations: '',
  };
  return `# Norms review: incomplete draft\n\nFill in actual observations before registration.\n\n\`\`\`mio-norms-review\n${json(report)}\`\`\`\n`;
}

/** The operator supplies real observations; the CLI checks binding and shape, never accepted-state truth. */
export async function normsReviewResult(
  root: string,
  report: Record<string, unknown>,
  plan: TaskPlan,
  current: Checkpoint,
) {
  if (
    !sameCandidate(candidateRef(report.candidate), current.candidate) ||
    !plan.norms ||
    report.reason !== plan.norms.reason
  )
    throw new Error('WORK_NORMS_EVIDENCE: candidate or declaration mismatch');
  textField(report.reviewer);
  textField(report.limitations);
  const outcomes: string[] = [];
  pages(report.documents, plan.norms.paths, outcomes);
  const conclusion = record(report.conclusion);
  const overall = result(conclusion.result);
  textField(conclusion.evidence);
  const catalog = await documentCatalog(root);
  const requirements = record(report.requirements);
  textField(requirements.assessment);
  outcomes.push(result(requirements.result));
  pages(requirements.documents, requirementPages(plan, catalog));
  const accepted = record(report.accepted);
  textField(accepted.assessment);
  outcomes.push(result(accepted.result));
  if (!Array.isArray(accepted.results))
    throw new Error(
      'WORK_NORMS_EVIDENCE: reviewed accepted results or an explicit empty set required',
    );
  for (const value of accepted.results) {
    const observed = record(value);
    resolvePrd(textField(observed.prd), catalog);
    identifier(textField(observed.key));
    candidateRef(observed.candidate);
    textField(observed.assessment);
  }
  textField(report.remaining);
  const derived = outcomes.includes('fail')
    ? 'fail'
    : outcomes.includes('pending')
      ? 'pending'
      : 'pass';
  if (overall !== derived)
    throw new Error('WORK_NORMS_EVIDENCE: conclusion disagrees with reconciliation observations');
  return overall;
}

import { beneath } from '../inventory.ts';
import type { HarnessConfig } from '../inventory.ts';
import { candidateRef, contractPlan, json, sameCandidate } from './records.ts';
import type { Candidate, Task, TaskPlan } from './records.ts';
import { record, textField } from './report-format.ts';

export const qualityCriterion = {
  id: 'quality-review',
  method: 'review',
  criterion:
    '审阅算法成本、提取后未使用的公共函数/方法及未复用的已有实现；保留身份、顺序、错误与副作用语义，记录证据、反证和限制。',
};

/** Scope is conservative: it also covers planned additions and deletion of the last source file. */
export function needsQualityReview(plan: TaskPlan, config: HarnessConfig): boolean {
  return plan.scope.some(
    (path) =>
      path === '.' ||
      path.endsWith('.ts') ||
      Object.keys(config.sourceRoots).some((base) => beneath(path, base) || beneath(base, path)),
  );
}

export function registerQualityReview(plan: TaskPlan, config: HarnessConfig): void {
  const existing = plan.acceptance.find((item) => item.id === qualityCriterion.id);
  if (existing && existing.method !== qualityCriterion.method)
    throw new Error('WORK_QUALITY_CONTRACT: quality-review must use method review');
  if (!existing && needsQualityReview(plan, config))
    plan.acceptance = [...plan.acceptance, { ...qualityCriterion }];
}

export function qualityDraft(task: Task, candidate: Candidate) {
  const report = {
    candidate,
    contract: contractPlan(task),
    reviewer: '',
    scope: [],
    dimensions: Object.fromEntries(
      ['algorithm', 'unused', 'reuse'].map((name) => [name, { result: 'pending', evidence: '' }]),
    ),
    limitations: '',
  };
  return `# Quality review: incomplete draft\n\nFill in actual observations before registration.\n\n\`\`\`mio-quality-review\n${json(report)}\`\`\`\n`;
}

/** Validate a reviewer's original, not the truth or independence of their observations. */
export function qualityReviewResult(
  report: Record<string, unknown>,
  candidate: Candidate,
): 'pass' | 'fail' | 'pending' {
  if (!sameCandidate(candidateRef(report.candidate), candidate))
    throw new Error('WORK_QUALITY_EVIDENCE: review candidate mismatch');
  textField(report.reviewer);
  textField(report.limitations);
  if (!Array.isArray(report.scope) || !report.scope.length)
    throw new Error('WORK_QUALITY_EVIDENCE: inspected scope required');
  report.scope.forEach(textField);
  const dimensions = record(report.dimensions);
  const results = ['algorithm', 'unused', 'reuse'].map((name) => {
    const dimension = record(dimensions[name]);
    if (
      typeof dimension.result !== 'string' ||
      !['pass', 'fail', 'pending', 'not_applicable'].includes(dimension.result)
    )
      throw new Error(`WORK_QUALITY_EVIDENCE: invalid ${name} result`);
    textField(dimension.evidence);
    return dimension.result;
  });
  return results.includes('fail') ? 'fail' : results.includes('pending') ? 'pending' : 'pass';
}

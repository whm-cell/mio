import { assess, requireCandidate } from './context.ts';
import { contractPlan, json, loadTask, taskRevision } from './records.ts';
import type { Evidence, Task } from './records.ts';
import {
  defaultTextLimit,
  finiteOutput,
  hasReadReference,
  maxTextLimit,
  readPage,
  textSlice,
} from './output.ts';
import { originalChunks, originalDigest, withArtifact } from './original.ts';
import type { ReadOptions } from './output.ts';
import { normsDraft, normsIssues } from './norms-review.ts';
import { qualityDraft } from './quality-review.ts';

async function currentAssessment(root: string, task: Task) {
  try {
    return assessmentSource(await assess(root, task), task.reviewDecision);
  } catch (error) {
    return assessmentSource(
      { ready: false, errors: [error instanceof Error ? error.message : String(error)] },
      task.reviewDecision,
    );
  }
}

function assessmentSource(assessment: Record<string, unknown>, reviewDecision: unknown) {
  const norms = assessment.normsReview as { issues?: unknown[] } | undefined;
  return {
    ...assessment,
    checkedReady: assessment.ready === true,
    ready:
      assessment.ready === true && reviewDecision !== 'REQUEST_CHANGES' && !norms?.issues?.length,
  };
}

/** Reading omissions describe the view, independently of the actual assessment. */
export function inspectionOutput(result: Record<string, unknown>) {
  const task = result.task as Record<string, unknown>;
  const assessment = result.assessment as Record<string, unknown>;
  const id = String(task.id);
  const taskView = finiteOutput(task, (pointer) => {
    const [field, ...rest] = pointer.slice(1).split('/');
    const meta = ['id', 'stage', 'reviewDecision', 'releaseDisposition', 'archived', 'delivery'];
    const selected =
      field === 'id'
        ? '/plan/id'
        : meta.includes(field ?? '')
          ? `/${field}`
          : field
            ? `/plan/${field}`
            : '';
    return {
      argv: ['read', id, 'task', '--select', selected + (rest.length ? `/${rest.join('/')}` : '')],
    };
  });
  const readableAssessment = assessmentSource(assessment, task.reviewDecision);
  const assessmentView = finiteOutput(readableAssessment, (pointer) => ({
    argv: ['read', id, 'check', '--select', pointer],
  }));
  const critical = ['authorization', 'scope', 'nonGoals', 'decisions', 'blockers', 'dependencies'];
  const omitted = critical.filter((field) => {
    if (!taskView || typeof taskView !== 'object' || Object.hasOwn(taskView, '$read')) return true;
    return hasReadReference((taskView as Record<string, unknown>)[field]);
  });
  const array = (key: string) =>
    Array.isArray(assessment[key]) ? (assessment[key] as unknown[]) : [];
  const errors = array('errors').length;
  const norms = assessment.normsReview as { issues?: unknown[] } | undefined;
  const evidence = array('evidence') as { result: string }[];
  const blocking = {
    errors,
    normsIssues: norms?.issues?.length ?? 0,
    openDecisions:
      (task.decisions as { status: string }[] | undefined)?.filter((item) => item.status === 'OPEN')
        .length ?? 0,
    blockers: (task.blockers as unknown[] | undefined)?.length ?? 0,
    dependencies:
      (task.dependencies as { ready: boolean }[] | undefined)?.filter((item) => !item.ready)
        .length ?? 0,
    requestChanges: task.reviewDecision === 'REQUEST_CHANGES',
  };
  const ready = assessment.ready === true && !Object.values(blocking).some(Boolean);
  return {
    ...result,
    task: {
      ...(taskView as Record<string, unknown>),
      // Keep the declaration visible even when the rest of the task folds to a root read.
      result: finiteOutput(task.result ?? null, (pointer) => ({
        argv: ['read', id, 'task', '--select', `/plan/result${pointer}`],
      })),
    },
    assessment: {
      ...(assessmentView && typeof assessmentView === 'object' ? assessmentView : {}),
      ready,
      checkedReady: assessment.ready === true,
      ...(Object.hasOwn(assessment, 'readyForAcceptance')
        ? {
            checkedReadyForAcceptance: assessment.readyForAcceptance === true,
            readyForAcceptance: assessment.readyForAcceptance === true && ready,
          }
        : {}),
      checked: true,
      blocking,
      reading: { omitted },
      evidenceCounts: Object.fromEntries(
        ['pass', 'fail', 'pending', 'missing', 'corrupt', 'invalid'].map((key) => [
          key,
          evidence.filter((item) => item.result === key).length,
        ]),
      ),
    },
  };
}

export function assessmentOutput(task: Task, assessment: Record<string, unknown>) {
  const result = inspectionOutput({
    revision: taskRevision(task),
    task: {
      id: task.plan.id,
      result: task.plan.result ?? null,
      authorization: task.plan.authorization,
      scope: task.plan.scope,
      nonGoals: task.plan.nonGoals,
      decisions: task.plan.decisions,
      blockers: task.plan.blockers,
      dependencies: task.plan.dependencies,
      reviewDecision: task.reviewDecision,
    },
    assessment,
  });
  return { ...result.assessment, requiredContext: result.task };
}

async function readEvidenceOriginal(
  root: string,
  id: string,
  evidence: Evidence,
  options: ReadOptions,
) {
  return withArtifact(root, id, evidence.artifact, async (file, { size }) => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const textWindow = options.select === '/text' ? { text: '', total: 0 } : undefined;
    let remaining = Math.min(options.limit ?? defaultTextLimit, maxTextLimit);
    const decode = (bytes?: Buffer) => {
      let part: string;
      try {
        part = bytes ? decoder.decode(bytes, { stream: true }) : decoder.decode();
      } catch {
        throw new Error('WORK_READ_ENCODING: bound evidence is not UTF-8 text');
      }
      if (!textWindow) return;
      const offset = Math.max(0, options.offset - textWindow.total);
      const slice = textSlice(part, offset, remaining);
      remaining -= Math.min(remaining, Math.max(0, slice.total - offset));
      textWindow.total += slice.total;
      textWindow.text += slice.text;
    };
    const actualSha256 =
      evidence.sha256 === undefined ? null : await originalDigest(file, size, decode);
    if (actualSha256 === null) {
      for await (const bytes of originalChunks(file, 0, size)) decode(bytes);
    }
    decode();
    return { textWindow, actualSha256 };
  });
}

/** The source is this task's validated state or a ledger-bound evidence entry, never an arbitrary path. */
export async function readTask(
  root: string,
  id: string,
  kind: string,
  options: ReadOptions,
  entry?: string,
) {
  const { task } = await loadTask(root, id);
  const command = ['read', id, kind];
  if (kind === 'task') return readPage(task, options, command);
  if (kind === 'check') {
    const assessment = await currentAssessment(root, task);
    return readPage(assessment, options, command);
  }
  if (kind === 'norms-draft') {
    const assessment = await assess(root, task);
    const issues = await normsIssues(root, task.plan, true);
    if (!assessment.ready || issues.length || !task.checkpoint)
      throw new Error(
        [...assessment.errors, ...issues].join('\n') ||
          'WORK_NORMS_CONTRACT: reconcile the current task',
      );
    const candidate = await requireCandidate(root, task);
    return readPage(await normsDraft(root, task, { candidate }), options, command);
  }
  if (kind === 'quality-draft')
    return readPage(qualityDraft(task, await requireCandidate(root, task)), options, command);
  if (kind === 'evidence-draft') {
    const criterion = task.plan.acceptance.find((item) => item.id === entry);
    if (!criterion) throw new Error('WORK_CRITERION: select an acceptance id from this task');
    if (['quality-review', 'norms-review'].includes(criterion.id))
      throw new Error('WORK_READ: use quality-draft or norms-draft for this review');
    const candidate = await requireCandidate(root, task);
    const common = {
      candidate,
      contract: contractPlan(task),
      criterion: criterion.id,
      result: 'pending',
    };
    const coverage = criterion.method === 'automated';
    const body = coverage
      ? {
          ...common,
          mode: 'manual',
          executionCount: 0,
          reviewer: '',
          source: '',
          scope: '',
          environment: '',
          uncovered: '',
          assessment: '',
        }
      : { ...common, observation: '' };
    const language = coverage ? 'mio-coverage' : 'mio-evidence';
    command.push(criterion.id);
    return readPage(
      `# Evidence: incomplete draft\n\nFill in actual observations before registration.\n\n\`\`\`${language}\n${json(body)}\`\`\`\n`,
      options,
      command,
    );
  }
  if (kind !== 'evidence' || !entry || !/^(?:0|[1-9]\d{0,8})$/.test(entry))
    throw new Error(
      'WORK_READ: choose task/check/norms-draft/quality-draft/evidence-draft, or evidence with its ledger index',
    );
  const evidence = task.evidence[Number(entry)];
  if (!evidence) throw new Error('WORK_READ_EVIDENCE: ledger entry does not exist');
  command.push(entry);
  // The default expands only this original's text. Metadata can be selected independently.
  const chosen = { ...options, select: options.select || '/text' };
  const { textWindow, actualSha256 } = await readEvidenceOriginal(
    root,
    task.plan.id,
    evidence,
    chosen,
  );
  const source = {
    entry: evidence,
    integrity:
      actualSha256 === null
        ? 'pending'
        : actualSha256 === evidence.sha256
          ? 'verified'
          : 'mismatch',
    actualSha256,
    text: '',
  };
  return {
    integrity: source.integrity,
    ...(evidence.sha256 === undefined ? {} : { expectedSha256: evidence.sha256 }),
    actualSha256,
    ...readPage(source, chosen, command, textWindow),
  };
}

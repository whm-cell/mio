import { format } from 'prettier';
import { assess } from './context.ts';
import { digest, json, loadTask } from './records.ts';
import type { Task } from './records.ts';
import { commitDelivery, replayDelivery, requestDigest } from './delivery-store.ts';
import { normsIssues } from './norms-review.ts';
import { documentCatalog, resolvePrd } from '../task-documents.ts';
import {
  bookPaths,
  matchingEvidence,
  readBook,
  readDraft,
  renderBook,
  renderDraft,
  validateLocations,
} from './reports.ts';
import type { ResultDraft } from './reports.ts';
import { parseAcceptance, parseDetails, parseRecords } from './compact-store.ts';
import { fields, publicText, record } from './report-format.ts';

export const markdown = (text: string) => format(text, { parser: 'markdown', printWidth: 100 });

async function verified(root: string, task: Task, candidate?: string) {
  if (
    task.plan.result &&
    resolvePrd(task.plan.result.prd, await documentCatalog(root)) !== task.plan.result.prd
  )
    throw new Error('WORK_RESULT: reconcile result.prd to its stable identity using work update');
  const assessment = await assess(root, task, { inspectDelivery: false });
  if (!assessment.ready) throw new Error(assessment.errors.join('\n'));
  const normsErrors = await normsIssues(root, task.plan, true);
  if (normsErrors.length) throw new Error(normsErrors.join('\n'));
  if (candidate !== undefined && assessment.candidate !== candidate)
    throw new Error('WORK_DELIVERY_STALE: candidate changed');
  if (assessment.evidence.some((entry) => entry.result !== 'pass'))
    throw new Error('WORK_DELIVERY_EVIDENCE: all criteria need matching passing originals');
}

export async function deliver(root: string, id: string, rawRequest: string) {
  const { task, raw } = await loadTask(root, id);
  if (!task.plan.result)
    throw new Error(
      'WORK_DELIVERY_RESULT: no development result is declared; public complete requires a PRD result',
    );
  if (task.delivery?.version !== 2)
    throw new Error('WORK_DELIVERY_OBSOLETE: reconcile plan.result using update before preparing');
  const request = record(JSON.parse(rawRequest));
  fields(request, [
    'action',
    'revision',
    'title',
    'locations',
    'outcomes',
    'verification',
    'limitations',
    'draftSha256',
    'acceptance',
  ]);
  if (!['prepare', 'complete'].includes(String(request.action)))
    throw new Error('WORK_DELIVERY_REQUEST: action prepare or complete');
  const token = requestDigest(request);
  if (
    await replayDelivery(
      root,
      id,
      token,
      async (restored) => {
        await verified(root, restored, restored.checkpoint!.candidate);
      },
      request.action === 'prepare',
    )
  ) {
    const restored = (await loadTask(root, id)).task;
    return request.action === 'complete'
      ? { completed: true, replayed: true, report: restored.delivery!.accepted }
      : {
          replayed: true,
          readyForAcceptance: (await assess(root, restored)).readyForAcceptance,
          revision: digest(json(restored)),
          draft: restored.delivery!.draft,
        };
  }
  if (request.revision !== digest(raw)) throw new Error('WORK_CONFLICT: read current revision');
  if (task.archived) throw new Error('WORK_ARCHIVED: reopen before delivery');
  return request.action === 'prepare'
    ? prepare(root, task, raw, request, token)
    : complete(root, task, raw, request, token);
}

async function prepare(
  root: string,
  task: Task,
  raw: string,
  request: Record<string, unknown>,
  token: string,
) {
  await verified(root, task);
  const catalog = await documentCatalog(root);
  const result = parseDetails({
    key: task.plan.result!.key,
    title: request.title,
    locations: request.locations,
    outcomes: request.outcomes,
    verification: request.verification,
    limitations: request.limitations,
  });
  await validateLocations(root, result, catalog);
  const candidate = task.checkpoint!.candidate;
  const draft: ResultDraft = {
    version: 5,
    prd: task.plan.result!.prd,
    candidate,
    result,
    evidence: await matchingEvidence(root, task, candidate),
  };
  const source = await markdown(renderDraft(draft));
  const path = `.work/tasks/${task.plan.id}/delivery/draft.md`;
  task.delivery!.draft = { path, sha256: digest(source), candidate };
  task.reviewDecision = 'PENDING';
  task.stage = 'C1_EVIDENCE_PENDING';
  task.releaseDisposition = 'HOLD_FOR_HUMAN_REVIEW';
  task.plan.nextAction =
    'Return the current private draft for actual acceptance of this candidate.';
  task.notes.push(`Prepared private v5 draft ${digest(source)}; acceptance remains pending.`);
  await commitDelivery(root, task, raw, token, 'prepare', { [path]: source }, {});
  return { revision: digest(json(task)), draft: task.delivery!.draft, readyForAcceptance: true };
}

async function complete(
  root: string,
  task: Task,
  raw: string,
  request: Record<string, unknown>,
  token: string,
) {
  const ref = task.delivery!.draft;
  if (!ref || request.draftSha256 !== ref.sha256)
    throw new Error('WORK_DELIVERY_STALE: prepare and review the current draft');
  await verified(root, task, ref.candidate);
  const draft = await readDraft(root, task, ref.candidate);
  const acceptance = parseAcceptance(request.acceptance);
  if (acceptance.candidate !== draft.candidate)
    throw new Error('WORK_DELIVERY_ACCEPTANCE: candidate mismatch');
  const catalog = await documentCatalog(root);
  await validateLocations(root, draft.result, catalog);
  const paths = bookPaths(draft.prd, catalog);
  const { book, source: reportBefore, recordsSource } = await readBook(root, draft.prd, catalog);
  const result = { ...draft.result, acceptance };
  book.results = book.results
    .filter((entry) => entry.key !== result.key)
    .concat(result)
    .sort((a, b) => a.key.localeCompare(b.key));
  const bytes = publicText(await format(json(book), { parser: 'json', printWidth: 100 }));
  parseRecords(bytes);
  const source = publicText(await markdown(renderBook(book, paths.currentPath, bytes)));
  const outputs = {
    [paths.records]: bytes,
    [paths.report]: source,
  };
  const expected = {
    [paths.records]: recordsSource,
    [paths.report]: reportBefore,
  };
  const accepted = {
    path: paths.report,
    key: result.key,
    sha256: digest(json(result)),
    candidate: draft.candidate,
  };
  task.delivery!.accepted = accepted;
  task.stage = 'C1_RELEASED';
  task.reviewDecision = 'ACCEPT';
  task.releaseDisposition = 'RELEASED';
  task.plan.sharedRef = `${paths.report}#${result.key}`;
  task.plan.nextAction =
    'Read back the accepted result and finish this task; a new objective needs its own authorization.';
  task.notes.push(`Accepted ${accepted.candidate}; ${acceptance.reference}`);
  await commitDelivery(root, task, raw, token, 'complete', outputs, expected);
  return {
    completed: true,
    revision: digest(json(task)),
    report: accepted,
    files: Object.keys(outputs),
  };
}

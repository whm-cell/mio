import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { format } from 'prettier';
import { assess, requireCandidate } from './context.ts';
import {
  contractRevision,
  json,
  loadTask,
  sameCandidate,
  saveTask,
  taskRevision,
} from './records.ts';
import type { Candidate, ResultDraft, Task } from './records.ts';
import { replacePublication, withPublication } from './delivery-store.ts';
import { normsIssues } from './norms-review.ts';
import { documentCatalog, resolvePrd } from '../task-documents.ts';
import {
  bookPaths,
  matchingEvidence,
  readBook,
  readDraft,
  renderBook,
  validateLocations,
} from './reports.ts';
import { parseAcceptance, parseDetails, parseRecords } from './compact-store.ts';
import { fields, publicText, record, textField } from './report-format.ts';

const markdown = (text: string) => format(text, { parser: 'markdown', printWidth: 100 });

function committedReport(root: string, candidate: Candidate, path: string): string | null {
  const commit = spawnSync('git', ['cat-file', '-t', candidate.commit], {
    cwd: root,
    encoding: 'utf8',
  });
  if (commit.status !== 0 || commit.stdout.trim() !== 'commit')
    throw new Error('WORK_DELIVERY_STALE: candidate commit is unavailable');
  const entry = spawnSync('git', ['ls-tree', '--name-only', '-z', candidate.commit, '--', path], {
    cwd: root,
    encoding: 'utf8',
  });
  if (entry.status !== 0) throw new Error('WORK_GIT: cannot inspect candidate report');
  if (!entry.stdout) return null;
  const report = spawnSync('git', ['show', `${candidate.commit}:${path}`], {
    cwd: root,
    encoding: 'utf8',
  });
  if (report.status !== 0) throw new Error('WORK_GIT: cannot read candidate report');
  return report.stdout;
}

async function verified(root: string, task: Task, expected?: Candidate) {
  if (
    task.plan.result &&
    resolvePrd(task.plan.result.prd, await documentCatalog(root)) !== task.plan.result.prd
  )
    throw new Error('WORK_RESULT: reconcile result.prd to its stable identity using work update');
  const candidate = await requireCandidate(root, task);
  if (expected && !sameCandidate(expected, candidate))
    throw new Error('WORK_DELIVERY_STALE: candidate changed');
  const assessment = await assess(root, task, { inspectDelivery: false });
  if (!assessment.ready) throw new Error(assessment.errors.join('\n'));
  const normsErrors = await normsIssues(root, task.plan, true);
  if (normsErrors.length) throw new Error(normsErrors.join('\n'));
  if (assessment.evidence.some((entry) => entry.result !== 'pass'))
    throw new Error('WORK_DELIVERY_EVIDENCE: all criteria need matching passing originals');
  return candidate;
}

export async function deliver(root: string, id: string, rawRequest: string) {
  const { task, raw } = await loadTask(root, id);
  if (!task.plan.result || !task.delivery)
    throw new Error('WORK_DELIVERY_RESULT: declare a development result before delivery');
  const request = record(JSON.parse(rawRequest));
  if (!Number.isSafeInteger(request.revision) || (request.revision as number) < 0)
    throw new Error('WORK_REQUEST: revision must be a nonnegative integer');
  if (request.action === 'prepare') {
    fields(request, [
      'action',
      'revision',
      'title',
      'locations',
      'outcomes',
      'verification',
      'limitations',
    ]);
    if (request.revision !== taskRevision(task))
      throw new Error('WORK_CONFLICT: read current revision');
    return prepare(root, task, raw, request);
  }
  if (request.action === 'complete') {
    fields(request, ['action', 'revision', 'draftId', 'acceptance']);
    return complete(root, task, raw, request);
  }
  throw new Error('WORK_DELIVERY_REQUEST: action prepare or complete');
}

async function prepare(root: string, task: Task, raw: string, request: Record<string, unknown>) {
  if (task.archived) throw new Error('WORK_ARCHIVED: reopen before delivery');
  if (task.stage !== 'C1_EVIDENCE_PENDING' || task.reviewDecision !== 'PENDING')
    throw new Error('WORK_DELIVERY_STAGE: verify before preparing for human acceptance');
  const candidate = await verified(root, task);
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
  for (const { path } of result.locations) {
    const check = spawnSync('git', ['cat-file', '-e', `${candidate.commit}:${path}`], {
      cwd: root,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    if (check.status !== 0)
      throw new Error(`WORK_REPORT_LOCATION: location is absent from the candidate: ${path}`);
  }
  const draft: ResultDraft = {
    id: randomUUID(),
    prd: task.plan.result!.prd,
    candidate,
    result,
    evidence: await matchingEvidence(root, task, candidate),
  };
  task.delivery!.draft = draft;
  task.reviewDecision = 'PENDING';
  task.releaseDisposition = 'HOLD_FOR_HUMAN_REVIEW';
  task.plan.nextAction = 'Return the current draft for actual acceptance of this candidate.';
  task.notes.push(`Prepared draft ${draft.id}; acceptance remains pending.`);
  await saveTask(root, task, raw);
  return { revision: taskRevision(task), draftId: draft.id, draft, readyForAcceptance: true };
}

async function complete(root: string, task: Task, raw: string, request: Record<string, unknown>) {
  const ref = task.delivery!.draft;
  if (!ref || !('id' in ref) || textField(request.draftId) !== ref.id)
    throw new Error('WORK_DELIVERY_STALE: prepare and review the current draft');
  const acceptance = parseAcceptance(request.acceptance);
  if (
    typeof acceptance.candidate === 'string' ||
    !sameCandidate(acceptance.candidate, ref.candidate)
  )
    throw new Error('WORK_DELIVERY_ACCEPTANCE: candidate mismatch');
  if (
    contractRevision(task) !== ref.candidate.contractRevision ||
    !sameCandidate(task.checkpoint?.candidate, ref.candidate)
  )
    throw new Error('WORK_DELIVERY_STALE: the frozen draft no longer matches the task contract');
  const catalog = await documentCatalog(root);
  const paths = bookPaths(ref.prd, catalog);
  if (
    paths.identity !== ref.prd ||
    task.plan.result!.prd !== ref.prd ||
    task.plan.result!.key !== ref.result.key
  )
    throw new Error('WORK_DELIVERY_STALE: result ownership changed');
  const result = { ...parseDetails(ref.result), acceptance };
  const accepted = { path: paths.records, key: result.key, candidate: ref.candidate };
  const alreadyReleased =
    task.stage === 'C1_RELEASED' &&
    task.reviewDecision === 'ACCEPT' &&
    task.releaseDisposition === 'RELEASED' &&
    task.delivery!.accepted?.path === accepted.path &&
    task.delivery!.accepted?.key === accepted.key &&
    sameCandidate(task.delivery!.accepted?.candidate, accepted.candidate);
  if (!alreadyReleased && request.revision !== taskRevision(task))
    throw new Error('WORK_CONFLICT: read current revision');
  if (
    !alreadyReleased &&
    (task.archived || task.stage !== 'C1_EVIDENCE_PENDING' || task.reviewDecision !== 'PENDING')
  )
    throw new Error('WORK_DELIVERY_STAGE: verify before recording human acceptance');

  // Expensive assessment happens before the short PRD publication lock.
  const beforeLock = (await readBook(root, ref.prd, catalog)).book;
  const wasPublished = isDeepStrictEqual(
    beforeLock.results.find((entry) => entry.key === result.key),
    result,
  );
  if (!wasPublished) {
    if (alreadyReleased) throw new Error('WORK_DELIVERY_CONFLICT: accepted result changed');
    await verified(root, task, ref.candidate);
    await validateLocations(root, ref.result, catalog);
  }

  // A matching published result is the recovery proof even if the two outputs now make
  // the checkout dirty. New publication still requires a clean candidate.
  return withPublication(root, paths.records, async () => {
    const {
      book,
      source: reportBefore,
      recordsSource,
      reportError,
    } = await readBook(root, ref.prd, catalog);
    if (reportError !== null)
      throw new Error(`WORK_DELIVERY_CONFLICT: ${paths.report}: ${reportError}`);
    const existing = book.results.find((entry) => entry.key === result.key);
    const replayed = isDeepStrictEqual(existing, result);
    await readDraft(root, task, ref.candidate);
    if (!replayed) {
      if (alreadyReleased || wasPublished)
        throw new Error('WORK_DELIVERY_CONFLICT: accepted result changed');
      book.results = book.results
        .filter((entry) => entry.key !== result.key)
        .concat(result)
        .sort((a, b) => a.key.localeCompare(b.key));
    }
    const source = publicText(await markdown(renderBook(book, paths.currentPath)));
    const candidateReport = committedReport(root, ref.candidate, paths.report);
    if (reportBefore !== null && reportBefore !== candidateReport && reportBefore !== source)
      throw new Error(`WORK_DELIVERY_CONFLICT: ${paths.report}`);
    if (!replayed) {
      const bytes = publicText(await format(json(book), { parser: 'json', printWidth: 100 }));
      parseRecords(bytes);
      await requireCandidate(root, task);
      // The records rename is the publication point. Everything after it is recoverable.
      await replacePublication(root, paths.records, recordsSource, bytes);
    }
    await replacePublication(root, paths.report, reportBefore, source);
    if (!alreadyReleased) {
      task.delivery!.accepted = accepted;
      task.stage = 'C1_RELEASED';
      task.reviewDecision = 'ACCEPT';
      task.releaseDisposition = 'RELEASED';
      task.plan.sharedRef = `${paths.report}#${result.key}`;
      task.plan.nextAction = 'Read back the accepted result and finish this task.';
      task.notes.push(`Accepted ${ref.candidate.commit}; ${acceptance.reference}`);
      await saveTask(root, task, raw);
    }
    return {
      completed: true,
      replayed,
      revision: taskRevision(task),
      report: accepted,
      files: [paths.records, paths.report],
    };
  });
}

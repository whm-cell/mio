import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assess, capture, contractIssues } from './context.ts';
import { checkedPath, digest, json, member, parseTask, saveTask } from './records.ts';
import type { Task } from './records.ts';
import { bookPaths, readBook } from './reports.ts';
import { draft } from './records.ts';
import { documentCatalog, resolveDocument, resultDocument } from '../task-documents.ts';
import { withTaskCommand } from './command.ts';

/** A portable proposal plus candidate manifest; local authority and evidence never transfer implicitly. */
export async function handoff(root: string, task: Task) {
  const current = await capture(root, task);
  if (
    !task.checkpoint ||
    task.checkpoint.candidate !== current.candidate ||
    task.checkpoint.head !== current.head ||
    task.checkpoint.branch !== current.branch
  )
    throw new Error('WORK_HANDOFF_STALE: reconcile before preparing a handoff');
  const incomplete = contractIssues(task).filter((error) => error.startsWith('WORK_CONTRACT'));
  if (incomplete.length) throw new Error(incomplete.join('\n'));
  const plan = task.plan;
  const assessment = await assess(root, task);
  const portable: Task = {
    version: 1,
    member: task.member,
    workspace: '',
    stage: null,
    reviewDecision: 'PENDING',
    releaseDisposition: 'HOLD_FOR_EVIDENCE',
    evidence: [],
    archived: false,
    ...(task.delivery ? { delivery: { version: task.delivery.version } } : {}),
    checkpoint: task.checkpoint,
    plan: {
      id: plan.id,
      ...(plan.requirement ? { requirement: plan.requirement } : {}),
      ...(plan.result !== undefined ? { result: plan.result } : {}),
      ...(plan.norms ? { norms: plan.norms } : {}),
      goal: plan.goal,
      scope: plan.scope,
      inputs: plan.inputs,
      sources: plan.sources,
      authorization: '',
      nonGoals: plan.nonGoals,
      acceptance: plan.acceptance,
      decisions: plan.decisions,
      dependencies: plan.dependencies,
      blockers: plan.blockers,
      nextAction: plan.nextAction,
      stopCondition: plan.stopCondition,
      sharedRef: plan.sharedRef,
    },
    notes: assessment.evidence.map(
      (entry) =>
        `Current ${entry.criterion}: ${entry.result}; basis ${'basis' in entry ? entry.basis : entry.method}; candidate ${current.candidate}; retrieve and reverify the complete original chain; acceptance does not transfer.`,
    ),
  };
  const path = await checkedPath(
    root,
    `.work/tasks/${task.plan.id}/handoff-${digest(json(portable)).slice(0, 20)}.md`,
  );
  await mkdir(dirname(path), { recursive: true });
  // Never publish automatically. The operator reviews this file and shares the code and required artifacts separately.
  const markdown = `# Task handoff: ${task.plan.id}\n\nReported by ${task.member}. Verify the pinned code, authorization, dependencies and raw evidence before continuing. This file grants no permission and transfers no code or logs.\n\n\`\`\`mio-work-handoff\n${json(portable)}\`\`\`\n`;
  try {
    await writeFile(path, markdown, { flag: 'wx' });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
      (await readFile(path, 'utf8')) !== markdown
    )
      throw error;
  }
  return path;
}

export async function receive(root: string, source: string, key?: string) {
  if (
    !source.endsWith('.md') ||
    (!source.startsWith('.work/inbox/') && !source.startsWith('docs/'))
  )
    throw new Error(
      'WORK_HANDOFF_PATH: retrieve the shared Markdown into .work/inbox/ or a classified public document',
    );
  const catalog = await documentCatalog(root);
  if (!source.startsWith('.work/inbox/')) resolveDocument(source, catalog);
  const markdown = await readFile(await checkedPath(root, source), 'utf8');
  if (resultDocument(source) && source.endsWith('/report.md')) {
    const entry = catalog.documents.find(
      (entry) => entry.kind === 'prd' && bookPaths(entry.identity, catalog).report === source,
    );
    if (!entry) throw new Error('WORK_REPORT_BINDING: report has no registered PRD');
    const { book } = await readBook(root, entry.identity, catalog);
    if (source !== bookPaths(book.prd, catalog).report)
      throw new Error('WORK_REPORT_FORMAT: PRD/book location mismatch');
    if (resolveDocument(book.prd, catalog).identity !== book.prd)
      throw new Error('WORK_REPORT_BINDING: accepted PRD must remain a registry identity');
    const result =
      key === undefined && book.results.length === 1
        ? book.results[0]
        : book.results.find((entry) => entry.key === key);
    if (!result)
      throw new Error(
        `WORK_RESULT_SELECTION: select one result key: ${book.results.map((entry) => entry.key).join(', ')}`,
      );
    const id = `${result.key.slice(0, 48)}-${digest(json([book.prd, result.key])).slice(0, 16)}`;
    const task = draft(root, await member(root), id, result.title);
    task.plan.result = { prd: book.prd, key: result.key };
    task.plan.sources = [book.prd];
    task.plan.sharedRef = `${source}#${result.key}`;
    task.plan.nextAction =
      'Define current authorization, scope, acceptance criteria and dependencies, then sync and verify; no historical passes transfer.';
    task.delivery = {
      version: 2,
      accepted: {
        path: source,
        key: result.key,
        sha256: digest(json(result)),
        candidate: result.acceptance.candidate,
      },
    };
    task.notes.push(
      `Read accepted result ${source}#${result.key}; candidate label ${result.acceptance.candidate}. Entry points: ${result.locations.map((entry) => entry.path).join(', ')}. Public summaries cannot restore code or evidence and are not current verification.`,
    );
    await withTaskCommand(root, task.plan.id, 'receive', () => saveTask(root, task));
    return task;
  }
  const blocks = [...markdown.matchAll(/^```mio-work-handoff\r?\n([\s\S]*?)^```\s*$/gm)];
  if (blocks.length !== 1)
    throw new Error('WORK_HANDOFF_FORMAT: expected one mio-work-handoff block');
  const incoming = parseTask(blocks[0]![1]!);
  if (!incoming.checkpoint) throw new Error('WORK_HANDOFF_FORMAT: candidate manifest missing');
  const current = await capture(root, incoming);
  if (json(incoming.checkpoint.files) !== json(current.files))
    throw new Error(
      'WORK_HANDOFF_CODE: required code/documents differ; retrieve the pinned candidate first',
    );
  const task: Task = {
    ...incoming,
    member: await member(root),
    workspace: root,
    stage: null,
    reviewDecision: 'PENDING',
    releaseDisposition: 'HOLD_FOR_EVIDENCE',
    checkpoint: null,
    evidence: [],
    archived: false,
    plan: {
      ...incoming.plan,
      authorization: '',
      dependencies: incoming.plan.dependencies.map((entry) => ({ ...entry, ready: false })),
    },
    notes: [
      ...incoming.notes,
      `Received ${source} from ${incoming.member}; verified file manifest ${incoming.checkpoint.candidate}; source HEAD ${incoming.checkpoint.head ?? 'unborn'}. Reconcile local authority and retrieve required raw evidence.`,
    ],
  };
  await withTaskCommand(root, task.plan.id, 'receive', () => saveTask(root, task));
  return task;
}

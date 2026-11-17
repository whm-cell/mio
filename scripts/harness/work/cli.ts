import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  addEvidence,
  artifact,
  assess,
  capture,
  contractIssues,
  environment,
  requireCandidate,
  validateInputs,
} from './context.ts';
import { handoff, receive } from './handoff.ts';
import { guide } from './guide.ts';
import { ensureTask, inspectTask, updateTask } from './manage.ts';
import { deliver } from './delivery.ts';
import { normsCriterion, normsIssues } from './norms-review.ts';
import { checkManualOriginal, manualEvidenceResult } from './manual-evidence.ts';
import { inventory, loadConfig } from '../inventory.ts';
import { inspectTaskDocuments } from '../task-documents.ts';
import { checkDocuments } from '../check-documents.ts';
import { finiteOutput, readPage } from './output.ts';
import { readOptions } from './read-options.ts';
import { readStatus } from './read-status.ts';
import { assessmentOutput, inspectionOutput, readTask } from './read-task.ts';
import { readPublicResult } from './public-read.ts';
import { changeCommand } from './change-read.ts';
import { bookPaths, readBook } from './reports.ts';
import { runCommand, withTaskCommand } from './command.ts';
import { conditions } from './verification-environment.ts';
import { coverageEvidenceResult, resultMarker } from './evidence.ts';
import { requirementIssues } from './requirements.ts';
import type { CommandActivity } from './command.ts';
import {
  checkedPath,
  contractPlan,
  digest,
  draft,
  initializeMember,
  json,
  loadTask,
  member,
  sameCandidate,
  saveTask,
} from './records.ts';

const root = await realpath('.');
const [command, ...args] = process.argv.slice(2);
const help = `Usage: pnpm work <command>
Agent operates this CLI; the user supplies goals and decisions.
  ensure --stdin                       create/reuse a PRD subtask from structured JSON
  update <task> --stdin                 update plan/progress with an expected revision
  deliver <task> --stdin                prepare privately or record an accepted PRD result
  init <member>                         initialize this member's workspace
  start <task> <goal> [source.md ...]    legacy draft; complete via update before sync
  status [--query text] [--stage stage] [--archived active|archived|all]
                                        page records; current assessment is not checked
  documents [read options]               page task identities and validation issues
  guide <action> [--section ref]         navigate one action; expand one stable section ref
  context <task> <action>               read current task summary, checks and one action
  read <task> <task|check> [pointer]     page selected record fields or current checks
  read <task> norms-draft|quality-draft page an incomplete review draft with its candidate
  read <task> evidence-draft <criterion> page a pending manual or coverage draft
  read <task> evidence <index>          page one ledger-bound original (UTF-8 text)
  read-result <prd> [key] [read options] page a public result without personal records
  changes <prd> [key] [read options]     page change summaries or one card
  changes <prd> --write-index            regenerate that PRD's change index
  check <task>                          read-only context/evidence assessment
  sync <task> <reason>                  bind the current clean commit and contract
  run <task> <criterion> [-- <argv ...>] capture the declared check or a supplemental probe
    --stdin                            JSON command (optional) and observed conditions
  evidence <task> <criterion> <artifact> <summary>  record manual review or coverage original
  handoff <task>                        prepare a local portable Markdown handoff
  receive <shared.md> [result-key]      verify a result/handoff, create this member's draft
  archive <task> <reason>               mark history; retain all files
Actions: start, resume, implement, verify, deliver, handoff, archive
Read options: --select /JSON/pointer --offset N --limit N
Agent entry: guide start, then ensure --stdin; expand only the current action.`;

async function input() {
  if (process.stdin.isTTY) throw new Error('WORK_REQUEST: pipe a JSON request on stdin');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main(activity?: CommandActivity) {
  if (!command || command === 'help') return console.log(help);
  // Commands are a repository development tool, never a product-runtime dependency.
  await readFile(await checkedPath(root, 'harness.config.json'));
  if (command === 'guide') {
    const { positionals, options, flags } = readOptions(args, ['section']);
    if (positionals.length !== 1) throw new Error(help);
    return console.log(json(await guide(root, positionals[0]!, options, flags.section)));
  }
  if (command === 'documents') {
    const { positionals, options } = readOptions(args);
    if (positionals.length) throw new Error(help);
    const config = await loadConfig(root);
    const scan = await inventory(root, config);
    const registry = await inspectTaskDocuments(root, config);
    const checked = await checkDocuments(root, scan.files, config);
    const issues = [...new Set([...scan.errors, ...registry.errors, ...checked.errors])];
    const source = {
      documents: registry.documents.map((entry) => ({
        kind: entry.kind,
        identity: entry.identity,
        currentPath: entry.path,
        aliases: entry.aliases ?? [],
        registry: entry.registry,
      })),
      results: issues.some((issue) => !issue.startsWith('WORK_REPORT_DRIFT:'))
        ? []
        : await Promise.all(
            registry.documents
              .filter((entry) => entry.kind === 'prd')
              .map(async (entry) => {
                const catalog = {
                  config,
                  documents: registry.documents,
                  registries: registry.registries,
                };
                const paths = bookPaths(entry.identity, catalog);
                const { book, source, recordsSource } = await readBook(
                  root,
                  entry.identity,
                  catalog,
                );
                return {
                  prd: entry.identity,
                  report: source === null ? null : paths.report,
                  records: recordsSource === null ? null : paths.records,
                  keys: book.results.map((result) => result.key),
                  read: ['read-result', entry.identity],
                };
              }),
          ),
      issues,
    };
    console.log(
      json(
        options.select || options.offset || options.limit !== undefined
          ? readPage(source, options, ['documents'])
          : finiteOutput(source, (pointer) => ({
              argv: ['documents', '--select', pointer],
            })),
      ),
    );
    if (issues.length) process.exitCode = 1;
    return;
  }
  if (command === 'init') {
    if (args.length !== 1) throw new Error(help);
    const actor = await initializeMember(root, args[0]!);
    return console.log(`Initialized ${actor}; existing records and evidence retained.`);
  }
  if (command === 'ensure') {
    if (args.length !== 1 || args[0] !== '--stdin') throw new Error(help);
    return console.log(json(inspectionOutput(await ensureTask(root, await input()))));
  }
  if (command === 'update') {
    if (args.length !== 2 || args[1] !== '--stdin') throw new Error(help);
    return console.log(json(inspectionOutput(await updateTask(root, args[0]!, await input()))));
  }
  if (command === 'deliver') {
    if (args.length !== 2 || args[1] !== '--stdin') throw new Error(help);
    const result = await deliver(root, args[0]!, await input());
    return console.log(
      json(
        finiteOutput(result, () => ({
          argv: ['read', args[0]!, 'task', '--select', '/delivery'],
        })),
      ),
    );
  }
  if (command === 'status') {
    const { positionals, options, flags } = readOptions(args, ['query', 'stage', 'archived']);
    if (positionals.length) throw new Error(help);
    return console.log(json(await readStatus(root, options, flags)));
  }
  if (command === 'read') {
    const { positionals, options } = readOptions(args);
    if (positionals.length < 2 || positionals.length > 3) throw new Error(help);
    const [id, kind, selected] = positionals;
    const indexed = kind === 'evidence' || kind === 'evidence-draft';
    if (!indexed && selected !== undefined) {
      if (options.select) throw new Error('WORK_READ_SELECT: supply the pointer once');
      options.select = selected;
    }
    return console.log(
      json(await readTask(root, id!, kind!, options, indexed ? selected : undefined)),
    );
  }
  if (command === 'read-result') return console.log(json(await readPublicResult(root, args)));
  if (command === 'changes') return console.log(json(await changeCommand(root, args)));
  const actor = await member(root);
  if (command === 'start') {
    if (args.length < 2) throw new Error(help);
    const task = draft(root, actor, args[0]!, args[1]!);
    task.plan.sources.push(...args.slice(2));
    await saveTask(root, task);
    return console.log(
      `Draft: .work/tasks/${task.plan.id}/state.json; complete the contract before sync.`,
    );
  }
  if (command === 'receive') {
    if (args.length < 1 || args.length > 2) throw new Error(help);
    return console.log(
      `Received draft ${(await receive(root, args[0]!, args[1])).plan.id}; verify authority and evidence before sync.`,
    );
  }
  if (!args[0]) throw new Error(help);
  const { task, raw } = await loadTask(root, args[0]);
  if (command === 'context') {
    if (args.length !== 2) throw new Error(help);
    const reading = await guide(root, args[1]!);
    const inspected = await inspectTask(root, task, args[1]!);
    return console.log(json({ ...inspectionOutput(inspected), ...reading }));
  }
  if (command === 'check') {
    if (args.length !== 1) throw new Error(help);
    const result = await assess(root, task);
    console.log(json(assessmentOutput(task, result)));
    if (!result.ready) process.exitCode = 1;
    return;
  }
  if (command === 'handoff') {
    if (args.length !== 1) throw new Error(help);
    return console.log(await handoff(root, task));
  }
  if (task.archived)
    throw new Error('WORK_ARCHIVED: explicitly reopen the record after reconciling authorization');
  if (command === 'sync') {
    if (args.length !== 2 || !args[1]!.trim()) throw new Error(help);
    const issues = [...contractIssues(task), ...(await requirementIssues(root, task.plan))];
    if (issues.length) throw new Error(issues.join('\n'));
    const current = await capture(root, task);
    if (!current.candidate)
      throw new Error('WORK_CANDIDATE: commit all tracked and untracked changes before sync');
    await validateInputs(root, task, current.candidate.commit);
    if (!sameCandidate((await capture(root, task)).candidate, current.candidate))
      throw new Error('WORK_CANDIDATE: HEAD or working tree changed during sync');
    if (task.checkpoint && !sameCandidate(task.checkpoint.candidate, current.candidate)) {
      task.reviewDecision = 'PENDING';
      task.releaseDisposition = 'HOLD_FOR_EVIDENCE';
      if (task.stage === 'C1_RELEASED') task.stage = 'C1_EVIDENCE_PENDING';
    }
    task.checkpoint = { candidate: current.candidate };
    task.notes.push(
      `${new Date().toISOString()} ${args[1]}; candidate ${JSON.stringify(current.candidate)}`,
    );
    if (task.stage === null && !contractIssues(task).length) task.stage = 'C0_READY';
    task.plan.nextAction =
      task.stage === 'C1_EVIDENCE_PENDING'
        ? 'Review evidence for the current candidate, resolve failed or missing observations, then return the result.'
        : task.stage === 'C1_RELEASED'
          ? 'Read back the accepted result and finish this task; do not infer a new implementation mandate.'
          : 'Confirm the current scope and authorization; continue implementation or explicitly enter verification when ready.';
    await saveTask(root, task, raw);
    const result = await assess(root, task);
    console.log(json(assessmentOutput(task, result)));
    if (!result.ready) process.exitCode = 1;
    return;
  }
  if (command === 'archive') {
    if (args.length !== 2 || !args[1]!.trim()) throw new Error(help);
    task.archived = true;
    task.plan.nextAction =
      'Archived history; inspect a new request and current authorization before explicitly reopening.';
    task.notes.push(`${new Date().toISOString()} archived: ${args[1]}; stage ${task.stage}`);
    await saveTask(root, task, raw);
    return console.log('Archived in place; records, failures and artifacts retained.');
  }
  if (!['run', 'evidence'].includes(command)) throw new Error(help);
  if (task.stage !== 'C1_EVIDENCE_PENDING')
    throw new Error(
      'WORK_VERIFY_STAGE: inspect context and use update with the current nextAction to enter C1_EVIDENCE_PENDING before collecting evidence',
    );
  const state = await assess(root, task);
  if (!state.ready) {
    console.error(json(assessmentOutput(task, state)));
    process.exitCode = 1;
    return;
  }
  const criterion = task.plan.acceptance.find((entry) => entry.id === args[1]);
  if (!criterion) throw new Error('WORK_CRITERION: use an acceptance id from this task');
  const candidate = await requireCandidate(root, task);
  if (command === 'evidence') {
    if (args.length !== 4 || !args[3]!.trim()) throw new Error(help);
    const bytes = await artifact(root, task.plan.id, args[2]!);
    const sha256 = digest(bytes);
    await checkManualOriginal(root, task, args[2]!, sha256);
    if (criterion.id === normsCriterion.id) {
      const issues = await normsIssues(root, task.plan, true);
      if (issues.length) throw new Error(issues.join('\n'));
    }
    const result =
      criterion.method === 'automated'
        ? coverageEvidenceResult(
            bytes.toString('utf8'),
            candidate,
            criterion.id,
            contractPlan(task),
          )
        : await manualEvidenceResult(
            root,
            bytes.toString('utf8'),
            task,
            { candidate },
            criterion.id,
          );
    await requireCandidate(root, task);
    addEvidence(task, {
      criterion: criterion.id,
      method: criterion.method,
      result,
      artifact: args[2]!,
      sha256,
      candidate,
      summary: args[3]!,
      environment: environment(),
    });
    await saveTask(root, task, raw);
    return console.log('Evidence recorded; human acceptance remains pending.');
  }
  if (
    criterion.method !== 'automated' ||
    (args.length !== 2 &&
      !(args.length === 3 && args[2] === '--stdin') &&
      (args[2] !== '--' || args.length < 4))
  )
    throw new Error(help);
  const runInput = args[2] === '--stdin' ? JSON.parse(await input()) : null;
  const argv = runInput
    ? ((runInput.command ?? criterion.command!) as string[])
    : args.length === 2
      ? criterion.command!
      : args.slice(3);
  if (
    !Array.isArray(argv) ||
    !argv.length ||
    argv.some((part) => typeof part !== 'string') ||
    !argv[0]!.trim()
  )
    throw new Error('WORK_COMMAND: invalid argv');
  const executionEnvironment = {
    runtime: environment(),
    conditions: runInput?.conditions === undefined ? null : conditions(runInput.conditions),
  };
  const completeCheck = json(argv) === json(criterion.command);
  const relative = `.work/tasks/${task.plan.id}/evidence/${randomUUID()}.log`;
  const path = await checkedPath(root, relative);
  await mkdir(dirname(path), { recursive: true });
  const started = new Date().toISOString();
  const runIdentity = {
    candidate,
    contract: contractPlan(task),
    argv,
    environment: executionEnvironment,
    rawLog: relative,
  };
  const startEntry = {
    criterion: criterion.id,
    method: 'automated',
    result: 'pending',
    candidate,
    artifact: relative,
    summary: 'Execution started or awaiting launch; no settled observation registered.',
    environment: json(executionEnvironment).trim(),
  };
  const log = await open(path, 'wx');
  console.log(`Recording: ${relative}`);
  let inFlight: string;
  let outcome: Awaited<ReturnType<typeof runCommand>>;
  let changed = true;
  let contextError = '';
  const entryIndex = task.evidence.length;
  try {
    await log.write(`${json({ ...runIdentity, checkpoint: task.checkpoint, started })}\n`);
    // Persist the observation before launching, so removing an interrupted marker cannot restore an old pass.
    addEvidence(task, startEntry);
    await saveTask(root, task, raw);
    inFlight = json(task);
    outcome = await runCommand(root, argv, ['ignore', log.fd, log.fd], activity!);
    try {
      const after = await capture(root, task);
      changed = !sameCandidate(after.candidate, candidate);
    } catch (error) {
      contextError = error instanceof Error ? error.message : String(error);
    }
    await log.write(
      `${resultMarker}${json({
        exitCode: outcome.status,
        signal: outcome.signal,
        error: outcome.error?.message,
        cancelled: outcome.cancelled,
        unsettled: outcome.unsettled,
        contextChanged: changed,
        finished: new Date().toISOString(),
      })}`,
    );
  } finally {
    await log.close();
  }
  const passed =
    outcome.status === 0 && !outcome.error && !outcome.cancelled && !outcome.unsettled && !changed;
  const nextAction = outcome.unsettled
    ? 'Confirm the execution group has stopped, inspect the provisional log, then recover the retained command marker before continuing.'
    : changed
      ? 'Inspect the observed input changes and current authorization before sync and verification of the resulting candidate.'
      : !completeCheck
        ? 'Review the supplemental observation and the declared complete check; a passing probe cannot replace complete verification or clear failures.'
        : undefined;
  addEvidence(
    task,
    {
      criterion: criterion.id,
      method: 'automated',
      result: changed || outcome.unsettled ? 'pending' : passed ? 'pass' : 'fail',
      artifact: relative,
      ...(outcome.unsettled ? {} : { sha256: digest(await readFile(path)) }),
      candidate,
      summary: `exit ${outcome.status}; cancelled=${outcome.cancelled}; unsettled=${outcome.unsettled}; contextChanged=${changed}; coverage=${completeCheck ? 'complete' : 'supplement'}${contextError ? `; ${contextError}` : ''}`,
      environment: json(executionEnvironment).trim(),
    },
    nextAction,
    entryIndex,
  );
  await saveTask(root, task, inFlight);
  console.log(
    `${completeCheck ? '' : 'SUPPLEMENTAL '}${passed ? 'PASS' : 'NOT PASSED'}: ${relative}${outcome.unsettled ? '; provisional log' : ''}${changed ? '; WORK_CONTEXT_CHANGED during command' : ''}`,
  );
  if (!passed) process.exitCode = 1;
}

try {
  const writesTask = [
    'start',
    'update',
    'deliver',
    'sync',
    'archive',
    'run',
    'evidence',
    'handoff',
  ];
  if (command && args[0] && writesTask.includes(command))
    await withTaskCommand(root, args[0], command, main);
  else await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (Buffer.byteLength(message) <= 4096) console.error(message);
  else
    console.error(
      json({
        error: [...message].slice(0, 512).join(''),
        incomplete: true,
        bytes: Buffer.byteLength(message),
        detail: 'The full exception text was not persisted. Inspect the original request/input.',
      }),
    );
  process.exitCode = 1;
}

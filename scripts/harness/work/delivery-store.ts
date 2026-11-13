import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkedPath, digest, json, parseTask, loadTask } from './records.ts';
import type { Task } from './records.ts';
import { captureCandidate, captureFiles } from './context.ts';
import { bookPaths, optionalText } from './reports.ts';
import { documentCatalog } from '../task-documents.ts';

interface Change {
  path: string;
  before: string | null;
  after: string | null;
}
export interface Operation {
  version: 2;
  request: string;
  kind: 'prepare' | 'complete';
  candidate: string;
  inputs: Record<string, string>;
  changes: Change[];
  done: boolean;
}
export const operationPath = (id: string) => `.work/tasks/${id}/delivery/operation.json`;

export async function loadOperation(root: string, id: string) {
  const raw = await optionalText(root, operationPath(id));
  if (raw === null) return null;
  const value = JSON.parse(raw);
  // Old journals are data only. An explicit fresh prepare may replace them, never replay them.
  if (value.version === 1) return { operation: null, raw };
  const op = value as Operation;
  if (
    op.version !== 2 ||
    !['prepare', 'complete'].includes(op.kind) ||
    !/^[a-f0-9]{64}$/.test(op.request) ||
    !Array.isArray(op.changes) ||
    typeof op.done !== 'boolean'
  )
    throw new Error('WORK_DELIVERY_OPERATION: invalid journal');
  if (op.changes.some((change) => change.path === 'docs/tasks/index.md')) {
    if (op.done) return { operation: null, raw };
    throw new Error(
      'WORK_DELIVERY_OBSOLETE: unfinished global-index journal retained; reconcile its outputs using the original tool version in an isolated checkout before a fresh prepare; it cannot replay here',
    );
  }
  const state = op.changes.at(-1);
  if (state?.path !== `.work/tasks/${id}/state.json` || !state.after)
    throw new Error('WORK_DELIVERY_OPERATION: state must be last');
  const task = parseTask(state.after);
  if (task.plan.id !== id) throw new Error('WORK_DELIVERY_OPERATION: state must be last');
  const target = task.plan.result;
  const targets = target ? bookPaths(target.prd, await documentCatalog(root)) : null;
  const allowed = (path: string) =>
    path === `.work/tasks/${id}/state.json` ||
    (task.delivery?.version === 2 &&
      targets &&
      (path === targets.report || path === targets.records)) ||
    (op.kind === 'prepare' && path === `.work/tasks/${id}/delivery/draft.md`);
  const paths = new Set<string>();
  for (const change of op.changes) {
    if (
      !allowed(change.path) ||
      paths.has(change.path) ||
      (change.before !== null && typeof change.before !== 'string') ||
      (change.after !== null && typeof change.after !== 'string')
    )
      throw new Error('WORK_DELIVERY_OPERATION: invalid target');
    await checkedPath(root, change.path);
    paths.add(change.path);
  }
  return { operation: op, raw };
}

/** Atomic per file, not a multi-file transaction. One writer per checkout. */
async function replace(root: string, id: string, change: Change) {
  const current = await optionalText(root, change.path);
  if (current === change.after) return;
  if (current !== change.before) throw new Error(`WORK_DELIVERY_CONFLICT: ${change.path}`);
  const path = await checkedPath(root, change.path);
  if (change.after === null) {
    await rm(path);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  const staging = await checkedPath(root, `.work/tasks/${id}/delivery/staged`);
  await mkdir(staging, { recursive: true });
  const temp = `${staging}/${digest(change.path)}-${randomUUID()}.tmp`;
  try {
    await writeFile(temp, change.after, { flag: 'wx' });
    if ((await optionalText(root, change.path)) !== change.before)
      throw new Error(`WORK_DELIVERY_CONFLICT: ${change.path}`);
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

async function finishOperation(root: string, id: string, op: Operation, journal: string) {
  if ((await optionalText(root, operationPath(id))) !== journal)
    throw new Error('WORK_DELIVERY_CONFLICT: operation journal changed');
  const task = parseTask(op.changes.at(-1)!.after!);
  if (json(await captureFiles(root, task)) !== json(op.inputs))
    throw new Error('WORK_DELIVERY_STALE: inputs changed during operation');
  // Preflight every destination before any further write. Never roll back newer edits.
  for (const change of op.changes) {
    const current = await optionalText(root, change.path);
    if (current !== change.before && current !== change.after)
      throw new Error(`WORK_DELIVERY_CONFLICT: ${change.path}`);
  }
  for (const change of op.changes) await replace(root, id, change);
  const path = operationPath(id);
  await replace(root, id, { path, before: journal, after: json({ ...op, done: true }) });
}

export async function commitDelivery(
  root: string,
  task: Task,
  raw: string,
  request: string,
  kind: Operation['kind'],
  outputs: Record<string, string | null>,
  expected: Record<string, string | null>,
) {
  const id = task.plan.id;
  const changes: Change[] = [];
  for (const [path, after] of Object.entries(outputs)) {
    const before = await optionalText(root, path);
    if (path in expected && before !== expected[path])
      throw new Error(`WORK_DELIVERY_CONFLICT: ${path}`);
    changes.push({ path, before, after });
  }
  const statePath = `.work/tasks/${id}/state.json`;
  if ((await optionalText(root, statePath)) !== raw)
    throw new Error('WORK_CONFLICT: task changed before delivery');
  changes.push({ path: statePath, before: raw, after: json(task) });
  const captured = await captureCandidate(root, task);
  if (captured.candidate !== task.checkpoint?.candidate)
    throw new Error('WORK_DELIVERY_STALE: candidate changed before publication');
  const op: Operation = {
    version: 2,
    request,
    kind,
    candidate: captured.candidate,
    inputs: captured.files,
    changes,
    done: false,
  };
  const previous = await loadOperation(root, id);
  if (previous?.operation && !previous.operation.done)
    throw new Error('WORK_DELIVERY_PENDING: resume the original request');
  if (previous && !previous.operation && kind !== 'prepare')
    throw new Error('WORK_DELIVERY_OBSOLETE: prepare a new v5 draft; old journal cannot replay');
  const path = operationPath(id);
  const journal = json(op);
  await replace(root, id, { path, before: previous?.raw ?? null, after: journal });
  await finishOperation(root, id, op, journal);
}

export async function replayDelivery(
  root: string,
  id: string,
  request: string,
  verify: (task: Task, operation: Operation) => Promise<void>,
  freshPrepare = false,
) {
  const owned = await loadTask(root, id);
  const loaded = await loadOperation(root, id);
  if (loaded && !loaded.operation && !freshPrepare)
    throw new Error('WORK_DELIVERY_OBSOLETE: prepare a new v5 draft; old journal cannot replay');
  const op = loaded?.operation;
  if (!op || (op.done && op.request !== request)) return false;
  if (op.request !== request) throw new Error('WORK_DELIVERY_PENDING: resume the original request');
  const state = op.changes.at(-1)!;
  const restored = parseTask(state.after!);
  if (restored.delivery?.version !== 2)
    throw new Error('WORK_DELIVERY_OBSOLETE: prepare a new v5 draft');
  if (restored.member !== owned.task.member || restored.workspace !== root)
    throw new Error('WORK_OWNER: delivery operation belongs to another workspace');
  const current = await optionalText(root, state.path);
  if (op.done && current !== state.after) return false;
  await verify(parseTask(state.after!), op);
  if (op.done) {
    for (const change of op.changes) {
      if ((await optionalText(root, change.path)) !== change.after)
        throw new Error(`WORK_DELIVERY_CONFLICT: completed output changed ${change.path}`);
    }
    return true;
  }
  await finishOperation(root, id, op, loaded!.raw);
  return true;
}

export const requestDigest = (value: unknown) => digest(json(value));

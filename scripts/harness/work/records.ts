import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

export const stages = ['C0_READY', 'C1_IMPLEMENTATION', 'C1_EVIDENCE_PENDING', 'C1_RELEASED'];
export const methods = ['automated', 'review', 'behavior'];
export interface Requirement {
  source: string;
  section: string;
  key: string;
}
export interface TaskPlan {
  id: string;
  requirement?: Requirement;
  result?: { prd: string; key: string } | null;
  norms?: { version?: 2; paths: string[]; reason: string };
  goal: string;
  scope: string[];
  inputs: string[];
  sources: string[];
  authorization: string;
  nonGoals: string[];
  acceptance: { id: string; criterion: string; method: string; command?: string[] }[];
  decisions: { status: string; text: string; source: string }[];
  dependencies: { task: string; ref: string; ready: boolean }[];
  blockers: string[];
  nextAction: string;
  stopCondition: string;
  sharedRef: string;
}
export interface Checkpoint {
  head: string | null;
  branch: string | null;
  files: Record<string, string>;
  contract: string;
  candidate: string;
}
export interface Evidence {
  criterion: string;
  method: string;
  result: string;
  candidate: string;
  artifact: string;
  sha256: string;
  summary: string;
  environment: string;
}
export interface Task {
  version: 1;
  member: string;
  workspace: string;
  plan: TaskPlan;
  stage: string | null;
  reviewDecision: string;
  releaseDisposition: string;
  checkpoint: Checkpoint | null;
  evidence: Evidence[];
  notes: string[];
  archived: boolean;
  delivery?: {
    version: 1 | 2;
    draft?: { path: string; sha256: string; candidate: string };
    accepted?: { path: string; sha256: string; candidate: string; key?: string };
  };
}

export const digest = (bytes: string | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');
export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export function identifier(value: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(value))
    throw new Error('WORK_ID: use a short lowercase id');
  return value;
}

/** All paths are workspace-relative; existing symlinks are never traversed. */
export async function checkedPath(root: string, relative: string): Promise<string> {
  if (
    !relative ||
    isAbsolute(relative) ||
    relative.includes('\\') ||
    relative.includes('\0') ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`WORK_PATH: invalid relative path ${relative}`);
  let path = root;
  for (const part of relative.split('/')) {
    path = join(path, part);
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error(`WORK_SYMLINK: ${relative}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return path;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('WORK_SCHEMA: expected object');
  return value as Record<string, unknown>;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function parseTask(raw: string): Task {
  const value: unknown = JSON.parse(raw);
  const task = object(value);
  const plan = object(task.plan);
  for (const key of ['id', 'goal', 'authorization', 'nextAction', 'stopCondition', 'sharedRef']) {
    if (typeof plan[key] !== 'string') throw new Error(`WORK_SCHEMA: plan.${key}`);
  }
  identifier(plan.id as string);
  if (plan.requirement !== undefined) {
    const requirement = object(plan.requirement);
    for (const key of ['source', 'section', 'key']) {
      if (typeof requirement[key] !== 'string' || !(requirement[key] as string).trim())
        throw new Error(`WORK_SCHEMA: requirement.${key}`);
    }
    identifier(requirement.key as string);
  }
  if (plan.result !== undefined && plan.result !== null) {
    const result = object(plan.result);
    if (
      typeof result.prd !== 'string' ||
      !result.prd.endsWith('.md') ||
      !/^(?:docs\/|README\.md$|AGENTS\.md$)/.test(result.prd) ||
      result.prd.split('/').some((part) => !part || part === '.' || part === '..') ||
      result.prd.includes('\\') ||
      Object.keys(result).some((key) => !['prd', 'key'].includes(key))
    )
      throw new Error('WORK_SCHEMA: result.prd must name a public Markdown source');
    if (typeof result.key !== 'string' || !result.key.trim())
      throw new Error('WORK_SCHEMA: result.key');
    identifier(result.key as string);
  }
  if (plan.norms !== undefined) {
    const norms = object(plan.norms);
    if (
      !strings(norms.paths) ||
      new Set(norms.paths).size !== norms.paths.length ||
      typeof norms.reason !== 'string' ||
      !norms.reason.trim() ||
      (norms.version !== undefined && norms.version !== 2) ||
      Object.keys(norms).some((key) => !['version', 'paths', 'reason'].includes(key))
    )
      throw new Error('WORK_SCHEMA: norms requires unique paths and a reconciliation reason');
  }
  for (const key of ['scope', 'inputs', 'sources', 'nonGoals', 'blockers']) {
    if (!strings(plan[key])) throw new Error(`WORK_SCHEMA: plan.${key}`);
  }
  for (const [key, fields] of Object.entries({
    acceptance: ['id', 'criterion', 'method'],
    decisions: ['status', 'text', 'source'],
    dependencies: ['task', 'ref'],
  })) {
    if (!Array.isArray(plan[key])) throw new Error(`WORK_SCHEMA: plan.${key}`);
    for (const item of plan[key] as unknown[]) {
      const entry = object(item);
      if (fields.some((field) => typeof entry[field] !== 'string'))
        throw new Error(`WORK_SCHEMA: plan.${key} entry`);
      if (
        key === 'acceptance' &&
        (!methods.includes(entry.method as string) || !entry.id || !entry.criterion)
      )
        throw new Error('WORK_SCHEMA: acceptance method/id/criterion');
      if (
        key === 'acceptance' &&
        entry.command !== undefined &&
        (entry.method !== 'automated' ||
          !strings(entry.command) ||
          !entry.command.length ||
          !entry.command[0]!.trim())
      )
        throw new Error('WORK_SCHEMA: automated command must be a nonempty argv array');
      if (
        key === 'decisions' &&
        !['CONFIRMED', 'AI_PROPOSED', 'OPEN', 'REJECTED'].includes(entry.status as string)
      )
        throw new Error('WORK_SCHEMA: decision status');
      if (key === 'dependencies' && typeof entry.ready !== 'boolean')
        throw new Error('WORK_SCHEMA: dependency.ready');
    }
  }
  const criteria = plan.acceptance as TaskPlan['acceptance'];
  if (new Set(criteria.map((item) => item.id)).size !== criteria.length)
    throw new Error('WORK_SCHEMA: duplicate criterion id');
  if (
    task.version !== 1 ||
    typeof task.member !== 'string' ||
    typeof task.workspace !== 'string' ||
    (task.stage !== null && !stages.includes(task.stage as string)) ||
    !['PENDING', 'ACCEPT', 'REQUEST_CHANGES', 'HOLD'].includes(task.reviewDecision as string) ||
    !['HOLD_FOR_EVIDENCE', 'HOLD_FOR_HUMAN_REVIEW', 'RELEASED'].includes(
      task.releaseDisposition as string,
    ) ||
    !strings(task.notes) ||
    typeof task.archived !== 'boolean' ||
    !Array.isArray(task.evidence)
  )
    throw new Error('WORK_SCHEMA: task metadata');
  if (task.checkpoint !== null) {
    const checkpoint = object(task.checkpoint);
    if (
      (checkpoint.head !== null && typeof checkpoint.head !== 'string') ||
      (checkpoint.branch !== null && typeof checkpoint.branch !== 'string') ||
      typeof checkpoint.candidate !== 'string' ||
      typeof checkpoint.contract !== 'string' ||
      !/^[a-f0-9]{64}$/.test(checkpoint.contract)
    )
      throw new Error('WORK_SCHEMA: checkpoint');
    for (const hash of Object.values(object(checkpoint.files))) {
      if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
        throw new Error('WORK_SCHEMA: file hash');
    }
    if (
      checkpoint.candidate !==
      digest(json({ files: checkpoint.files, contract: checkpoint.contract }))
    )
      throw new Error('WORK_SCHEMA: candidate binding');
  }
  if (task.delivery !== undefined) {
    const delivery = object(task.delivery);
    if (
      ![1, 2].includes(delivery.version as number) ||
      Object.keys(delivery).some((key) => !['version', 'draft', 'accepted'].includes(key))
    )
      throw new Error('WORK_SCHEMA: delivery');
    if (delivery.version === 2 && !plan.result)
      throw new Error('WORK_SCHEMA: delivery result binding');
    for (const kind of ['draft', 'accepted']) {
      if (delivery[kind] === undefined) continue;
      const ref = object(delivery[kind]);
      if (
        typeof ref.path !== 'string' ||
        typeof ref.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(ref.sha256) ||
        typeof ref.candidate !== 'string' ||
        !/^[a-f0-9]{64}$/.test(ref.candidate)
      )
        throw new Error('WORK_SCHEMA: delivery reference');
      // Historical personal references remain readable; public operations resolve current ownership.
      if (
        kind === 'draft'
          ? ref.path !== `.work/tasks/${plan.id}/delivery/draft.md`
          : !/^docs\/tasks\/[a-z0-9/_-]+\/report\.md$/.test(ref.path)
      )
        throw new Error('WORK_SCHEMA: delivery path');
      if (
        delivery.version === 2 &&
        (!plan.result ||
          (kind === 'accepted' && ref.key !== (plan.result as NonNullable<TaskPlan['result']>).key))
      )
        throw new Error('WORK_SCHEMA: delivery result binding');
    }
  }
  for (const item of task.evidence) {
    const entry = object(item);
    if (
      ['criterion', 'candidate', 'artifact', 'sha256', 'summary', 'environment'].some(
        (key) => typeof entry[key] !== 'string',
      ) ||
      !methods.includes(entry.method as string) ||
      !['pass', 'fail', 'pending'].includes(entry.result as string) ||
      !/^[a-f0-9]{64}$/.test(entry.sha256 as string)
    )
      throw new Error('WORK_SCHEMA: evidence');
  }
  return value as Task;
}

export async function member(root: string): Promise<string> {
  const value = object(
    JSON.parse(await readFile(await checkedPath(root, '.work/member.json'), 'utf8')),
  );
  if (value.version !== 1 || typeof value.member !== 'string' || value.workspace !== root)
    throw new Error(
      'WORK_MEMBER: initialize this workspace; receive a handoff instead of copying another member directory',
    );
  return identifier(value.member);
}

/** A member is a local label, not an identity or permission credential. */
export async function initializeMember(root: string, actor?: string): Promise<string> {
  const path = await checkedPath(root, '.work/member.json');
  try {
    const current = await member(root);
    if (actor !== undefined && current !== identifier(actor))
      throw new Error('WORK_MEMBER: this workspace belongs to another member');
    return current;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const selected = actor === undefined ? `local-${digest(root).slice(0, 16)}` : identifier(actor);
  await mkdir(dirname(path), { recursive: true });
  // Different tasks may bootstrap together. Publish complete bytes exclusively, never a partial member file.
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, json({ version: 1, member: selected, workspace: root }), {
      flag: 'wx',
    });
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const current = await member(root);
    if (actor !== undefined && current !== actor)
      throw new Error('WORK_MEMBER: this workspace belongs to another member');
    return current;
  } finally {
    await rm(temporary, { force: true });
  }
}

export function draft(root: string, actor: string, id: string, goal: string): Task {
  return {
    version: 1,
    member: actor,
    workspace: root,
    plan: {
      id: identifier(id),
      goal,
      scope: [],
      inputs: ['package.json', 'harness.config.json'],
      sources: [],
      authorization: '',
      nonGoals: [],
      acceptance: [],
      decisions: [],
      dependencies: [],
      blockers: [],
      nextAction: 'Complete the task contract, then sync with a reconciliation reason.',
      stopCondition: '',
      sharedRef: '',
    },
    stage: null,
    reviewDecision: 'PENDING',
    releaseDisposition: 'HOLD_FOR_EVIDENCE',
    checkpoint: null,
    evidence: [],
    notes: [],
    archived: false,
  };
}

export async function loadTask(root: string, id: string) {
  const path = await checkedPath(root, `.work/tasks/${identifier(id)}/state.json`);
  const raw = await readFile(path, 'utf8');
  const task = parseTask(raw);
  if (task.plan.id !== id || task.workspace !== root || task.member !== (await member(root)))
    throw new Error('WORK_OWNER: task, member or workspace mismatch; receive a handoff');
  return { task, raw, path };
}

/** Shared read-only recovery guard; full operation validation belongs to delivery-store. */
export async function deliveryPending(root: string, id: string): Promise<boolean> {
  try {
    const operation = JSON.parse(
      await readFile(
        await checkedPath(root, `.work/tasks/${identifier(id)}/delivery/operation.json`),
        'utf8',
      ),
    );
    return operation.version !== 1 && operation.done !== true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
}

/** One writer per task. Refuse changes made while a command was running; keep raw evidence. */
export async function saveTask(root: string, task: Task, previous?: string) {
  const path = await checkedPath(root, `.work/tasks/${identifier(task.plan.id)}/state.json`);
  parseTask(json(task));
  if (await deliveryPending(root, task.plan.id))
    throw new Error('WORK_DELIVERY_PENDING: resume the original delivery request');
  await mkdir(dirname(path), { recursive: true });
  if (previous === undefined) return writeFile(path, json(task), { flag: 'wx' });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, json(task), { flag: 'wx' });
    if ((await readFile(path, 'utf8')) !== previous)
      throw new Error('WORK_CONFLICT: state changed; reconcile without overwriting it');
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

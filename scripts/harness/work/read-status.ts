import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { checkedPath, digest, json, loadTask, stages } from './records.ts';
import { readPage } from './output.ts';
import type { ReadOptions } from './output.ts';

/** List records without repository capture, evidence verification or an assessment per task. */
export async function readStatus(
  root: string,
  options: ReadOptions,
  flags: Record<string, string>,
) {
  const archived = flags.archived ?? 'active';
  if (!['active', 'archived', 'all'].includes(archived))
    throw new Error('WORK_STATUS_FILTER: archived must be active, archived or all');
  if (flags.stage && flags.stage !== 'draft' && !stages.includes(flags.stage))
    throw new Error('WORK_STATUS_FILTER: stage must be a recorded stage or draft');
  let entries: Dirent[];
  try {
    entries = await readdir(await checkedPath(root, '.work/tasks'), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    entries = [];
  }
  const tasks = [];
  const identities = [];
  const query = flags.query?.toLocaleLowerCase();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const { task, raw } = await loadTask(root, entry.name);
    identities.push([entry.name, digest(raw)]);
    if (archived !== 'all' && task.archived !== (archived === 'archived')) continue;
    if (flags.stage && (task.stage ?? 'draft') !== flags.stage) continue;
    if (
      query &&
      !json([
        task.plan.id,
        task.plan.goal,
        task.plan.requirement,
        task.plan.result,
        task.plan.nextAction,
      ])
        .toLocaleLowerCase()
        .includes(query)
    )
      continue;
    tasks.push({
      id: task.plan.id,
      goal: task.plan.goal,
      requirement: task.plan.requirement ?? null,
      ...(task.plan.result ? { result: task.plan.result } : {}),
      recorded: {
        stage: task.stage,
        archived: task.archived,
        reviewDecision: task.reviewDecision,
        releaseDisposition: task.releaseDisposition,
      },
      nextAction: task.plan.nextAction,
      assessment: {
        status: 'not_checked',
        context: ['context', task.plan.id, 'resume'],
        check: ['check', task.plan.id],
      },
    });
  }
  const command = ['status'];
  for (const name of ['query', 'stage', 'archived'])
    if (flags[name] !== undefined) command.push(`--${name}`, flags[name]!);
  const page = readPage(
    tasks,
    options,
    command,
    digest(json({ identities, query, stage: flags.stage, archived })),
  );
  const { items, ...rest } = page as typeof page & { items?: unknown[] };
  return options.select ? page : { tasks: items ?? [], ...rest };
}

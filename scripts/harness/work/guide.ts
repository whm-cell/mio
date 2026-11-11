import { readFile } from 'node:fs/promises';
import { nodeText, parseMarkdown } from '../markdown.ts';
import { checkedPath } from './records.ts';
import type { Task } from './records.ts';
import { readPage } from './output.ts';
import type { ReadOptions } from './output.ts';

const sections: Record<string, [string, string][]> = {
  start: [
    ['docs/coordination.md', '开始任务'],
    ['docs/work-records.md', '创建任务'],
  ],
  resume: [
    ['docs/coordination.md', '恢复与同步'],
    ['docs/work-records.md', '核对与同步'],
  ],
  implement: [
    ['docs/coordination.md', '实施与协作'],
    ['docs/work-records.md', '实施命令'],
  ],
  verify: [
    ['docs/coordination.md', '验证与接受'],
    ['docs/coordination.md', '交回与下一步'],
    ['docs/work-records.md', '记录证据'],
    ['docs/engineering/testing.md', '按变更定位测试'],
  ],
  handoff: [
    ['docs/coordination.md', '跨人交接'],
    ['docs/coordination.md', '交回与下一步'],
    ['docs/work-records.md', '发送与接收'],
  ],
  archive: [
    ['docs/coordination.md', '归档与保留'],
    ['docs/coordination.md', '交回与下一步'],
    ['docs/work-records.md', '归档命令'],
  ],
  deliver: [
    ['docs/coordination.md', '任务交付与重开'],
    ['docs/coordination.md', '交回与下一步'],
    ['docs/work-records.md', '交付命令'],
  ],
};

/** Parse heading boundaries, so another mode or an example heading inside a code fence is never expanded. */
async function section(root: string, file: string, title: string) {
  const source = await readFile(await checkedPath(root, file), 'utf8');
  const nodes = parseMarkdown(source).children ?? [];
  const matches = nodes.filter((node) => node.type === 'heading' && nodeText(node) === title);
  if (matches.length !== 1) throw new Error(`WORK_GUIDE_SECTION: ${file}: expected one ${title}`);
  const heading = matches[0]!;
  const index = nodes.indexOf(heading);
  const end = nodes
    .slice(index + 1)
    .find((node) => node.type === 'heading' && node.depth! <= heading.depth!)?.position
    ?.start.offset;
  return {
    ref: `${file}#${title}`,
    blocks: nodes
      .slice(index)
      .filter((node) => node.position!.start.offset < (end ?? source.length))
      .map((node) => ({
        type: node.type,
        body: source.slice(node.position!.start.offset, node.position!.end.offset).trim(),
      })),
  };
}

export async function guide(
  root: string,
  action: string,
  options?: ReadOptions,
  selectedRef?: string,
) {
  const selected = Object.hasOwn(sections, action) ? sections[action] : undefined;
  if (!selected) throw new Error(`WORK_ACTION: choose ${Object.keys(sections).join(', ')}`);
  const reading = [];
  for (const [file, title] of [['docs/coordination.md', '共同规则'], ...selected])
    reading.push(await section(root, file!, title!));
  if (selectedRef !== undefined) {
    const chosen = reading.find((entry) => entry.ref === selectedRef);
    if (!chosen) throw new Error('WORK_GUIDE_SECTION: choose a ref from this action navigation');
    return {
      action,
      ref: chosen.ref,
      ...readPage(chosen, { offset: 0, ...options, select: options?.select || '/blocks' }, [
        'guide',
        action,
        '--section',
        chosen.ref,
      ]),
    };
  }
  if (options && (options.offset || options.limit !== undefined || options.hash || options.select))
    throw new Error('WORK_GUIDE_SECTION: select one section before paging');
  return {
    action,
    reading: reading.map((entry) => ({
      ref: entry.ref,
      blocks: entry.blocks.length,
      read: { argv: ['guide', action, '--section', entry.ref] },
    })),
  };
}

export function taskSummary(task: Task, action: string) {
  return {
    id: task.plan.id,
    ...(task.plan.requirement ? { requirement: task.plan.requirement } : {}),
    result: task.plan.result ?? null,
    ...(task.plan.norms ? { norms: task.plan.norms } : {}),
    goal: task.plan.goal,
    stage: task.stage,
    reviewDecision: task.reviewDecision,
    releaseDisposition: task.releaseDisposition,
    archived: task.archived,
    ...(task.delivery ? { delivery: task.delivery } : {}),
    authorization: task.plan.authorization,
    scope: task.plan.scope,
    inputs: task.plan.inputs,
    nonGoals: task.plan.nonGoals,
    sources: task.plan.sources,
    decisions: task.plan.decisions,
    blockers: task.plan.blockers,
    nextAction: task.plan.nextAction,
    stopCondition: task.plan.stopCondition,
    ...(['start', 'implement', 'verify'].includes(action)
      ? { acceptance: task.plan.acceptance }
      : {}),
    ...(['resume', 'implement', 'handoff'].includes(action)
      ? { dependencies: task.plan.dependencies, sharedRef: task.plan.sharedRef }
      : {}),
  };
}

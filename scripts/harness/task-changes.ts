import { readFile } from 'node:fs/promises';
import { format } from 'prettier';
import { nodeText, parseMarkdown } from './markdown.ts';
import type { MarkdownNode } from './markdown.ts';
import type { TaskDocument } from './inventory.ts';
import { checkedPath, identifier } from './work/records.ts';
import { fields, metadata, record } from './work/report-format.ts';
import { prdDirectory } from './work/compact-store.ts';

export const changeIndexPath = (prdPath: string) => `${prdDirectory(prdPath)}/changes/index.md`;
export const changeIndex = (path: string) =>
  /^docs\/tasks\/[a-z0-9][a-z0-9_-]*\/changes\/index\.md$/.test(path);

/** The registered identity supplies the stable key; a moved path must retain that key. */
async function readChange(root: string, entry: TaskDocument, prdPath: string, sections: string[]) {
  const directory = prdDirectory(prdPath);
  const identity =
    /^docs\/tasks\/[a-z0-9][a-z0-9_-]*\/changes\/([a-z0-9][a-z0-9_-]{0,79})\/change\.md$/.exec(
      entry.identity,
    );
  const match = /^([a-z0-9][a-z0-9_-]{0,79})\/change\.md$/.exec(
    entry.path.slice(`${directory}/changes/`.length),
  );
  if (!identity || !entry.path.startsWith(`${directory}/changes/`) || !match)
    throw new Error(`TASK_CHANGE_LOCATION: ${entry.path}`);
  if (identity[1] !== match[1]) throw new Error(`TASK_CHANGE_ID: ${entry.path}`);
  const id = identifier(identity[1]!);
  const body = await readFile(await checkedPath(root, entry.path), 'utf8');
  const tree = parseMarkdown(body);
  const nodes: MarkdownNode[] = [];
  const visit = (node: MarkdownNode) => {
    nodes.push(node);
    node.children?.forEach(visit);
  };
  visit(tree);
  const titles = nodes.filter((node) => node.type === 'heading' && node.depth === 1);
  const title = titles.length === 1 ? nodeText(titles[0]!).trim() : '';
  if (nodes.filter((node) => node.type === 'code' && node.lang === 'mio-change').length !== 1)
    throw new Error(`TASK_CHANGE_FORMAT: ${entry.path}`);
  const details = record(metadata(body, 'mio-change'));
  fields(details, ['version', 'type', 'section']);
  if (
    !title ||
    /[\r\n]/.test(title) ||
    details.version !== 1 ||
    !['fix', 'adjustment', 'feature'].includes(details.type as string) ||
    typeof details.section !== 'string' ||
    !details.section.trim() ||
    details.section !== details.section.trim() ||
    /[\r\n]/.test(details.section)
  )
    throw new Error(`TASK_CHANGE_FORMAT: ${entry.path}`);
  if (sections.filter((section) => section === details.section).length !== 1)
    throw new Error(`TASK_CHANGE_SECTION: ${entry.path}`);
  return {
    id,
    type: details.type as string,
    title,
    section: details.section,
    path: entry.path,
    body,
  };
}

export async function readChanges(root: string, documents: TaskDocument[], prdPath: string) {
  const directory = `${prdDirectory(prdPath)}/changes/`;
  const entries = documents.filter(
    (entry) => entry.kind === 'change' && entry.path.startsWith(directory),
  );
  if (!entries.length) return [];
  const parent = parseMarkdown(await readFile(await checkedPath(root, prdPath), 'utf8'));
  const sections = (parent.children ?? []).filter((node) => node.type === 'heading').map(nodeText);
  const changes = await Promise.all(
    entries.map((entry) => readChange(root, entry, prdPath, sections)),
  );
  return changes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The index contains only stable navigation fields and is safe to regenerate from the cards. */
export async function renderChangeIndex(changes: Awaited<ReturnType<typeof readChanges>>) {
  const escape = (value: string) => value.replace(/[\\`*_{}\[\]<>|]/g, '\\$&');
  const rows = changes.map(
    (item) =>
      `| ${item.id} | ${item.type} | ${escape(item.title)} | ${escape(item.section)} | [详情](./${item.id}/change.md) |`,
  );
  return format(
    `# 轻量变更索引\n\n| ID | 类型 | 标题 | 父 PRD 章节 | 详情 |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`,
    { parser: 'markdown', printWidth: 100 },
  );
}

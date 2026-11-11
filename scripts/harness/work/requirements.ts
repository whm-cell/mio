import { readFile } from 'node:fs/promises';
import { nodeText, parseMarkdown } from '../markdown.ts';
import { documentCatalog, resolveDocument } from '../task-documents.ts';
import { checkedPath } from './records.ts';
import type { TaskPlan } from './records.ts';

/** A section is a current document locator; source and key remain the stable task identity. */
export async function requirementIssues(root: string, plan: TaskPlan): Promise<string[]> {
  if (!plan.requirement) return [];
  const { source, section } = plan.requirement;
  const path = resolveDocument(source, await documentCatalog(root)).currentPath;
  const tree = parseMarkdown(await readFile(await checkedPath(root, path), 'utf8'));
  const matches = tree.children?.filter(
    (node) => node.type === 'heading' && nodeText(node) === section,
  );
  return matches?.length === 1
    ? []
    : [
        `WORK_REQUIREMENT_SECTION: ${path} must contain one heading named ${JSON.stringify(section)}; inspect the document and correct plan.requirement.section using work update without changing source/key`,
      ];
}

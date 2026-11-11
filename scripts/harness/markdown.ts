import { unified } from 'unified';
import remarkParse from 'remark-parse';

export interface MarkdownNode {
  lang?: string;
  type: string;
  url?: string;
  value?: string;
  identifier?: string;
  depth?: number;
  children?: MarkdownNode[];
  position?: { start: { offset: number }; end: { offset: number } };
}
export const parseMarkdown = (source: string) =>
  unified().use(remarkParse).parse(source) as MarkdownNode;
export const nodeText = (node: MarkdownNode): string =>
  node.value ?? node.children?.map(nodeText).join('') ?? '';
export function markdownLinks(tree: MarkdownNode) {
  const urls: string[] = [];
  const destinations: string[] = [];
  const definitions = new Map<string, string>();
  const references: string[] = [];
  const visit = (node: MarkdownNode): void => {
    if (node.type === 'definition') {
      if (!definitions.has(node.identifier!)) definitions.set(node.identifier!, node.url!);
      destinations.push(node.url!);
    } else if (node.url !== undefined) {
      urls.push(node.url);
      destinations.push(node.url);
    } else if (['linkReference', 'imageReference'].includes(node.type))
      references.push(node.identifier!);
    node.children?.forEach(visit);
  };
  visit(tree);
  for (const ref of references) if (definitions.has(ref)) urls.push(definitions.get(ref)!);
  return { links: urls, destinations };
}
/** GitHub-style heading anchors for this repository's CommonMark headings, including duplicates. */
export function headingAnchors(tree: MarkdownNode) {
  const anchors = new Set<string>();
  const visit = (node: MarkdownNode): void => {
    if (node.type === 'html') {
      const match = /^<a id="([^"<>]+)">(?:<\/a>)?$/.exec(node.value?.trim() ?? '');
      if (match) anchors.add(match[1]!);
    }
    if (node.type === 'heading') {
      const base = nodeText(node)
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '')
        .replace(/\s/g, '-');
      let anchor = base;
      let suffix = 0;
      while (anchors.has(anchor)) anchor = `${base}-${++suffix}`;
      anchors.add(anchor);
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return anchors;
}

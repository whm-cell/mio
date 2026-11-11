import { nodeText } from './markdown.ts';
import type { MarkdownNode } from './markdown.ts';

/** Endpoint identities live once in domain headings; the index only links domains. */
export function checkApiDocuments(
  documents: ReadonlyMap<string, MarkdownNode>,
  navigation: ReadonlyMap<string, readonly string[]>,
) {
  const errors: string[] = [];
  const identities = new Map<string, string>();
  const domains = [...documents.keys()].filter(
    (path) => path.startsWith('docs/apis/') && path !== 'docs/apis/index.md',
  );
  if (domains.length && !documents.has('docs/apis/index.md')) errors.push('API_INDEX_MISSING');
  const linked = new Set(navigation.get('docs/apis/index.md') ?? []);
  for (const path of domains) {
    if (!linked.has(path)) errors.push(`API_DOMAIN_UNLINKED ${path}`);
    const nodes = documents.get(path)!.children ?? [];
    let count = 0;
    for (const [index, heading] of nodes.entries()) {
      if (heading.type !== 'heading' || heading.depth !== 2) continue;
      const identity = nodeText(heading);
      if (identity === '本域共同约定') continue;
      if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \/[^\s?#]*$/.test(identity)) {
        errors.push(`API_ENDPOINT_INVALID ${path}: ${identity}`);
        continue;
      }
      count++;
      if (identities.has(identity))
        errors.push(`API_DUPLICATE ${identity}: ${path}, ${identities.get(identity)}`);
      identities.set(identity, path);
      const end = nodes.findIndex(
        (node, position) => position > index && node.type === 'heading' && node.depth! <= 2,
      );
      const body = nodes.slice(index + 1, end === -1 ? undefined : end);
      for (const field of ['身份', '输入', '成功', '错误', '副作用']) {
        const values = body.filter(
          (node) => node.type === 'paragraph' && nodeText(node).startsWith(`${field}：`),
        );
        if (
          values.length !== 1 ||
          !nodeText(values[0]!)
            .slice(field.length + 1)
            .trim()
        )
          errors.push(`API_FIELD ${path}: ${identity}: ${field}`);
      }
    }
    if (!count) errors.push(`API_ENDPOINT_MISSING ${path}: use method/path level-two headings`);
  }
  return errors;
}

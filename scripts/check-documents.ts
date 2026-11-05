import { spawnSync } from 'node:child_process';
import { access, readFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { beneath } from './inventory.ts';
import type { HarnessConfig } from './inventory.ts';

interface MarkdownNode {
  type: string;
  url?: string;
  children?: MarkdownNode[];
}

/** CommonMark link destinations and public/private paths; no remote-URL or heading-anchor validation. */
export async function checkDocuments(
  root: string,
  files: readonly string[],
  config: HarnessConfig,
) {
  const errors: string[] = [];
  for (const file of files.filter((path) => path.endsWith('.md'))) {
    const source = await readFile(join(root, file), 'utf8');
    if (/\/(?:Users|Volumes|home)\//.test(source)) errors.push(`PERSONAL_PATH ${file}`);
    const tree = unified().use(remarkParse).parse(source) as MarkdownNode;
    const urls: string[] = [];
    const visit = (node: MarkdownNode): void => {
      if (node.url !== undefined) urls.push(node.url);
      node.children?.forEach(visit);
    };
    visit(tree);
    for (const url of urls) {
      if (/^(?:https?:|mailto:|#)/.test(url)) continue;
      let target: string;
      try {
        target = decodeURIComponent(url.split('#')[0]?.split('?')[0] ?? '');
      } catch {
        errors.push(`LINK_INVALID ${file}: ${url}`);
        continue;
      }
      if (!target) continue;
      const path = resolve(dirname(join(root, file)), target);
      let local = relative(root, path).replaceAll('\\', '/');
      if (
        local.startsWith('../') ||
        config.privateRoots.some((base) => beneath(local, base)) ||
        /(?:^|\/)\.env(?:\.|$)/.test(local)
      ) {
        errors.push(`LINK_PRIVATE ${file}: ${url}`);
        continue;
      }
      try {
        await access(path);
        local = relative(root, await realpath(path)).replaceAll('\\', '/');
        if (local.startsWith('../') || config.privateRoots.some((base) => beneath(local, base))) {
          errors.push(`LINK_PRIVATE ${file}: ${url}`);
        }
      } catch {
        errors.push(`LINK_MISSING ${file}: ${url}`);
      }
    }
  }
  const index = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  const indexChecked = index.status === 0;
  if (indexChecked) {
    for (const file of index.stdout.split('\0').filter(Boolean)) {
      if (
        [...config.privateRoots, 'node_modules', 'dist', 'coverage'].some((base) =>
          beneath(file, base),
        ) ||
        (/(?:^|\/)\.env(?:\.|$)/.test(file) && file !== '.env.example') ||
        file.endsWith('.tgz')
      ) {
        errors.push(`INDEX_PRIVATE ${file}`);
      }
    }
  }
  return { errors, indexChecked };
}

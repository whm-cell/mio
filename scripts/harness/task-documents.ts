import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { beneath, loadConfig } from './inventory.ts';
import type { HarnessConfig, TaskDocument } from './inventory.ts';
import { markdownLinks, nodeText, parseMarkdown } from './markdown.ts';
import type { MarkdownNode } from './markdown.ts';
import { checkedPath } from './work/records.ts';
import { prdDirectory } from './work/compact-store.ts';
import { readChanges } from './task-changes.ts';

export const resultDocument = (path: string) =>
  /^docs\/tasks\/[a-z0-9][a-z0-9_-]*\/complete\//.test(path);
export const taskNavigation = (path: string) => path === 'docs/tasks/index.md';
interface RegisteredTaskDocument extends TaskDocument {
  registry: string;
}

export function publicDocument(path: string, config: HarnessConfig): boolean {
  return (
    path.endsWith('.md') &&
    config.documentRoots.some((base) => beneath(path, base)) &&
    ![...config.privateRoots, ...config.generatedRoots].some((base) => beneath(path, base)) &&
    !path.split('/').some((part) => /^\.env(?:\.|$)/.test(part))
  );
}

function documentShape(value: unknown): TaskDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('TASK_DOCUMENT_SCHEMA: expected an entry');
  const entry = value as TaskDocument;
  if (
    Object.keys(entry).some((key) => !['identity', 'kind', 'path', 'aliases'].includes(key)) ||
    typeof entry.identity !== 'string' ||
    typeof entry.path !== 'string' ||
    !['prd', 'design', 'proposal', 'change'].includes(entry.kind) ||
    (entry.aliases !== undefined &&
      (!Array.isArray(entry.aliases) || entry.aliases.some((path) => typeof path !== 'string')))
  )
    throw new Error('TASK_DOCUMENT_SCHEMA: identity, kind, path and optional aliases required');
  if (new Set(entry.aliases).size !== (entry.aliases ?? []).length)
    throw new Error(`TASK_DOCUMENT_DUPLICATE: aliases for ${entry.identity}`);
  if (
    !beneath(entry.path, 'docs/tasks') ||
    resultDocument(entry.path) ||
    taskNavigation(entry.path)
  )
    throw new Error(`TASK_DOCUMENT_LOCATION: ${entry.path}`);
  return entry;
}

/** Compatibility pages contain navigation only; task prose belongs at the current path. */
function redirectOnly(source: string, alias: string, entry: TaskDocument, paths: Set<string>) {
  const tree = parseMarkdown(source);
  const [title, ...body] = tree.children ?? [];
  if (title?.type !== 'heading' || title.depth !== 1 || nodeText(title) !== '资料已迁移')
    return false;
  const navigation = (node: MarkdownNode): boolean => {
    if (['link', 'linkReference', 'definition'].includes(node.type)) return true;
    if (node.type === 'text') return !node.value?.trim();
    if (node.type === 'html') return /^(?:<a id="[^"<>]+">|<\/a>)$/.test(node.value ?? '');
    return (
      ['paragraph', 'list', 'listItem'].includes(node.type) && !!node.children?.every(navigation)
    );
  };
  try {
    const { links, destinations } = markdownLinks(tree);
    const targetPath = (url: string) => {
      const target = decodeURIComponent(url.split('#')[0]?.split('?')[0] ?? '');
      return relative('.', resolve(dirname(alias), target)).replaceAll('\\', '/');
    };
    return (
      body.every(navigation) &&
      links[0] !== undefined &&
      targetPath(links[0]) === entry.path &&
      [...links, ...destinations].every((url) => paths.has(targetPath(url)))
    );
  } catch {
    return false;
  }
}

/** Discover one local registry per PRD while retaining global identity and ownership checks. */
export async function inspectTaskDocuments(root: string, config: HarnessConfig) {
  const documents: RegisteredTaskDocument[] = [];
  const registries: string[] = [];
  const errors: string[] = [];
  const claimed = new Set<string>();
  if ('taskDocuments' in config)
    errors.push('TASK_DOCUMENT_SCHEMA: taskDocuments is retired; use each PRD documents.json');
  const directory = await checkedPath(root, 'docs/tasks');
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return [];
    },
  );
  for (const child of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!child.isDirectory() && !child.isSymbolicLink()) continue;
    const registry = `docs/tasks/${child.name}/documents.json`;
    let values: unknown[];
    try {
      const target = await checkedPath(root, registry);
      const source = await readFile(target, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (source === null) continue;
      registries.push(registry);
      const value = JSON.parse(source);
      if (
        !/^[a-z0-9][a-z0-9_-]*$/.test(child.name) ||
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => !['version', 'documents'].includes(key)) ||
        value.version !== 1 ||
        !Array.isArray(value.documents) ||
        !value.documents.length
      )
        throw new Error('TASK_DOCUMENT_SCHEMA: expected version 1 and nonempty documents array');
      values = value.documents;
    } catch (error) {
      errors.push(
        `TASK_DOCUMENT_INVALID: ${registry}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const local: RegisteredTaskDocument[] = [];
    for (const value of values) {
      try {
        const entry = documentShape(value);
        if (!beneath(entry.path, dirname(registry)))
          throw new Error(
            `TASK_DOCUMENT_OWNER: ${entry.path}: must belong to ${dirname(registry)}`,
          );
        const files = new Set([entry.path, ...(entry.aliases ?? [])]);
        for (const path of new Set([entry.identity, ...files])) {
          if (claimed.has(path)) throw new Error(`TASK_DOCUMENT_DUPLICATE: ${path}`);
          claimed.add(path);
          if (!publicDocument(path, config) || resultDocument(path) || taskNavigation(path))
            throw new Error(`TASK_DOCUMENT_PUBLIC: ${path}`);
          const target = await checkedPath(root, path);
          // Stable identities remain resolvable after optional navigation pages are retired.
          const file = await stat(target).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
          if (files.has(path) && !file?.isFile()) throw new Error(`TASK_DOCUMENT_FILE: ${path}`);
          if (!files.has(path) && file)
            throw new Error(
              `TASK_DOCUMENT_IDENTITY: existing ${path} must be the current path or a declared alias`,
            );
        }
        if (entry.aliases?.includes(entry.path))
          throw new Error(`TASK_DOCUMENT_DUPLICATE: current path is also an alias ${entry.path}`);
        local.push({ ...entry, registry });
      } catch (error) {
        errors.push(
          `TASK_DOCUMENT_INVALID: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (local.filter((entry) => entry.kind === 'prd').length !== 1)
      errors.push(`TASK_DOCUMENT_OWNER: ${registry}: require exactly one PRD`);
    documents.push(...local);
  }
  const paths = new Set(documents.map((entry) => entry.path));
  const owners = new Set<string>();
  for (const entry of documents.filter((item) => item.kind === 'prd')) {
    try {
      const directory = prdDirectory(entry.path);
      if (owners.has(directory)) throw new Error(`TASK_DOCUMENT_DUPLICATE: ${directory}`);
      owners.add(directory);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const entry of documents.filter((item) => item.kind !== 'prd')) {
    const directory = entry.path.split('/').slice(0, 3).join('/');
    if (
      !owners.has(directory) ||
      (beneath(entry.path, `${directory}/pending`) && entry.kind !== 'proposal')
    )
      errors.push(
        `TASK_DOCUMENT_OWNER: ${entry.path}: require its PRD directory and classify pending as proposal`,
      );
    if (beneath(entry.path, `${directory}/changes`)) {
      const match =
        /^docs\/tasks\/[a-z0-9][a-z0-9_-]*\/changes\/([a-z0-9][a-z0-9_-]{0,79})\/design\.md$/.exec(
          entry.path,
        );
      if (
        entry.kind !== 'change' &&
        !(
          entry.kind === 'design' &&
          match &&
          documents.some(
            (item) =>
              item.kind === 'change' && item.path === `${directory}/changes/${match[1]}/change.md`,
          )
        )
      )
        errors.push(`TASK_CHANGE_OWNER: ${entry.path}`);
    } else if (entry.kind === 'change') errors.push(`TASK_CHANGE_LOCATION: ${entry.path}`);
  }
  for (const parent of documents.filter((entry) => entry.kind === 'prd')) {
    try {
      await readChanges(root, documents, parent.path);
    } catch (error) {
      errors.push(`TASK_CHANGE_INVALID: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const entry of documents) {
    for (const alias of entry.aliases ?? []) {
      const source = await readFile(await checkedPath(root, alias), 'utf8');
      if (!redirectOnly(source, alias, entry, paths))
        errors.push(`TASK_DOCUMENT_REDIRECT: ${alias}: retain short navigation only`);
    }
  }
  return { documents, registries, errors };
}

export async function documentCatalog(root: string, config?: HarnessConfig) {
  const current = config ?? (await loadConfig(root));
  const registry = await inspectTaskDocuments(root, current);
  if (registry.errors.length) throw new Error(registry.errors.join('\n'));
  return { config: current, documents: registry.documents, registries: registry.registries };
}

/** New requests normalize identities. Historical parsers and accepted manifests never call this. */
export function resolveDocument(
  path: string,
  catalog: Awaited<ReturnType<typeof documentCatalog>>,
) {
  if (
    [...catalog.config.privateRoots, ...catalog.config.generatedRoots].some((base) =>
      beneath(path, base),
    ) ||
    path.split('/').some((part) => /^\.env(?:\.|$)/.test(part))
  )
    throw new Error(`WORK_PRIVATE: ${path}`);
  const entry = catalog.documents.find(
    (item) => item.identity === path || item.path === path || item.aliases?.includes(path),
  );
  if (entry) return { ...entry, currentPath: entry.path };
  if (
    !publicDocument(path, catalog.config) ||
    (beneath(path, 'docs/tasks') && !taskNavigation(path) && !resultDocument(path))
  )
    throw new Error(`WORK_SOURCE: name a classified public Markdown file: ${path}`);
  return { identity: path, currentPath: path, aliases: [] as string[], kind: undefined };
}

export function resolvePrd(path: string, catalog: Awaited<ReturnType<typeof documentCatalog>>) {
  const resolved = resolveDocument(path, catalog);
  if (resolved.kind !== 'prd')
    throw new Error('WORK_RESULT: result.prd must identify a registered PRD');
  return resolved.identity;
}

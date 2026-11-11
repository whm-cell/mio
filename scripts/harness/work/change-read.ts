import { lstat, readFile, writeFile } from 'node:fs/promises';
import { changeIndexPath, readChanges, renderChangeIndex } from '../task-changes.ts';
import { documentCatalog, resolveDocument, resolvePrd } from '../task-documents.ts';
import { checkedPath } from './records.ts';
import { readPage } from './output.ts';
import { readOptions } from './read-options.ts';

/** Read one PRD's cards, or regenerate only its fixed navigation file during implementation. */
export async function changeCommand(root: string, args: string[]) {
  const writes = args.filter((arg) => arg === '--write-index').length;
  if (writes > 1) throw new Error('WORK_CHANGES: provide --write-index at most once');
  const rest = args.filter((arg) => arg !== '--write-index');
  const { positionals, options } = readOptions(rest);
  if (positionals.length < 1 || positionals.length > 2)
    throw new Error('WORK_CHANGES: use changes <prd> [key] or changes <prd> --write-index');
  if (writes && (positionals.length !== 1 || rest.length !== 1))
    throw new Error('WORK_CHANGES: --write-index does not accept a key or read options');
  const catalog = await documentCatalog(root);
  const prd = resolvePrd(positionals[0]!, catalog);
  const prdPath = resolveDocument(prd, catalog).currentPath;
  const changes = await readChanges(root, catalog.documents, prdPath);
  if (writes) {
    if (!changes.length) throw new Error('WORK_CHANGES_EMPTY: no registered changes');
    const index = changeIndexPath(prdPath);
    const target = await checkedPath(root, index);
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (existing && (!existing.isFile() || existing.nlink !== 1))
      throw new Error('WORK_CHANGES_INDEX: output must be an independent regular file');
    const before = existing ? await readFile(target, 'utf8') : null;
    const after = await renderChangeIndex(changes);
    if (before !== after) await writeFile(target, after, 'utf8');
    return { prd, index, changed: before !== after, count: changes.length };
  }
  const command = ['changes', positionals[0]!];
  const key = positionals[1];
  if (key === undefined) {
    const summaries = changes.map(({ id, type, title, section, path }) => ({
      id,
      type,
      title,
      section,
      path,
      read: [...command, id],
    }));
    return readPage(
      { prd, changes: summaries },
      { ...options, select: options.select || '/changes' },
      command,
    );
  }
  const entry = changes.find((item) => item.id === key);
  if (!entry) throw new Error('WORK_CHANGES: change key not found');
  const { body, ...summary } = entry;
  return readPage({ summary, body }, { ...options, select: options.select || '/body' }, [
    ...command,
    key,
  ]);
}

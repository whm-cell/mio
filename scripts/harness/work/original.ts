import { lstat, readFile } from 'node:fs/promises';
import { beneath } from '../inventory.ts';
import { documentCatalog, resolveDocument } from '../task-documents.ts';
import { checkedPath } from './records.ts';

export async function artifact(root: string, id: string, path: string): Promise<Buffer> {
  if (
    !beneath(path, `.work/tasks/${id}/evidence`) &&
    !(path.startsWith('docs/') && path.endsWith('.md'))
  )
    throw new Error("WORK_ARTIFACT: use this task's evidence directory or a shared document");
  if (path.startsWith('docs/tasks/')) resolveDocument(path, await documentCatalog(root));
  const stat = await lstat(await checkedPath(root, path));
  if (!stat.isFile() || stat.nlink !== 1)
    throw new Error('WORK_ARTIFACT: original must be a regular file with no hard-link aliases');
  return readFile(await checkedPath(root, path));
}

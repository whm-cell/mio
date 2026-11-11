import { readFile, rm, writeFile } from 'node:fs/promises';
import { checkedPath, digest, identifier, json } from './records.ts';

const location = (id: string) => `.work/tasks/${identifier(id)}/conflict.json`;

/** Keep only the unresolved conflict, not a second copy of the plan or progress. */
export async function readConflict(root: string, id: string): Promise<string | null> {
  try {
    return await readFile(await checkedPath(root, location(id)), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
}

export async function recordConflict(root: string, id: string, command: string, message: string) {
  const raw = await readFile(await checkedPath(root, `.work/tasks/${identifier(id)}/state.json`));
  try {
    await writeFile(
      await checkedPath(root, location(id)),
      json({ command, revision: digest(raw), observed: new Date().toISOString(), message }),
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    // Repeated stale requests do not replace the original unresolved fact.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/** Only call after a reconciled update has saved the current record and preserved the fact in notes. */
export async function clearConflict(root: string, id: string) {
  await rm(await checkedPath(root, location(id)));
}

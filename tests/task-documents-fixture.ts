import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TaskDocument } from '../scripts/harness/inventory.ts';

export const taskIndexPath = 'docs/tasks/index.md';
export const taskIndex = '# Task documents and results\n\n[PRD directories](./)\n';

export function taskDocumentFiles(documents: TaskDocument[]) {
  const groups = new Map<string, TaskDocument[]>();
  for (const entry of documents) {
    const directory = entry.path.split('/').slice(0, 3).join('/');
    const entries = groups.get(directory) ?? [];
    entries.push(entry);
    groups.set(directory, entries);
  }
  return Object.fromEntries(
    [...groups].map(([directory, entries]) => [
      `${directory}/documents.json`,
      JSON.stringify({ version: 1, documents: entries }),
    ]),
  );
}

/** Replace only temporary fixture registries, preserving their task prose and result files. */
export async function writeTaskDocuments(
  root: string,
  documents: TaskDocument[],
  directory?: string,
) {
  if (!directory) {
    const children = await readdir(join(root, 'docs/tasks'), { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return [];
      },
    );
    for (const child of children.filter((entry) => entry.isDirectory()))
      await rm(join(root, 'docs/tasks', child.name, 'documents.json'), { force: true });
  }
  const files = directory
    ? { [`${directory}/documents.json`]: JSON.stringify({ version: 1, documents }) }
    : taskDocumentFiles(documents);
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
}

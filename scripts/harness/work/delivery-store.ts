import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { checkedPath, digest, json } from './records.ts';
import { optionalText } from './report-format.ts';

/** Serialize publication to a PRD, independently of the per-task lock. */
export async function withPublication<T>(root: string, records: string, action: () => Promise<T>) {
  const directory = await checkedPath(root, '.work/publication');
  await mkdir(directory, { recursive: true });
  const path = await checkedPath(root, `.work/publication/${digest(records)}.lock`);
  let lock;
  try {
    lock = await open(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error(
      `WORK_PUBLISH_BUSY: inspect the active or interrupted publication lock ${path}`,
    );
  }
  try {
    await lock.writeFile(json({ pid: process.pid, records }));
    return await action();
  } finally {
    await lock.close();
    await rm(path, { force: true });
  }
}

/** Compare immediately before the atomic rename; never overwrite an intervening edit. */
export async function replacePublication(
  root: string,
  path: string,
  expected: string | null,
  content: string,
) {
  const target = await checkedPath(root, path);
  const current = await optionalText(root, path);
  if (current === content) return;
  if (current !== expected) throw new Error(`WORK_DELIVERY_CONFLICT: ${path}`);
  await mkdir(dirname(target), { recursive: true });
  const temporary = await checkedPath(root, `.work/publication/${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    if ((await optionalText(root, path)) !== expected)
      throw new Error(`WORK_DELIVERY_CONFLICT: ${path}`);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

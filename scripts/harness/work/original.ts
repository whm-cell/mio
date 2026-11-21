import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { beneath } from '../inventory.ts';
import { documentCatalog, resolveDocument } from '../task-documents.ts';
import { checkedPath } from './records.ts';

function requireOriginal(stat: Stats) {
  if (!stat.isFile() || stat.nlink !== 1)
    throw new Error('WORK_ARTIFACT: original must be a regular file with no hard-link aliases');
}

/** Use one validated descriptor for all reads of the bound original. */
export async function withArtifact<T>(
  root: string,
  id: string,
  path: string,
  read: (file: FileHandle, stat: Stats) => Promise<T>,
): Promise<T> {
  if (
    !beneath(path, `.work/tasks/${id}/evidence`) &&
    !(path.startsWith('docs/') && path.endsWith('.md'))
  )
    throw new Error("WORK_ARTIFACT: use this task's evidence directory or a shared document");
  if (path.startsWith('docs/tasks/')) resolveDocument(path, await documentCatalog(root));
  const expected = await lstat(await checkedPath(root, path));
  requireOriginal(expected);
  const file = await open(
    await checkedPath(root, path),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    requireOriginal(stat);
    if (stat.dev !== expected.dev || stat.ino !== expected.ino)
      throw new Error('WORK_ARTIFACT: original changed while opening');
    return await read(file, stat);
  } finally {
    await file.close();
  }
}

export function artifact(root: string, id: string, path: string): Promise<Buffer> {
  return withArtifact(root, id, path, (file) => file.readFile());
}

/** Each view is consumed before advancing, since subsequent reads reuse the buffer. */
export async function* originalChunks(file: FileHandle, start: number, end: number) {
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, end - start));
  let position = start;
  while (position < end) {
    const { bytesRead } = await file.read(
      buffer,
      0,
      Math.min(buffer.length, end - position),
      position,
    );
    if (!bytesRead) throw new Error('WORK_ARTIFACT: original truncated while reading');
    yield buffer.subarray(0, bytesRead);
    position += bytesRead;
  }
}

export async function originalDigest(
  file: FileHandle,
  size: number,
  visit?: (bytes: Buffer, offset: number) => void,
) {
  const hash = createHash('sha256');
  let offset = 0;
  for await (const chunk of originalChunks(file, 0, size)) {
    hash.update(chunk);
    visit?.(chunk, offset);
    offset += chunk.length;
  }
  return hash.digest('hex');
}

import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Called only after the owning conversation instance has drained this session's native writers. */
export async function purgeNativeSession(
  roots: readonly string[],
  id: string,
  signal: AbortSignal,
) {
  if (!id || id === '.' || id === '..' || id.includes('/') || id.includes('\\'))
    throw new Error('SESSION_DELETION_ID_INVALID');
  let encoded = '';
  for (let index = 0; index < id.length; index++) {
    const unit = id.charCodeAt(index),
      character = String.fromCharCode(unit);
    encoded += /^[A-Za-z0-9._-]$/.test(character)
      ? character
      : '~' + unit.toString(16).toUpperCase().padStart(4, '0');
  }
  for (const root of roots) {
    const projects = await readdir(root, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    for (const project of projects) {
      signal.throwIfAborted();
      if (!project.isDirectory()) continue;
      // Both native generation directories and the historical flat JSONL layout are session-owned.
      for (const name of [encoded, encoded + '.jsonl', encoded + '.jsonl.zstd']) {
        await rm(join(root, project.name, name), { recursive: true, force: true });
        signal.throwIfAborted();
      }
    }
  }
}

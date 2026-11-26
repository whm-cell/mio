import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { vi } from 'vitest';

export async function observeDirectorySync(directory: string, beforeSync: () => Promise<void>) {
  const handle = await open(directory, 'r');
  const { ino, dev } = await handle.stat();
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  await handle.close();
  const sync = prototype.sync;
  return vi.spyOn(prototype, 'sync').mockImplementation(async function (this: FileHandle) {
    const current = await this.stat();
    if (current.ino === ino && current.dev === dev) await beforeSync();
    await sync.call(this);
  });
}

import { createHash } from 'node:crypto';
import {
  constants,
  createReadStream,
  openSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  statfsSync,
} from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { isUuidV4 } from '@mio/foundation/identifiers';
import type { MediaDigest } from './media-journal.ts';

export const MEDIA_FILE_LIMIT = 1024 ** 3;
export const MEDIA_TEXT_LIMIT = 2 * 1024 ** 2;
const DIRECTORY_LIMIT = 10 * 1024 ** 3;
const FREE_RESERVE = 2 * 1024 ** 3;
export function mediaName(name: string): string {
  if (
    name.length > 240 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(name) ||
    name.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))
  )
    throw new Error('MEDIA_PATH_INVALID');
  return name;
}
function usage(directory: string): number {
  let size = 0,
    count = 0;
  const directories = [directory];
  while (directories.length) {
    const parent = directories.pop()!;
    for (const entry of readdirSync(parent)) {
      const child = join(parent, entry);
      const info = lstatSync(child);
      if (++count > 32768 || info.isSymbolicLink()) throw new Error('MEDIA_DIRECTORY_INVALID');
      if (info.isDirectory()) directories.push(child);
      else {
        if (!info.isFile()) throw new Error('MEDIA_DIRECTORY_INVALID');
        size += info.size;
      }
    }
  }
  return size;
}
function mediaSpace(directory: string, reserve = 0): void {
  const info = statfsSync(directory);
  if (
    usage(directory) + reserve > DIRECTORY_LIMIT ||
    info.bavail * info.bsize - reserve < FREE_RESERVE
  )
    throw new Error('DISK_FULL');
}

/** All local names are resolved here, including names embedded in FFmpeg filters. */
export class MediaFiles {
  readonly root: string;
  readonly directory: string;
  constructor(root: string, attemptId: string) {
    if (!isUuidV4(attemptId)) throw new Error('MEDIA_PATH_INVALID');
    this.root = resolve(root);
    const rootInfo = lstatSync(this.root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
      throw new Error('MEDIA_DIRECTORY_INVALID');
    this.directory = join(this.root, `media-${attemptId}`);
    try {
      mkdirSync(this.directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    this.#directory(this.directory);
  }
  #directory(path: string): void {
    const info = lstatSync(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error('MEDIA_DIRECTORY_INVALID');
  }
  path(name: string, createParents = false): string {
    mediaName(name);
    const parts = name.split('/');
    let parent = this.directory;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      if (createParents) {
        try {
          mkdirSync(parent, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      this.#directory(parent);
    }
    const path = join(this.directory, name);
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw new Error('MEDIA_PATH_INVALID');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return path;
  }
  checkSpace(reserve = 0): void {
    mediaSpace(this.root, reserve);
  }
  checkLimits(): void {
    this.checkSpace();
    const directories = [this.directory];
    while (directories.length) {
      const parent = directories.pop()!;
      for (const entry of readdirSync(parent)) {
        const path = join(parent, entry),
          info = lstatSync(path);
        if (info.isSymbolicLink()) throw new Error('MEDIA_PATH_INVALID');
        if (info.isDirectory()) directories.push(path);
        else if (!info.isFile() || info.size > MEDIA_FILE_LIMIT) throw new Error('OUTPUT_INVALID');
      }
    }
  }
  async digest(name: string, signal: AbortSignal): Promise<MediaDigest> {
    signal.throwIfAborted();
    const file = await open(this.path(name), constants.O_RDONLY | constants.O_NOFOLLOW);
    const sha256 = createHash('sha256');
    let size = 0;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > MEDIA_FILE_LIMIT)
        throw new Error('OUTPUT_INVALID');
      for await (const chunk of file.createReadStream({ autoClose: false, signal })) {
        size += (chunk as Buffer).length;
        if (size > MEDIA_FILE_LIMIT) throw new Error('OUTPUT_INVALID');
        sha256.update(chunk as Buffer);
      }
      await file.sync();
    } finally {
      await file.close();
    }
    return { size, sha256: sha256.digest('hex') };
  }
  async read(name: string, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MEDIA_TEXT_LIMIT)
      throw new Error('MEDIA_READ_LIMIT');
    const file = await open(this.path(name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maxBytes) throw new Error('MEDIA_READ_LIMIT');
      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > maxBytes) throw new Error('MEDIA_READ_LIMIT');
      return buffer.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  }
  async write(name: string, value: string | Uint8Array): Promise<void> {
    const data = typeof value === 'string' ? Buffer.from(value) : value;
    if (data.byteLength > MEDIA_TEXT_LIMIT) throw new Error('MEDIA_WRITE_LIMIT');
    this.checkSpace(data.byteLength);
    const path = this.path(name, true);
    // A replay may reuse the same immutable auxiliary file, but never replace different bytes.
    try {
      const existing = await this.read(name, MEDIA_TEXT_LIMIT);
      if (!Buffer.from(existing).equals(Buffer.from(data))) throw new Error('OUTPUT_MISMATCH');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // The attempt has one writer. A leftover temporary file was never a PUT source.
    const temporary = join(dirname(path), '.' + basename(path) + '.pending');
    await rm(temporary, { force: true });
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    await this.#syncDirectory(dirname(path));
  }
  /** Copies only a previously committed checkpoint, verifying both sides before reuse. */
  async reuse(
    source: MediaFiles,
    name: string,
    expected: MediaDigest,
    signal: AbortSignal,
  ): Promise<void> {
    const original = await source.digest(name, signal).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('OUTPUT_MISMATCH');
      throw error;
    });
    if (original.size !== expected.size || original.sha256 !== expected.sha256)
      throw new Error('OUTPUT_MISMATCH');
    try {
      const existing = await this.digest(name, signal);
      if (existing.size !== expected.size || existing.sha256 !== expected.sha256)
        throw new Error('OUTPUT_MISMATCH');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await this.receive(name, source.stream(name), expected.size, signal);
    const copied = await this.digest(name, signal);
    if (copied.size !== expected.size || copied.sha256 !== expected.sha256)
      throw new Error('OUTPUT_MISMATCH');
  }
  async receive(
    name: string,
    source: Readable,
    expectedSize: number,
    signal: AbortSignal,
  ): Promise<void> {
    // The source may already be connected when local admission or open fails.
    source.on('error', () => {});
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let received = 0;
    let checkedAt = 0;
    const abort = () => source.destroy(new Error('EXECUTION_TIMEOUT'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      if (
        !Number.isSafeInteger(expectedSize) ||
        expectedSize < 1 ||
        expectedSize > MEDIA_FILE_LIMIT
      )
        throw new Error('INPUT_TOO_LARGE');
      this.checkSpace(expectedSize);
      const path = this.path(name, true);
      file = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      for await (const chunk of source) {
        signal.throwIfAborted();
        const data = Buffer.from(chunk as Uint8Array);
        received += data.length;
        if (received > expectedSize) throw new Error('INPUT_TOO_LARGE');
        if (received - checkedAt >= 8 * 1024 ** 2) {
          this.checkSpace(expectedSize - received + data.length);
          checkedAt = received;
        }
        await file.writeFile(data);
      }
      if (received !== expectedSize) throw new Error('INPUT_CHANGED');
      this.checkSpace();
      await file.sync();
      await this.#syncDirectory(dirname(path));
    } finally {
      signal.removeEventListener('abort', abort);
      source.destroy();
      await file?.close();
    }
  }
  stream(name: string): Readable {
    const path = this.path(name);
    return createReadStream(path, {
      fd: openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW),
      autoClose: true,
    });
  }
  async #syncDirectory(path: string): Promise<void> {
    const file = await open(path, constants.O_RDONLY);
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }
  async clean(): Promise<void> {
    await rm(this.directory, { recursive: true });
  }
}

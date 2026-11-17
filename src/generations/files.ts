import { createHash } from 'node:crypto';
import { createId, isUuidV4 } from '@mio/foundation/identifiers';
import { mkdir, open, readFile, rename, statfs, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { CheckpointRef, ImageCheckpoint, SavedImage } from './execution.ts';
import { GenerationError } from './errors.ts';
import { HTTP_STATUS } from '@mio/foundation/http-status';

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function syncDirectory(directory: string): Promise<void> {
  const file = await open(directory, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function durableWrite(path: string, bytes: Uint8Array): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Raw bytes and a credential-free receipt are durable before PG points at them. */
export class GenerationFiles {
  private readonly root: string;
  storageFailed = false;

  constructor(directory: string) {
    this.root = resolve(directory);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.admit();
  }

  async admit(): Promise<void> {
    try {
      if (this.storageFailed) throw new Error('GENERATION_STORAGE_FAILED');
      const disk = await statfs(this.root, { bigint: true });
      if (disk.bavail * disk.bsize <= 0n) throw new Error('GENERATION_DISK_FULL');
      const probe = join(this.root, '.write-' + createId());
      await durableWrite(probe, Buffer.from('generation'));
      await unlink(probe);
      await syncDirectory(this.root);
    } catch {
      throw new GenerationError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'COMPUTE_STORAGE_UNAVAILABLE');
    }
  }

  private directory(jobId: string): string {
    if (!isUuidV4(jobId)) throw new Error('IMAGE_CHECKPOINT_INVALID');
    return join(this.root, jobId);
  }

  private path(jobId: string, file: string): string {
    const directory = this.directory(jobId);
    const path = resolve(this.root, file);
    if (!path.startsWith(directory + sep)) throw new Error('IMAGE_CHECKPOINT_INVALID');
    return path;
  }

  async save(checkpoint: ImageCheckpoint): Promise<CheckpointRef> {
    try {
      const directory = this.directory(checkpoint.jobId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await syncDirectory(this.root);
      const revision = checkpoint.revision + 1;
      const bytes = Buffer.from(JSON.stringify({ ...checkpoint, revision }));
      const temporary = join(directory, 'receipt-' + createId() + '.tmp');
      await durableWrite(temporary, bytes);
      await rename(temporary, join(directory, 'receipt.json'));
      await syncDirectory(directory);
      checkpoint.revision = revision;
      return {
        file: join(checkpoint.jobId, 'receipt.json'),
        sha256: digest(bytes),
        revision,
      };
    } catch (error) {
      this.storageFailed = true;
      throw error;
    }
  }

  async receive(
    jobId: string,
    commandId: string,
    expectedCount: number,
    images: ({ base64: string; format?: 'png' | 'jpeg' | 'webp' } | null)[],
    defaultFormat: 'png' | 'jpeg' | 'webp',
  ): Promise<{ checkpoint: ImageCheckpoint; ref: CheckpointRef }> {
    const directory = this.directory(jobId);
    const checkpoint: ImageCheckpoint = {
      version: 1,
      revision: 0,
      jobId,
      commandId,
      expectedCount,
      receivedAll: false,
      images: [],
      invalidIndices: [],
      outputs: {},
      attemptedKeys: {},
      attempts: 0,
      lastRecoverySequence: 0,
    };
    let ref: CheckpointRef;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await syncDirectory(this.root);
      ref = await this.save(checkpoint);
    } catch (error) {
      this.storageFailed = true;
      throw error;
    }
    try {
      for (let index = 0; index < expectedCount; index++) {
        const image = images[index];
        if (!image) checkpoint.invalidIndices.push(index);
        else {
          const bytes = Buffer.from(image.base64, 'base64');
          const format = image.format ?? defaultFormat;
          const file = join(jobId, index + '-' + createId() + '.' + format);
          await durableWrite(this.path(jobId, file), bytes);
          await syncDirectory(directory);
          checkpoint.images.push({
            index,
            file,
            format,
            sizeBytes: bytes.length,
            sha256: digest(bytes),
          });
        }
        ref = await this.save(checkpoint);
      }
      checkpoint.receivedAll = true;
      ref = await this.save(checkpoint);
      return { checkpoint, ref };
    } catch {
      this.storageFailed = true;
      // The last durable receipt still describes every confirmed file.
      return (await this.load(jobId, commandId, expectedCount))!;
    }
  }

  async load(
    jobId: string,
    commandId: string,
    expectedCount: number,
    expected?: CheckpointRef | null,
  ): Promise<{ checkpoint: ImageCheckpoint; ref: CheckpointRef } | undefined> {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(this.directory(jobId), 'receipt.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const value = JSON.parse(bytes.toString('utf8')) as ImageCheckpoint;
    const sha256 = digest(bytes);
    if (
      value.version !== 1 ||
      value.jobId !== jobId ||
      value.commandId !== commandId ||
      value.expectedCount !== expectedCount ||
      !Number.isSafeInteger(value.revision) ||
      !Array.isArray(value.images) ||
      !Array.isArray(value.invalidIndices) ||
      typeof value.outputs !== 'object' ||
      value.outputs === null ||
      typeof value.attemptedKeys !== 'object' ||
      value.attemptedKeys === null ||
      !Number.isSafeInteger(value.attempts) ||
      !Number.isSafeInteger(value.lastRecoverySequence) ||
      typeof value.receivedAll !== 'boolean' ||
      (expected &&
        (value.revision < expected.revision ||
          (value.revision === expected.revision && sha256 !== expected.sha256)))
    )
      throw new Error('IMAGE_CHECKPOINT_INVALID');
    const indices = new Set<number>();
    for (const image of value.images) {
      if (
        !Number.isSafeInteger(image.index) ||
        image.index < 0 ||
        image.index >= expectedCount ||
        indices.has(image.index) ||
        !['png', 'jpeg', 'webp'].includes(image.format) ||
        !Number.isSafeInteger(image.sizeBytes) ||
        image.sizeBytes < 1 ||
        !/^[a-f0-9]{64}$/.test(image.sha256)
      )
        throw new Error('IMAGE_CHECKPOINT_INVALID');
      this.path(jobId, image.file);
      indices.add(image.index);
    }
    return {
      checkpoint: value,
      ref: { file: join(jobId, 'receipt.json'), sha256, revision: value.revision },
    };
  }

  async read(jobId: string, image: SavedImage): Promise<Buffer> {
    const bytes = await readFile(this.path(jobId, image.file));
    if (bytes.length !== image.sizeBytes || digest(bytes) !== image.sha256)
      throw new Error('IMAGE_CHECKPOINT_INVALID');
    return bytes;
  }

  async clean(checkpoint: ImageCheckpoint): Promise<void> {
    for (const image of checkpoint.images)
      await unlink(this.path(checkpoint.jobId, image.file)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        },
      );
    await syncDirectory(this.directory(checkpoint.jobId));
  }
}

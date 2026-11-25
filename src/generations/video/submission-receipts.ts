import { constants } from 'node:fs';
import type { Dir } from 'node:fs';
import { access, link, lstat, mkdir, open, opendir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createId, isUuidV4 } from '@mio/foundation/identifiers';
import { createLogger } from '@mio/foundation/logging';
import { epochMs } from '@mio/foundation/time';
import { isVideoUpstreamTaskId, VIDEO_EXECUTOR_MAX_AGE_SECONDS } from './execution.ts';
import type { VideoSubmissionDisposition, VideoSubmissionReceipt } from './execution.ts';

const log = createLogger('app', 'video-submissions');
const REPLAY_BATCH_SIZE = 8;
const MAX_RECEIPT_BYTES = 4096;

type ReceiveSubmission = (
  receipt: VideoSubmissionReceipt,
  canReplay: boolean,
) => Promise<VideoSubmissionDisposition>;

function hasCode(error: unknown, code: string) {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

async function syncDirectory(directory: string) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeIfPresent(path: string) {
  await unlink(path).catch((error: unknown) => {
    if (!hasCode(error, 'ENOENT')) throw error;
  });
}

function isReceipt(value: unknown, jobId: string): value is VideoSubmissionReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Partial<VideoSubmissionReceipt>;
  return (
    Object.keys(receipt).length === 5 &&
    receipt.version === 1 &&
    receipt.jobId === jobId &&
    typeof receipt.requestId === 'string' &&
    isUuidV4(receipt.requestId) &&
    typeof receipt.ownerId === 'string' &&
    receipt.ownerId.length > 0 &&
    isVideoUpstreamTaskId(receipt.upstreamTaskId)
  );
}

/** Private handoff from the original paid POST to PostgreSQL. */
export class VideoSubmissionReceipts {
  private readonly dataDirectory: string;
  private readonly directory: string;
  private scan: Dir | undefined;

  constructor(dataDirectory: string) {
    this.dataDirectory = dataDirectory;
    this.directory = join(dataDirectory, 'video-submissions');
  }

  async prepare(): Promise<void> {
    await mkdir(this.directory, { mode: 0o700 }).catch((error: unknown) => {
      if (!hasCode(error, 'EEXIST')) throw error;
    });
    if (!(await this.directoryPresent())) throw new Error('VIDEO_SUBMISSION_STORAGE_UNAVAILABLE');
    await access(this.directory, constants.W_OK);
  }

  async record(receipt: VideoSubmissionReceipt, receive: ReceiveSubmission): Promise<boolean> {
    let saved: boolean;
    try {
      saved = await this.save(receipt);
    } catch {
      // The ID is still reliable. Try PostgreSQL even when the volume is unavailable.
      log.error('VIDEO_SUBMISSION_RECEIPT_UNAVAILABLE');
      return (await receive(receipt, false)) !== 'ineligible';
    }
    return saved
      ? (await this.reconcile(receipt, receive)) !== 'ineligible'
      : this.recover(receipt.jobId, receive);
  }

  private async save(receipt: VideoSubmissionReceipt): Promise<boolean> {
    const path = this.path(receipt.jobId);
    if (!isReceipt(receipt, receipt.jobId)) throw new Error('VIDEO_SUBMISSION_RECEIPT_INVALID');
    const bytes = Buffer.from(JSON.stringify(receipt));
    if (bytes.length > MAX_RECEIPT_BYTES) throw new Error('VIDEO_SUBMISSION_RECEIPT_INVALID');
    if (!(await this.directoryPresent())) throw new Error('VIDEO_SUBMISSION_STORAGE_UNAVAILABLE');
    const temporary = path + '.' + createId() + '.tmp';
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        // Publish complete bytes without replacing a receipt from an overlapping handoff.
        await link(temporary, path);
      } catch (error) {
        if (hasCode(error, 'EEXIST')) return false;
        throw error;
      }
    } finally {
      await removeIfPresent(temporary);
    }
    return true;
  }

  private async reconcile(receipt: VideoSubmissionReceipt, receive: ReceiveSubmission) {
    // Replay can observe the linked name before its publishing process syncs these directories.
    try {
      await syncDirectory(this.directory);
      await syncDirectory(this.dataDirectory);
    } catch {
      log.error('VIDEO_SUBMISSION_RECEIPT_UNAVAILABLE');
      return receive(receipt, false);
    }
    const disposition = await receive(receipt, true);
    if (disposition !== 'deferred') {
      if (disposition === 'ineligible') log.error('VIDEO_SUBMISSION_RECEIPT_INELIGIBLE');
      await removeIfPresent(this.path(receipt.jobId));
    }
    return disposition;
  }

  async recover(jobId: string, receive: ReceiveSubmission): Promise<boolean> {
    if (!(await this.directoryPresent())) return false;
    const receipt = await this.read(jobId);
    if (receipt === null) {
      log.error('VIDEO_SUBMISSION_RECEIPT_INVALID');
      await removeIfPresent(this.path(jobId));
    }
    return Boolean(receipt && (await this.reconcile(receipt, receive)) !== 'ineligible');
  }

  async replay(receive: ReceiveSubmission, stop: AbortSignal): Promise<void> {
    if (!this.scan) {
      if (!(await this.directoryPresent())) return;
      this.scan = await opendir(this.directory);
    }
    // Advance even when an older receipt has to wait for quota.
    for (let index = 0; index < REPLAY_BATCH_SIZE && !stop.aborted; index++) {
      const entry = await this.scan.read();
      if (!entry) {
        await this.close();
        return;
      }
      const jobId = entry.name.slice(0, 36);
      if (!isUuidV4(jobId)) continue;
      const receiptName = jobId + '.json';
      if (entry.name === receiptName) await this.recover(jobId, receive);
      else if (
        entry.isFile() &&
        entry.name.startsWith(receiptName + '.') &&
        entry.name.endsWith('.tmp') &&
        isUuidV4(entry.name.slice(receiptName.length + 1, -'.tmp'.length))
      ) {
        const path = join(this.directory, entry.name);
        const info = await lstat(path).catch((error: unknown) => {
          if (!hasCode(error, 'ENOENT')) throw error;
        });
        if (info && info.mtimeMs <= epochMs() - VIDEO_EXECUTOR_MAX_AGE_SECONDS * 1000)
          await removeIfPresent(path);
      }
    }
  }

  async close(): Promise<void> {
    const scan = this.scan;
    this.scan = undefined;
    await scan?.close();
  }

  private path(jobId: string) {
    if (!isUuidV4(jobId)) throw new Error('VIDEO_SUBMISSION_RECEIPT_INVALID');
    return join(this.directory, jobId + '.json');
  }

  private async directoryPresent(): Promise<boolean> {
    const info = await lstat(this.directory).catch((error: unknown) => {
      if (!hasCode(error, 'ENOENT')) throw error;
    });
    if (!info) return false;
    if (!info.isDirectory() || (info.mode & 0o077) !== 0)
      throw new Error('VIDEO_SUBMISSION_STORAGE_UNAVAILABLE');
    return true;
  }

  private async read(jobId: string): Promise<VideoSubmissionReceipt | null | undefined> {
    const file = await open(
      this.path(jobId),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((error: unknown) => {
      if (hasCode(error, 'ENOENT')) return;
      if (hasCode(error, 'ELOOP')) return null;
      throw error;
    });
    if (!file) return file;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_RECEIPT_BYTES || (info.mode & 0o077) !== 0) return null;
      const json = await file.readFile('utf8');
      try {
        const value: unknown = JSON.parse(json);
        return isReceipt(value, jobId) ? value : null;
      } catch {
        return null;
      }
    } finally {
      await file.close();
    }
  }
}

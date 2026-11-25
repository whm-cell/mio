import COS from 'cos-nodejs-sdk-v5';
import type {
  ComputeCommandV1,
  MediaInputSnapshot,
  VideoProbeCommandV1,
} from '@mio/compute-contracts';
import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';
import type { ObjectInfo } from '../types.ts';
import {
  digestStream,
  drainInput,
  drainProbeInput,
  fileDigest,
  paths,
  readOutput,
} from './media.ts';
import type { MediaFiles } from './media-files.ts';
import type { MediaDigest } from './media-journal.ts';

export interface CosConfig {
  bucket: string;
  region: string;
  secretId: string;
  secretKey: string;
  sessionToken?: string;
}

async function within<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('EXECUTION_TIMEOUT');
  let abort: () => void = () => {};
  const expired = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('EXECUTION_TIMEOUT'));
  });
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw new Error('EXECUTION_TIMEOUT');
    return await Promise.race([operation(), expired]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

const temporaryReadErrors = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

function storageReadError(error: unknown): unknown {
  const { code, statusCode } = (error ?? {}) as { code?: string; statusCode?: number };
  if (statusCode === 412) return new Error('INPUT_CHANGED', { cause: error });
  if (
    statusCode === 408 ||
    statusCode === 429 ||
    (statusCode !== undefined && statusCode >= 500 && statusCode < 600) ||
    (statusCode === undefined && temporaryReadErrors.has(code ?? ''))
  )
    return new Error('STORAGE_FAILURE', { cause: error });
  return error;
}

export class ObjectStore {
  readonly #client: COS;
  readonly #bucket: string;
  readonly #region: string;
  readonly #pendingUploads = new Map<string, Promise<void>>();

  constructor(config: CosConfig) {
    this.#bucket = config.bucket;
    this.#region = config.region;
    this.#client = new COS({
      SecretId: config.secretId,
      SecretKey: config.secretKey,
      ...(config.sessionToken ? { SecurityToken: config.sessionToken } : {}),
      Protocol: 'https:',
      FollowRedirect: false,
      Timeout: 60_000,
    });
  }

  async #waitForUpload(key: string, signal: AbortSignal): Promise<void> {
    const pending = this.#pendingUploads.get(key);
    if (pending) await within(() => pending, signal);
  }

  async download(
    command: Pick<ComputeCommandV1, 'input' | 'attemptId'>,
    directory: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw new Error('EXECUTION_TIMEOUT');
    const stream = this.#client.getObjectStream({
      Bucket: this.#bucket,
      Region: this.#region,
      Key: command.input.key,
      IfMatch: command.input.etag,
    }) as Readable;
    await drainInput(stream, directory, command.attemptId, command.input.sizeBytes, signal);
  }

  async downloadVideoProbe(
    command: VideoProbeCommandV1,
    directory: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) throw new Error('EXECUTION_TIMEOUT');
    const source = command.source;
    const actual = await this.head(source.stagingKey, signal);
    if (!actual) throw new Error('SOURCE_INVALID');
    if (
      actual.sizeBytes !== source.sizeBytes ||
      actual.etag !== source.etag ||
      (actual.sha256 !== null && actual.sha256 !== source.sha256)
    )
      throw new Error('SOURCE_CHANGED');
    const stream = this.#client.getObjectStream({
      Bucket: this.#bucket,
      Region: this.#region,
      Key: source.stagingKey,
      IfMatch: source.etag,
    }) as Readable;
    return drainProbeInput(
      stream,
      directory,
      command.messageId,
      source.sizeBytes,
      source.sha256,
      signal,
    );
  }

  async #readMedia<T>(
    key: string,
    etag: string,
    signal: AbortSignal,
    consume: (stream: Readable) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    const stream = new PassThrough();
    // Keep late SDK errors contained even when local admission or the caller has stopped.
    stream.on('error', () => {});
    stream.once('pipe', (sender: NodeJS.ReadableStream) => {
      sender.once('response', (response: { statusCode?: number }) => {
        if (response.statusCode !== 200)
          stream.destroy(
            Object.assign(new Error('MEDIA_OBJECT_RESPONSE'), {
              statusCode: response.statusCode,
            }),
          );
      });
    });
    const completed = new Promise<void>((resolve, reject) => {
      this.#client.getObject(
        { Bucket: this.#bucket, Region: this.#region, Key: key, IfMatch: etag, Output: stream },
        (error, result) => {
          if (error || result.statusCode !== 200) {
            const failure = Object.assign(new Error('MEDIA_OBJECT_RESPONSE'), {
              statusCode: error?.statusCode ?? result?.statusCode,
              code: error?.code,
            });
            stream.destroy(failure);
            reject(failure);
          } else resolve();
        },
      );
    });
    void completed.catch(() => {});
    try {
      const value = await consume(stream);
      await within(() => completed, signal);
      return value;
    } catch (error) {
      throw storageReadError(error);
    } finally {
      stream.destroy();
    }
  }

  downloadMedia(
    input: MediaInputSnapshot,
    files: MediaFiles,
    name: string,
    signal: AbortSignal,
  ): Promise<void> {
    return this.#readMedia(input.key, input.etag, signal, (stream) =>
      files.receive(name, stream, input.sizeBytes, signal),
    );
  }

  async headMedia(key: string, signal: AbortSignal): Promise<ObjectInfo | null> {
    try {
      return await this.head(key, signal);
    } catch (error) {
      throw storageReadError(error);
    }
  }

  async verifyMedia(
    key: string,
    etag: string,
    expectedSize: number,
    expectedSha256: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      const actual = await this.#readMedia(key, etag, signal, (stream) =>
        digestStream(stream, expectedSize, signal),
      );
      return actual.size === expectedSize && actual.sha256 === expectedSha256;
    } catch (error) {
      if (error instanceof Error && ['INPUT_CHANGED', 'OBJECT_TOO_LARGE'].includes(error.message))
        return false;
      throw error;
    }
  }

  async head(key: string, signal: AbortSignal): Promise<ObjectInfo | null> {
    try {
      await this.#waitForUpload(key, signal);
      const result = await within(
        () => this.#client.headObject({ Bucket: this.#bucket, Region: this.#region, Key: key }),
        signal,
      );
      const size = Number(result.headers?.['content-length']);
      const sha256 = result.headers?.['x-cos-meta-sha256'];
      if (!Number.isSafeInteger(size) || size <= 0 || !result.ETag)
        throw new Error('OBJECT_HEAD_INVALID');
      return {
        sizeBytes: size,
        etag: result.ETag,
        sha256: typeof sha256 === 'string' ? sha256 : null,
      };
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return null;
      throw error;
    }
  }

  async verify(
    key: string,
    expectedSize: number,
    expectedSha256: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) throw new Error('EXECUTION_TIMEOUT');
    const stream = this.#client.getObjectStream({
      Bucket: this.#bucket,
      Region: this.#region,
      Key: key,
    }) as Readable;
    const actual = await digestStream(stream, expectedSize, signal);
    return actual.size === expectedSize && actual.sha256 === expectedSha256;
  }

  async upload(
    key: string,
    directory: string,
    attemptId: string,
    size: number,
    sha256: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#waitForUpload(key, signal);
    const actual = await fileDigest(paths(directory, attemptId).output, signal);
    if (actual.size !== size || actual.sha256 !== sha256) throw new Error('OUTPUT_MISMATCH');
    if (signal.aborted) throw new Error('UPLOAD_UNKNOWN');
    await this.#put(key, readOutput(directory, attemptId), actual, 'video/mp4', signal);
  }

  async uploadMedia(
    key: string,
    files: MediaFiles,
    name: string,
    digest: MediaDigest,
    contentType: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#waitForUpload(key, signal);
    const actual = await fileDigest(files.path(name), signal);
    if (actual.size !== digest.size || actual.sha256 !== digest.sha256)
      throw new Error('OUTPUT_MISMATCH');
    signal.throwIfAborted();
    try {
      await this.#put(key, files.stream(name), actual, contentType, signal, 'private');
    } catch (error) {
      const status = (error as { statusCode?: number } | undefined)?.statusCode;
      if ([400, 401, 403, 404].includes(status ?? 0))
        throw new Error('STORAGE_WRITE_REJECTED', { cause: error });
      throw error;
    }
  }

  async #put(
    key: string,
    body: Readable,
    digest: MediaDigest & { md5: string },
    contentType: string,
    signal: AbortSignal,
    acl?: 'private',
  ): Promise<void> {
    const abort = () => body.destroy();
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) throw new Error('UPLOAD_UNKNOWN');
      const request = this.#client.putObject({
        Bucket: this.#bucket,
        Region: this.#region,
        Key: key,
        Body: body,
        ContentLength: digest.size,
        ContentType: contentType,
        'x-cos-meta-sha256': digest.sha256,
        ...(acl ? { ACL: acl } : {}),
        Headers: { 'x-cos-forbid-overwrite': 'true', 'Content-MD5': digest.md5 },
      });
      const settled = request.then(
        () => {},
        () => {},
      );
      this.#pendingUploads.set(key, settled);
      void settled.then(() => {
        if (this.#pendingUploads.get(key) === settled) this.#pendingUploads.delete(key);
      });
      await within(() => request, signal);
    } finally {
      signal.removeEventListener('abort', abort);
      body.destroy();
    }
  }
}

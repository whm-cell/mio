import COS from 'cos-nodejs-sdk-v5';
import type { ComputeCommandV1 } from '@mio/compute-contracts';
import type { Readable } from 'node:stream';
import type { ObjectInfo } from '../types.ts';
import { digestStream, drainInput, fileDigest, paths, readOutput } from './media.ts';

export interface CosConfig {
  bucket: string;
  region: string;
  secretId: string;
  secretKey: string;
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
      Protocol: 'https:',
      FollowRedirect: false,
      Timeout: 60_000,
    });
  }

  async #waitForUpload(key: string, signal: AbortSignal): Promise<void> {
    const pending = this.#pendingUploads.get(key);
    if (pending) await within(() => pending, signal);
  }

  async download(command: ComputeCommandV1, directory: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('EXECUTION_TIMEOUT');
    const stream = this.#client.getObjectStream({
      Bucket: this.#bucket,
      Region: this.#region,
      Key: command.input.key,
      IfMatch: command.input.etag,
    }) as Readable;
    await drainInput(stream, directory, command.attemptId, command.input.sizeBytes, signal);
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
    const body = readOutput(directory, attemptId);
    const abort = () => body.destroy();
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) throw new Error('UPLOAD_UNKNOWN');
      const request = this.#client.putObject({
        Bucket: this.#bucket,
        Region: this.#region,
        Key: key,
        Body: body,
        ContentLength: size,
        ContentType: 'video/mp4',
        'x-cos-meta-sha256': sha256,
        Headers: { 'x-cos-forbid-overwrite': 'true', 'Content-MD5': actual.md5 },
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

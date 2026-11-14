import { validateImage } from './media.ts';
import COS from 'cos-nodejs-sdk-v5';
import { createHash } from 'node:crypto';
import { imageOutputKey } from '@mio/compute-contracts';
import type { ComputeCommandV1 } from '@mio/compute-contracts';
import { Readable } from 'node:stream';
import type { ObjectInfo } from '../types.ts';
import { digestStream, drainInput, fileDigest, paths, readOutput } from './media.ts';

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

  async image(
    jobId: string,
    index: number,
    base64: string,
    format: string,
    fileId: string,
    stop?: AbortSignal,
  ) {
    if (!['png', 'jpeg', 'webp'].includes(format)) throw new Error('IMAGE_OUTPUT_INVALID');
    if (stop?.aborted) throw new Error('EXECUTION_TIMEOUT');
    const bytes = Buffer.from(base64, 'base64');
    const signature =
      format === 'png'
        ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
        : format === 'jpeg'
          ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!signature || bytes.length > 48 * 1024 * 1024) throw new Error('IMAGE_OUTPUT_INVALID');
    validateImage(bytes, format);
    if (stop?.aborted) throw new Error('EXECUTION_TIMEOUT');
    // Every materialization receives a fresh object identity. A timed-out or
    // otherwise ambiguous PUT may still complete; retrying its key would
    // reintroduce the overwrite race this path is designed to avoid.
    let key: string;
    try {
      key = imageOutputKey(jobId, index, fileId, format);
    } catch {
      throw new Error('IMAGE_OUTPUT_INVALID');
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const deadline = AbortSignal.timeout(180_000);
    const signal = stop ? AbortSignal.any([stop, deadline]) : deadline;
    // A stream body prevents the SDK's buffer retry loop from resending this
    // object key. Any caller-level retry allocates another UUID key instead.
    const request = this.#client.putObject({
      Bucket: this.#bucket,
      Region: this.#region,
      Key: key,
      Body: Readable.from(bytes),
      ContentLength: bytes.length,
      ContentType: `image/${format}`,
      'x-cos-meta-sha256': sha256,
      Headers: {
        'x-cos-forbid-overwrite': 'true',
        'Content-MD5': createHash('md5').update(bytes).digest('base64'),
      },
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
    const existing = await this.head(key, signal);
    if (
      !existing ||
      existing.sizeBytes !== bytes.length ||
      existing.sha256 !== sha256 ||
      !(await this.verify(key, bytes.length, sha256, signal))
    )
      throw new Error('IMAGE_OUTPUT_MISMATCH');
    return {
      key,
      sizeBytes: bytes.length,
      sha256,
      etag: existing.etag,
      contentType: `image/${format}`,
    };
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

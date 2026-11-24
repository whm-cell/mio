import { createHash } from 'node:crypto';
import COS from 'cos-nodejs-sdk-v5';
import { PassThrough, Readable } from 'node:stream';
import { HTTP_STATUS } from '@mio/foundation/http-status';
import { AssetError } from '../assets/contracts.ts';
import type { AssetConfig } from '../assets/config.ts';
import type { AssetObjectStore } from '../assets/contracts.ts';

/** Server-side credentials are scoped to this private bucket and are never returned to clients. */
export function createCosStorage(config: AssetConfig): AssetObjectStore {
  const { bucket: Bucket, region: Region } = config;
  const cos = new COS({
    SecretId: config.secretId,
    SecretKey: config.secretKey,
    ...(config.sessionToken ? { SecurityToken: config.sessionToken } : {}),
    Protocol: 'https:',
    Timeout: 60_000,
    FollowRedirect: false,
  });
  // This SDK appends the session token after signing without URL-encoding it.
  // Encode only that parameter; the signed query and the token used by SDK requests stay intact.
  const encodeUrlToken = (url: string) => {
    const token = config.sessionToken;
    if (!token) return url;
    const rawToken = `&x-cos-security-token=${token}`;
    if (!url.includes(rawToken)) throw new Error('COS_SIGNED_URL_TOKEN_MISSING');
    return url.replace(rawToken, () => `&x-cos-security-token=${encodeURIComponent(token)}`);
  };
  return {
    uploadUrl(Key, size) {
      return encodeUrlToken(
        cos.getObjectUrl({
          Bucket,
          Region,
          Key,
          Method: 'PUT',
          Expires: 300,
          Headers: { 'content-length': String(size) },
        }),
      );
    },
    downloadUrl(Key) {
      return encodeUrlToken(
        cos.getObjectUrl({
          Bucket,
          Region,
          Key,
          Method: 'GET',
          Expires: 300,
          Query: { 'response-content-disposition': 'attachment' },
        }),
      );
    },
    materialUrl(Key) {
      return encodeUrlToken(cos.getObjectUrl({ Bucket, Region, Key, Method: 'GET', Expires: 600 }));
    },
    async head(Key) {
      const object = await cos.headObject({ Bucket, Region, Key });
      const size = Number(object.headers?.['content-length']);
      if (!Number.isSafeInteger(size) || size < 0 || !object.ETag)
        throw new Error('COS_INVALID_HEAD');
      const sha256 = object.headers?.['x-cos-meta-sha256'];
      return { size, etag: object.ETag, ...(typeof sha256 === 'string' ? { sha256 } : {}) };
    },
    async readImage(Key, etag, size, signal) {
      signal.throwIfAborted();
      const stream = new PassThrough();
      // The SDK can report a late sender error after cancellation. Keep an error listener
      // on this one-shot stream until it is collected, including after our iterator exits.
      stream.on('error', () => {});
      // getObjectStream exposes the response body but not its status, and the SDK pipes
      // 412 bodies before reporting an error. Install the listener before the SDK pipes.
      stream.once('pipe', (sender: NodeJS.ReadableStream) => {
        sender.once('response', (response: { statusCode?: number }) => {
          if (response.statusCode !== 200)
            stream.destroy(
              Object.assign(new Error('ASSET_OBJECT_RESPONSE'), {
                statusCode: response.statusCode,
              }),
            );
        });
      });
      const completed = new Promise<void>((resolve, reject) => {
        cos.getObject({ Bucket, Region, Key, IfMatch: etag, Output: stream }, (error, result) => {
          if (error) {
            const failure = Object.assign(new Error('ASSET_OBJECT_RESPONSE'), {
              statusCode: error.statusCode,
            });
            if (!stream.destroyed) stream.destroy(failure);
            reject(failure);
          } else if (result.statusCode !== 200) {
            reject(
              Object.assign(new Error('ASSET_OBJECT_RESPONSE'), { statusCode: result.statusCode }),
            );
          } else resolve();
        });
      });
      // A stream failure can precede the SDK's completion callback.
      void completed.catch(() => {});
      let rejectAbort: ((error: Error) => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      });
      void aborted.catch(() => {});
      const abort = () => {
        stream.destroy(new Error('ASSET_READ_ABORTED'));
        rejectAbort?.(new Error('ASSET_READ_ABORTED'));
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of stream) {
          signal.throwIfAborted();
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          length += part.length;
          if (length > size) {
            const error = new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_SIZE_MISMATCH');
            stream.destroy(error);
            throw error;
          }
          chunks.push(part);
        }
        await Promise.race([completed, aborted]);
        if (length !== size) throw new AssetError(HTTP_STATUS.CONFLICT, 'ASSET_SIZE_MISMATCH');
        return Buffer.concat(chunks, length);
      } catch (error) {
        if (!stream.destroyed)
          stream.destroy(error instanceof Error ? error : new Error('ASSET_OBJECT_RESPONSE'));
        void completed.catch(() => {});
        throw error;
      } finally {
        signal.removeEventListener('abort', abort);
        stream.destroy();
      }
    },
    async putImage(Key, bytes, format, sha256, signal) {
      signal.throwIfAborted();
      const body = Buffer.from(bytes);
      if (
        !['png', 'jpeg', 'webp'].includes(format) ||
        createHash('sha256').update(body).digest('hex') !== sha256
      )
        throw new Error('IMAGE_OUTPUT_INVALID');
      const uploaded = await cos.putObject({
        Bucket,
        Region,
        Key,
        // The SDK cannot retry a consumed stream; reconcile this key before any new PUT.
        Body: Readable.from(body),
        ContentLength: body.length,
        ContentType: 'image/' + format,
        'x-cos-meta-sha256': sha256,
        Headers: {
          'x-cos-forbid-overwrite': 'true',
          'Content-MD5': createHash('md5').update(body).digest('base64'),
        },
      });
      signal.throwIfAborted();
      if (!uploaded.ETag) throw new Error('IMAGE_OUTPUT_MISMATCH');
      return {
        key: Key,
        sizeBytes: body.length,
        sha256,
        etag: uploaded.ETag,
        contentType: 'image/' + format,
      };
    },
    async putVideo(Key, stream, sizeBytes, sha256, signal) {
      signal.throwIfAborted();
      if (
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes < 1 ||
        sizeBytes > 1024 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(sha256)
      )
        throw new Error('VIDEO_OUTPUT_INVALID');
      const abort = () => stream.destroy(new Error('VIDEO_UPLOAD_ABORTED'));
      signal.addEventListener('abort', abort, { once: true });
      try {
        const uploaded = await cos.putObject({
          Bucket,
          Region,
          Key,
          Body: stream,
          ContentLength: sizeBytes,
          ContentType: 'video/mp4',
          ACL: 'private',
          'x-cos-meta-sha256': sha256,
          Headers: { 'x-cos-forbid-overwrite': 'true' },
        });
        signal.throwIfAborted();
        if (!uploaded.ETag) throw new Error('VIDEO_OUTPUT_MISMATCH');
        return { key: Key, sizeBytes, sha256, etag: uploaded.ETag, contentType: 'video/mp4' };
      } finally {
        signal.removeEventListener('abort', abort);
        stream.destroy();
      }
    },
    async copy(source, target, etag) {
      await cos.putObjectCopy({
        Bucket,
        Region,
        Key: target,
        CopySource: `${Bucket}.cos.${Region}.myqcloud.com/${encodeURIComponent(source)}`,
        CopySourceIfMatch: etag,
        MetadataDirective: 'Replaced',
        ContentType: 'application/octet-stream',
        Headers: { 'x-cos-forbid-overwrite': 'true' },
      });
    },
    async delete(Key) {
      await cos.deleteObject({ Bucket, Region, Key });
    },
  };
}

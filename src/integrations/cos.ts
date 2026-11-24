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
  const readObject = async (Key: string, etag: string, size: number, signal: AbortSignal) => {
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
  };
  const putObject = async (
    Key: string,
    bytes: Uint8Array,
    contentType: string,
    sha256: string,
    signal: AbortSignal,
    label: 'AUDIO' | 'IMAGE',
  ) => {
    signal.throwIfAborted();
    const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (createHash('sha256').update(body).digest('hex') !== sha256)
      throw new Error(label + '_OUTPUT_INVALID');
    const uploaded = await cos.putObject({
      Bucket,
      Region,
      Key,
      // The SDK cannot retry a consumed stream; reconcile this key before any new PUT.
      Body: Readable.from(body),
      ContentLength: body.length,
      ContentType: contentType,
      'x-cos-meta-sha256': sha256,
      ...(label === 'AUDIO' ? { ACL: 'private' } : {}),
      Headers: {
        'x-cos-forbid-overwrite': 'true',
        'Content-MD5': createHash('md5').update(body).digest('base64'),
      },
    });
    signal.throwIfAborted();
    if (!uploaded.ETag) throw new Error(label + '_OUTPUT_MISMATCH');
    return {
      key: Key,
      sizeBytes: body.length,
      sha256,
      etag: uploaded.ETag,
      contentType,
    };
  };
  const head: AssetObjectStore['head'] = async (Key) => {
    const object = await cos.headObject({ Bucket, Region, Key });
    const size = Number(object.headers?.['content-length']);
    if (!Number.isSafeInteger(size) || size < 0 || !object.ETag)
      throw new Error('COS_INVALID_HEAD');
    const sha256 = object.headers?.['x-cos-meta-sha256'];
    return { size, etag: object.ETag, ...(typeof sha256 === 'string' ? { sha256 } : {}) };
  };
  const inlinePlaybackUrl = (Key: string, contentType: string, expiresIn = 300) =>
    encodeUrlToken(
      cos.getObjectUrl({
        Bucket,
        Region,
        Key,
        Method: 'GET',
        Expires: expiresIn,
        Query: {
          'response-content-disposition': 'inline',
          'response-content-type': contentType,
        },
      }),
    );
  return {
    uploadUrl(Key, size, acl) {
      return encodeUrlToken(
        cos.getObjectUrl({
          Bucket,
          Region,
          Key,
          Method: 'PUT',
          Expires: 300,
          Headers: {
            'content-length': String(size),
            ...(acl ? { 'x-cos-acl': acl } : {}),
          },
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
    audioPlaybackUrl: inlinePlaybackUrl,
    hlsSegmentUrl(Key, expiresIn) {
      return inlinePlaybackUrl(Key, 'video/mp2t', expiresIn);
    },
    materialUrl(Key) {
      return encodeUrlToken(cos.getObjectUrl({ Bucket, Region, Key, Method: 'GET', Expires: 600 }));
    },
    head,
    readImage: readObject,
    readMedia: readObject,
    readAudio: readObject,
    putImage(Key, bytes, format, sha256, signal) {
      if (!['png', 'jpeg', 'webp'].includes(format)) throw new Error('IMAGE_OUTPUT_INVALID');
      return putObject(Key, bytes, 'image/' + format, sha256, signal, 'IMAGE');
    },
    putAudio(Key, bytes, format, sha256, signal) {
      if (!['mp3', 'wav', 'flac'].includes(format)) throw new Error('AUDIO_OUTPUT_INVALID');
      const contentType = format === 'mp3' ? 'audio/mpeg' : 'audio/' + format;
      return putObject(Key, bytes, contentType, sha256, signal, 'AUDIO');
    },
    async ensureAudioPrivate(Key, expected, signal) {
      signal.throwIfAborted();
      const current = await head(Key);
      if (
        current.size !== expected.sizeBytes ||
        current.etag !== expected.etag ||
        (expected.sha256 !== undefined && current.sha256 !== expected.sha256)
      )
        throw Object.assign(new Error('COS_AUDIO_OBJECT_CHANGED'), { statusCode: 412 });
      const scope = { Bucket, Region, Key };
      const permissions = await cos.getObjectAcl(scope);
      signal.throwIfAborted();
      if (permissions.ACL === 'private') return;
      await cos.putObjectAcl({ ...scope, ACL: 'private' });
      signal.throwIfAborted();
      if ((await cos.getObjectAcl(scope)).ACL !== 'private')
        throw new Error('COS_AUDIO_ACL_NOT_PRIVATE');
    },
    async copy(source, target, etag, acl) {
      await cos.putObjectCopy({
        Bucket,
        Region,
        Key: target,
        CopySource: `${Bucket}.cos.${Region}.myqcloud.com/${encodeURIComponent(source)}`,
        CopySourceIfMatch: etag,
        MetadataDirective: 'Replaced',
        ContentType: 'application/octet-stream',
        ...(acl ? { ACL: acl } : {}),
        Headers: { 'x-cos-forbid-overwrite': 'true' },
      });
    },
    async delete(Key) {
      await cos.deleteObject({ Bucket, Region, Key });
    },
  };
}
